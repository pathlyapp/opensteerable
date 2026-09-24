/**
 * 桌面宿主启动闭源 `steerable-egress-proxy` 二进制的启动器。
 *
 * 默认态势（3.1a，2026-09-08 起默认开）：sidecar 出网收敛到本机代理，
 * Seatbelt 列表只放行代理端口，真正的主机名单由代理进程持有（代理跑在
 * 沙箱外）。显式 `STEERABLE_EGRESS_PROXY=0` 退出，回退到 Seatbelt 允许
 * 列表从 provider baseUrl 派生、主机名退化为端口级的旧态势（sbpl 限制，
 * 见 docs/spec/safety.md）。
 *
 * 自动回退：检测到 ambient/系统代理（collectAmbientProxyEndpoints 非空）
 * 时不启动——代理解析 CONNECT 后直连目标，没有上游代理链，系统代理劫持
 * 类网络开了反而断网。回退路径就是旧的 Seatbelt 端口级派生（其允许列表
 * 会并入 ambient proxy 端点，见 boot.ts 的 W4-8 注释）。
 *
 * v1 限制（与框架 egress-proxy 的 v1 范围一致）：
 * - 只服务 CONNECT（HTTPS 隧道）。plain-http 端点（如本机 Ollama）不进
 *   代理，直接留在 Seatbelt 列表里。
 * - 代理直连目标主机，无上游代理链。
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { defaultSearchBaseUrl } from '../storage/web-search-settings.js';
import { resolveSidecarPython } from './supervisor.js';

type EgressProxyChild = ChildProcessByStdio<null, Readable, Readable>;

export interface EgressProxyPlan {
  command: string;
  args: string[];
  port: number;
  /** `127.0.0.1:<port>` — 同时是 Seatbelt 列表里的代理条目。 */
  proxyEndpoint: string;
  /** 给 sidecar 子进程环境的 HTTPS_PROXY 值。 */
  proxyUrl: string;
  /** 代理开启后的 Seatbelt 允许列表：代理端口 + plain-http 直连端点。 */
  sandboxAllowedHosts: string[];
  /** 交给代理 --allow 的主机名单（https 端点）。 */
  proxiedHosts: string[];
  /**
   * W2.2.2 凭证代理：存在时代理以注入模式运行，sidecar 的 provider
   * baseUrl 改写为 http://<host> 且不再下发 apiKey——真实密钥只存在于
   * 代理进程（经 env 传入，绝不出现在 argv / sidecar / 沙箱子进程）。
   */
  broker?: {
    host: string;
    secretEnv: string;
    /** 完整 Authorization 头值（"Bearer sk-..."）；仅驻留主进程内存。 */
    secretValue: string;
  };
  /**
   * 出网拓宽控制面（ask 链路）：代理暴露 loopback-only `POST /allow`
   * 端点（Bearer 认证），用户批准放行后 sidecar 把目标加进会话级白名单。
   * token 经 env 传入代理与 sidecar（argv 在 ps 可见）；沙箱子进程环境
   * 被白名单过滤，拿不到 token，无法自我拓宽。
   */
  control?: {
    tokenEnv: string;
    /** 仅驻留主进程内存；随 sidecar env 下发。 */
    tokenValue: string;
  };
}

/**
 * `baseUrl` 对应的允许条目形态：裸主机（框架侧隐含 443/80）或 `host:port`。
 *
 * `proxied` 为 false 表示 plain-http 端点——它们不走代理，留在沙箱 profile
 * 的直连列表里。解析不出主机名时返回 null。boot 时的名单派生与运行期的会话
 * 放行共用这一处，两者的条目语义不会分叉。
 */
export function egressAllowEntry(
  baseUrl: string | undefined,
): { entry: string; host: string; port: string; proxied: boolean } | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  return {
    entry: url.port ? `${url.hostname}:${url.port}` : url.hostname,
    host: url.hostname,
    port: url.port,
    proxied: url.protocol === 'https:',
  };
}

/**
 * 从 provider baseUrl 构建代理计划。https 端点进代理名单；http 端点留在
 * 直连列表。派生不出任何代理条目（无 https 端点且无 web 域名）时返回
 * null（调用方回退到旧的 Seatbelt 派生路径——空名单的代理没有意义，
 * 框架侧也会 fail loud）。
 */
export function resolveEgressProxyExecutable(): string | null {
  const fromEnv = process.env.STEERABLE_EGRESS_PROXY_BIN?.trim();
  return fromEnv && existsSync(fromEnv) ? fromEnv : null;
}

/** Walk up from a compiled file until the repo that owns the fetch script. */
export function findFrameworkRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'scripts', 'fetch_verified_artifacts.py'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function localBuiltEgress(repoRoot: string): string | null {
  const exe = process.platform === 'win32' ? 'steerable-egress-proxy.exe' : 'steerable-egress-proxy';
  for (const kind of ['release', 'debug']) {
    const candidate = path.join(repoRoot, 'packages', 'egress-proxy', 'rs', 'target', kind, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 下载缓存目录。egress 代理跑在沙箱外，所以这里绝不能落在 sidecar 沙箱
 * 可写的根（`~/.steerable`、storage path、scratch）之下——否则沙箱内
 * 代码可以替换这个二进制，下次启动即在沙箱外执行。
 */
export function egressBinaryCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'steerable', 'egress-proxy');
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'steerable', 'egress-proxy');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'steerable', 'egress-proxy');
}

function hostEgressTarget(): string | null {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'win32') return process.arch === 'x64' ? 'win32-x64' : null;
  if (process.platform === 'linux') return process.arch === 'x64' ? 'linux-x64' : null;
  return null;
}

function artifactVersion(repoRoot: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(path.join(repoRoot, 'rust-artifacts.lock.json'), 'utf8')) as {
      artifactVersion?: unknown;
      compatibility?: { egressCli?: unknown };
    };
    if (lock.compatibility?.egressCli !== 1) return null;
    return typeof lock.artifactVersion === 'string' ? lock.artifactVersion : null;
  } catch {
    try {
      const manifest = readFileSync(path.join(repoRoot, 'rust-artifacts.toml'), 'utf8');
      return manifest.match(/\[artifacts\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1] ?? null;
    } catch {
      // 读不到 artifact 版本就无法安全定位缓存文件。
      return null;
    }
  }
}

/**
 * 缓存命中且与同目录 `.sha256` 一致时返回路径。每次启动都重新计算哈希，
 * 被截断或替换的文件不会被执行。
 */
export function verifiedCachedEgress(cacheDir: string, version: string, target: string): string | null {
  const name = `steerable-egress-proxy-bin-${version}-${target}${target === 'win32-x64' ? '.exe' : ''}`;
  const binary = path.join(cacheDir, name);
  const digestFile = `${binary}.sha256`;
  if (!existsSync(binary) || !existsSync(digestFile)) return null;
  const expected = readFileSync(digestFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
  return expected && expected === actual ? binary : null;
}

const EGRESS_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Download the artifact-lock egress binary. Returns the printed path, or null. */
export function downloadPublishedEgress(repoRoot: string, cacheDir: string): Promise<string | null> {
  const script = path.join(repoRoot, 'scripts', 'fetch_verified_artifacts.py');
  // 与 sidecar 同一解释器：系统 python3 可能不带 SSL，下载不了 https。
  const python = resolveSidecarPython();
  return new Promise((resolve) => {
    const child = spawn(python, [script, 'egress', '--artifact-lock', '--target', 'host', '--out', cacheDir], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill(), EGRESS_DOWNLOAD_TIMEOUT_MS);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const printed = stdout.trim().split('\n').pop()?.trim();
      if (code === 0 && printed && existsSync(printed)) resolve(printed);
      else resolve(null);
    });
  });
}

/**
 * Env override, then a locally built private binary, then a cached copy
 * whose SHA-256 still matches, then the verified public Release asset.
 * A missing binary stays null so boot can fall back to port-level rules.
 */
export async function ensureEgressProxyExecutable(
  startDir: string,
  download: (repoRoot: string, cacheDir: string) => Promise<string | null> = downloadPublishedEgress,
  cacheDir: string = egressBinaryCacheDir(),
): Promise<string | null> {
  const fromEnv = resolveEgressProxyExecutable();
  if (fromEnv) return fromEnv;
  const repoRoot = findFrameworkRoot(startDir);
  if (!repoRoot) return null;
  const built = localBuiltEgress(repoRoot);
  if (built) return built;
  const version = artifactVersion(repoRoot);
  const target = hostEgressTarget();
  if (!version || !target) return null;
  const cached = verifiedCachedEgress(cacheDir, version, target);
  if (cached) return cached;
  const downloaded = await download(repoRoot, cacheDir);
  return downloaded && verifiedCachedEgress(cacheDir, version, target);
}

export function buildEgressProxyPlan(options: {
  executable: string;
  port: number;
  providerBaseUrl?: string;
  /** 存在且 provider 为 https 时启用凭证代理模式（W2.2.2）。 */
  providerApiKey?: string;
  /**
   * 3.1b/3.1d：并入代理 CONNECT 白名单的 web 出网主机（由
   * deriveWebEgressHosts 推导，与 sidecar 应用层
   * STEERABLE_WEB_ALLOWED_DOMAINS 同源）。注意框架代理是精确主机匹配
   * ——应用层域名条目覆盖的子域不在其列，抓取子域会被代理 403（错误
   * 信息已带提示）。
   */
  webAllowedHosts?: string[];
}): EgressProxyPlan | null {
  const { executable, port, providerBaseUrl, providerApiKey } = options;
  const proxiedHosts: string[] = [];
  const directHosts: string[] = [];
  let brokerHost: string | null = null;
  // unparseable baseUrl → no derivation, same as the legacy path
  const provider = egressAllowEntry(providerBaseUrl);
  if (provider) {
    if (provider.proxied) {
      proxiedHosts.push(provider.entry);
      // 凭证注入按裸主机匹配（转发目标是 443）；显式端口端点不进
      // broker——注入规则与 CONNECT 名单语义保持各自单一。
      if (!provider.port && providerApiKey) brokerHost = provider.host;
    } else {
      directHosts.push(provider.entry);
    }
  }
  for (const host of options.webAllowedHosts ?? []) {
    if (!proxiedHosts.includes(host)) proxiedHosts.push(host);
  }
  if (proxiedHosts.length === 0) return null;
  const proxyEndpoint = `127.0.0.1:${port}`;
  const broker = brokerHost
    ? {
        host: brokerHost,
        secretEnv: 'STEERABLE_EGRESS_SECRET',
        secretValue: `Bearer ${providerApiKey}`,
      }
    : undefined;
  const control = {
    tokenEnv: 'STEERABLE_EGRESS_CONTROL_TOKEN',
    tokenValue: randomBytes(24).toString('base64url'),
  };
  return {
    command: executable,
    args: [
      '--bind',
      proxyEndpoint,
      ...proxiedHosts.flatMap((host) => ['--allow', host]),
      // 控制端口 0 = ephemeral；实际端口由代理 stdout 的
      // EGRESS_CONTROL_PORT= 行读回（startEgressProxy 解析）。
      '--control-port',
      '0',
      '--control-token-env',
      control.tokenEnv,
      ...(broker
        ? [
            '--inject-host',
            broker.host,
            '--inject-secret-env',
            broker.secretEnv,
          ]
        : []),
    ],
    port,
    proxyEndpoint,
    proxyUrl: `http://${proxyEndpoint}`,
    sandboxAllowedHosts: [proxyEndpoint, ...directHosts],
    proxiedHosts,
    broker,
    control,
  };
}

/**
 * 3.1b/3.1d：推导应并入代理 CONNECT 白名单的 web 出网主机。
 *
 * 数据源与 sidecar 应用层完全一致（同源）：`STEERABLE_WEB_ALLOWED_DOMAINS`
 * 进程环境（sidecar 继承同一 env 做 domain_policy_error），规范化也与
 * WebToolsConfig 相同（小写、去前导点）。web_search 在 sidecar 进程内
 * 执行时（搜索 key 存在，或 provider=ddg），其固定 API 端点一并加入——否则
 * CONNECT api.tavily.com:443 / html.duckduckgo.com:443 会被代理 403。
 * provider=host 的托管搜索在 Electron 主进程执行，不占 sidecar 出网。
 *
 * 应用层空名单的语义是"任意公网"，代理白名单不能是开放的，所以空名单
 * 不并入任何条目——此时 web_fetch 在 confined 下对名单外目标被代理
 * 403，sidecar 侧错误信息已带指向本名单的提示。
 */
export function deriveWebEgressHosts(options: {
  /** webToolsEnabled() 的结果。 */
  webTools: boolean;
  /** sidecarWebSearchEnv(...) 的结果（判断 sidecar 是否进程内执行搜索）。 */
  searchEnv: Record<string, string>;
  /** 读取 STEERABLE_WEB_* 的环境（通常 process.env）。 */
  env: NodeJS.ProcessEnv;
}): string[] {
  if (!options.webTools) return [];
  const { env, searchEnv } = options;
  const hosts: string[] = [];
  for (const entry of (env.STEERABLE_WEB_ALLOWED_DOMAINS ?? '').split(',')) {
    const domain = entry.trim().toLowerCase().replace(/^\.+/, '');
    if (domain) hosts.push(domain);
  }
  if (searchEnv.STEERABLE_WEB_SEARCH_API_KEY || searchEnv.STEERABLE_WEB_SEARCH_PROVIDER === 'ddg') {
    // 与 WebToolsConfig.resolve 的 search_base_url 推导保持一致：显式
    // STEERABLE_WEB_SEARCH_BASE_URL 优先，否则按 provider 取默认端点。
    // ddg 无钥也在 sidecar 进程内执行，必须放行 html.duckduckgo.com。
    const explicit = (env.STEERABLE_WEB_SEARCH_BASE_URL ?? '').trim();
    const provider = (
      searchEnv.STEERABLE_WEB_SEARCH_PROVIDER
      || env.STEERABLE_WEB_SEARCH_PROVIDER
      || ''
    ).trim();
    const base = explicit || defaultSearchBaseUrl(provider);
    try {
      const url = new URL(base);
      // 显式端口保留（裸主机只放行 443/80，带端口的端点要精确条目）。
      const entry = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      if (entry) hosts.push(entry);
    } catch {
      /* 畸形 base url：sidecar 侧 resolve 同样失败，web_search 不会注册 */
    }
  }
  // 框架代理对畸形 --allow 条目 fail loud（拒启 → 整体回退端口级）。在
  // 这里过滤保住 LLM 通路的按主机管控；被丢的条目本就无法匹配真实主机，
  // 应用层名单语义不变。形态与框架 parse_allow_entry 的字母表一致
  // （host 或 host:port；域名已在上面小写化）。
  return hosts.filter((host) => /^[a-z0-9._-]+(:[0-9]{1,5})?$/.test(host));
}

/**
 * 当前活跃的凭证代理（broker 模式开启时非空）。router 据此改写
 * chat.stream 的 baseUrl/apiKey。模块级状态：代理由 main.ts 拥有，
 * 流参数构造在 router.ts，二者经此 getter 会面。
 */
let activeBroker: { host: string; proxyUrl: string } | null = null;

export function getActiveEgressBroker(): { host: string; proxyUrl: string } | null {
  return activeBroker;
}

/**
 * 出网管控态势的持久披露（W-egress-posture）。boot 的每次决策都记录：
 * per-host 代理生效 / 退回端口级（含原因）/ 用户显式关闭。设置页
 * 「安全」区经 sandbox-posture 端点读取——退回不再是只有主进程日志
 * 可见的静默事件。
 */
export interface EgressPosture {
  mode: 'per-host-proxy' | 'port-only-fallback' | 'disabled';
  /** 退回/关闭的原因（人可读，一行）。per-host-proxy 时为 null。 */
  reason: string | null;
}

let egressPosture: EgressPosture | null = null;

export function recordEgressPosture(posture: EgressPosture): void {
  egressPosture = posture;
}

/**
 * 起不起按主机代理——在派生名单、起进程之前就能定的那部分判断。
 *
 * 两种不起：显式关闭，以及检测到 ambient/系统代理（本代理解析 CONNECT 后
 * 直连目标，没有上游代理链，在系统代理劫持的网络里开了反而断网）。两者的
 * `reason` 是设置页「安全」区直接渲染的文案，所以在这里定形并被测试锁住。
 *
 * 派生不出代理条目、或进程启动失败，要等到那两步才知道，仍由调用方处理。
 */
export function decideEgressProxy(options: {
  env: NodeJS.ProcessEnv;
  ambientProxies: string[];
}): { start: true } | { start: false; posture: EgressPosture } {
  if (options.env.STEERABLE_EGRESS_PROXY === '0') {
    return {
      start: false,
      posture: { mode: 'disabled', reason: '已通过 STEERABLE_EGRESS_PROXY=0 关闭' },
    };
  }
  if (options.ambientProxies.length > 0) {
    return {
      start: false,
      posture: {
        mode: 'port-only-fallback',
        reason: `检测到系统/环境代理（${options.ambientProxies.join(', ')}），按主机管控已退回端口级`,
      },
    };
  }
  return { start: true };
}

export function getEgressPosture(): EgressPosture | null {
  return egressPosture;
}

/**
 * 当前活跃代理的 `127.0.0.1:<port>` 端点（无论是否 broker 模式）。P3.2
 * shell-via-proxy：chat 的 execSandbox 在代理活跃时把 allowedHosts 收敛到
 * 这个 localhost 端点，Seatbelt 据此判 enforcement="full"，requireFull
 * 才能缺省开。代理未运行时为 null（回退到 baseUrl 派生的 partial 路径）。
 */
let activeProxyEndpoint: string | null = null;

export function getActiveEgressProxyEndpoint(): string | null {
  return activeProxyEndpoint;
}

/**
 * 活跃代理的控制端点（loopback-only `POST /allow` + Bearer）。token 只驻留
 * 主进程内存，与下发给 sidecar 的是同一个值。
 */
let activeControl: { port: number; token: string; log: (line: string) => void } | null = null;

/**
 * 把 `baseUrl` 的主机加进运行中代理的会话白名单。
 *
 * LLM 端点不是一条策略判断：白名单本来就是从用户正在编辑的那一项设置派生
 * 出来的，所以它必须跟着那项设置走，而不是停在 boot 时的取值上。否则用户
 * 换网关后整个会话（连聊天）都被自己的代理 403，只有重启才好——测试按钮
 * 更是必然被拒，因为它验的正是尚未保存的地址。
 *
 * 只有人能到达这里：调用点是设置页的 models.list 与保存路由，模型的工具面
 * 没有这两者，`web_fetch` 的 SSRF 预检也拒绝回环地址。web 那半边的名单不受
 * 影响，被注入的模型照样连不上名单外的主机。
 *
 * 放行是会话域的（代理进程退出即失效），条目形态与 `buildEgressProxyPlan`
 * 的派生一致，两处语义不会分叉。
 *
 * @returns 已放行为 true；无可放行之处为 false——代理没在跑、URL 解析不了，
 * 或端点是 plain-http（那类端点不进代理，由 spawn 时的沙箱 profile 钉死，
 * 运行期改不了，仍需重启）。
 */
export async function allowEgressForBaseUrl(baseUrl: string | undefined): Promise<boolean> {
  const control = activeControl;
  if (!control) return false;
  const target = egressAllowEntry(baseUrl);
  if (!target || !target.proxied) return false;
  const entry = target.entry;
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/allow`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${control.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ host: entry }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      control.log(`control endpoint refused ${entry}: ${response.status}`);
      return false;
    }
    control.log(`session allow added for ${entry}`);
    return true;
  } catch (err) {
    control.log(
      `control endpoint unreachable for ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export interface EgressProxyHandle {
  plan: EgressProxyPlan;
  /** 控制端点实际端口（代理 stdout 的 EGRESS_CONTROL_PORT= 行读回）。 */
  controlPort: number | null;
  stop: () => void;
}

/**
 * 启动代理并等它就绪后再放行 sidecar 启动——sidecar 的 LLM 路径要经过它，
 * 代理未就绪就启动 sidecar 等于把首轮对话送进必失败的黑洞。
 *
 * 就绪判定用 TCP 连接探针而不是解析 stdout：框架 v1 的就绪日志走
 * logging（默认不输出），把宿主耦合到日志文案上太脆。端口是我们选的，
 * connect 成功 = 已在监听。
 */
export async function startEgressProxy(
  plan: EgressProxyPlan,
  onLog: (line: string) => void,
  readyTimeoutMs = 10_000,
): Promise<EgressProxyHandle> {
  const child: EgressProxyChild = spawn(plan.command, plan.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // 凭证与控制 token 经 env 传入代理进程——argv 在 ps 里可见，env 不入
    // 命令行。
    env: plan.broker
      ? {
          ...process.env,
          [plan.broker.secretEnv]: plan.broker.secretValue,
          ...(plan.control ? { [plan.control.tokenEnv]: plan.control.tokenValue } : {}),
        }
      : plan.control
        ? { ...process.env, [plan.control.tokenEnv]: plan.control.tokenValue }
        : process.env,
  });
  // 控制端口是 ephemeral 的：代理由 stdout 报回实际端口。就绪条件在
  // TCP 探针之外加上这一行（控制面开启时），否则 sidecar 拿到的
  // STEERABLE_EGRESS_CONTROL_PORT 可能是尚未监听的端口。
  let controlPort: number | null = null;
  let resolveControlLine: () => void = () => {};
  const controlLineSeen = new Promise<void>((resolve) => {
    resolveControlLine = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      const match = /^EGRESS_CONTROL_PORT=(\d+)$/.exec(line.trim());
      if (match) {
        controlPort = Number(match[1]);
        resolveControlLine();
      }
      onLog(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) onLog(line);
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`egress proxy did not listen on ${plan.proxyEndpoint} within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    child.on('exit', (code) => fail(new Error(`egress proxy exited before ready (code ${code})`)));
    const probe = () => {
      if (settled) return;
      const socket = connect(plan.port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        succeed();
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(probe, 100);
      });
    };
    probe();
  });
  try {
    await ready;
    if (plan.control) {
      await Promise.race([
        controlLineSeen,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('egress proxy did not report its control port')), readyTimeoutMs),
        ),
      ]);
    }
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  activeBroker = plan.broker
    ? { host: plan.broker.host, proxyUrl: plan.proxyUrl }
    : null;
  activeProxyEndpoint = plan.proxyEndpoint;
  activeControl =
    plan.control && controlPort
      ? { port: controlPort, token: plan.control.tokenValue, log: onLog }
      : null;
  let stopping = false;
  child.on('exit', (code, signal) => {
    activeBroker = null;
    activeProxyEndpoint = null;
    activeControl = null;
    if (!stopping) {
      onLog(`egress proxy exited unexpectedly (code ${code}, signal ${signal})`);
    }
  });
  return {
    plan,
    controlPort,
    stop: () => {
      stopping = true;
      activeBroker = null;
      activeProxyEndpoint = null;
      activeControl = null;
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

/** 让系统分配一个空闲回环端口（listen(0) 后立即释放，供代理绑定）。 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
