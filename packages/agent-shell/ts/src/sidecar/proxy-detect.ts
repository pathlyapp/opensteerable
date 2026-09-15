/**
 * W4-8: ambient proxy detection for the sidecar sandbox egress allow-list.
 *
 * The sidecar's LLM clients (httpx, `trust_env=True`) honor ambient proxy
 * configuration: `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` env vars, and —
 * when no env proxy is set — the macOS System Configuration proxy via
 * `urllib.request.getproxies()`. A configured proxy is therefore an
 * *effective egress point* of the sidecar: if the Seatbelt allow-list names
 * only the provider endpoint, every LLM call is denied at connect time for
 * proxy users (EPERM → httpx "All connection attempts failed").
 *
 * The allow-list deliberately takes the union of env and system proxies
 * rather than replicating `getproxies()` precedence (env shadows system):
 * both endpoints are operator-configured, and the bypass-list semantics
 * (NO_PROXY / ExceptionsList) are not faithfully surfaced by
 * `getproxies()` on macOS, so a proxied daemon and a direct localhost
 * target can both be in play within one boot.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

/** Default ports per proxy scheme when the URL omits one. */
const SCHEME_DEFAULT_PORT: Record<string, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
  socks4: 1080,
};

/**
 * Normalize a proxy env value (`http://host:port`, `host:port`, `socks5://…`)
 * to the `host[:port]` form the sandbox profile expects. Returns null for
 * unparseable values — a malformed proxy var must not fail profile
 * generation (the sidecar would fall back unsandboxed).
 */
export function endpointFromProxyUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const withScheme = text.includes('://') ? text : `http://${text}`;
    const url = new URL(withScheme);
    const host = url.hostname;
    if (!host) return null;
    if (url.port) return `${host}:${url.port}`;
    const scheme = url.protocol.replace(':', '');
    const fallback = SCHEME_DEFAULT_PORT[scheme];
    return fallback ? `${host}:${fallback}` : host;
  } catch {
    return null;
  }
}

/** Proxy endpoints declared through the process environment. */
export function envProxyEndpoints(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const name of PROXY_ENV_VARS) {
    const value = env[name];
    if (!value) continue;
    const endpoint = endpointFromProxyUrl(value);
    if (endpoint) out.add(endpoint);
  }
  return [...out];
}

/**
 * Parse `scutil --proxy` output into `host:port` endpoints. Only enabled
 * protocols yield an entry; the ExceptionsList is intentionally ignored
 * (see module docstring — bypass state is not reliably knowable here).
 */
export function parseScutilProxyOutput(output: string): string[] {
  const field = (key: string): string | undefined => {
    const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, 'm'));
    return match?.[1];
  };
  const out = new Set<string>();
  const protocols: Array<{ enable: string; host: string; port: string; fallback: number }> = [
    { enable: 'HTTPEnable', host: 'HTTPProxy', port: 'HTTPPort', fallback: 80 },
    { enable: 'HTTPSEnable', host: 'HTTPSProxy', port: 'HTTPSPort', fallback: 443 },
    { enable: 'SOCKSEnable', host: 'SOCKSProxy', port: 'SOCKSPort', fallback: 1080 },
  ];
  for (const p of protocols) {
    if (field(p.enable) !== '1') continue;
    const host = field(p.host);
    if (!host) continue;
    out.add(`${host}:${field(p.port) ?? p.fallback}`);
  }
  return [...out];
}

/**
 * macOS System Configuration proxy endpoints. Empty off-darwin (the
 * Seatbelt sandbox only exists on macOS, so the allow-list only matters
 * there) and on any scutil failure — detection must never break boot.
 */
export async function detectSystemProxyEndpoints(
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], {
      timeout: 5_000,
    });
    return parseScutilProxyOutput(stdout);
  } catch {
    return [];
  }
}

/** All ambient proxy endpoints the sidecar may legitimately egress to. */
export async function collectAmbientProxyEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const envEndpoints = envProxyEndpoints(env);
  const systemEndpoints = await detectSystemProxyEndpoints();
  return [...new Set([...envEndpoints, ...systemEndpoints])];
}
