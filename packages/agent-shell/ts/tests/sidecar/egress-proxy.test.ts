import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowEgressForBaseUrl,
  buildEgressProxyPlan,
  decideEgressProxy,
  deriveWebEgressHosts,
  egressAllowEntry,
  egressBinaryCacheDir,
  ensureEgressProxyExecutable,
  resolveEgressProxyExecutable,
} from '../../src/sidecar/egress-proxy';

describe('buildEgressProxyPlan (W1.3.3)', () => {
  it('pins the Seatbelt list to the proxy port and allows the https provider host', () => {
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
    });
    expect(plan).not.toBeNull();
    expect(plan!.args).toEqual([
      '--bind',
      '127.0.0.1:18899',
      '--allow',
      'api.deepseek.com',
      '--control-port',
      '0',
      '--control-token-env',
      'STEERABLE_EGRESS_CONTROL_TOKEN',
    ]);
    expect(plan!.sandboxAllowedHosts).toEqual(['127.0.0.1:18899']);
    expect(plan!.proxyUrl).toBe('http://127.0.0.1:18899');
    expect(plan!.proxiedHosts).toEqual(['api.deepseek.com']);
  });

  it('carries a control plane whose token never appears in argv (W-egress-ask)', () => {
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
    });
    expect(plan!.control).toBeDefined();
    expect(plan!.control!.tokenEnv).toBe('STEERABLE_EGRESS_CONTROL_TOKEN');
    // 24 random bytes, base64url — unguessable by sandboxed children.
    expect(plan!.control!.tokenValue).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The token value must never appear in argv (visible in ps) — only the
    // env var name does, mirroring the broker secret's handling.
    expect(plan!.args.join(' ')).not.toContain(plan!.control!.tokenValue);
    // Two plans never share a token.
    const other = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
    });
    expect(other!.control!.tokenValue).not.toBe(plan!.control!.tokenValue);
  });

  it('keeps plain-http providers (local Ollama) direct alongside the proxy', () => {
    // A https provider would go through the proxy; an http one stays in the
    // Seatbelt list — CONNECT tunneling serves HTTPS only (framework v1).
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'http://127.0.0.1:11434',
    });
    // No https endpoint → nothing for the proxy to allow → no plan.
    expect(plan).toBeNull();
  });

  it('preserves explicit ports on the provider host', () => {
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://gateway.internal:8443/v1',
    });
    expect(plan!.proxiedHosts).toEqual(['gateway.internal:8443']);
    expect(plan!.args).toContain('gateway.internal:8443');
  });

  it('returns null when the baseUrl is missing or unparseable', () => {
    expect(
      buildEgressProxyPlan({ executable: '/usr/bin/steerable-egress-proxy', port: 1 }),
    ).toBeNull();
    expect(
      buildEgressProxyPlan({
        executable: '/usr/bin/steerable-egress-proxy',
        port: 1,
        providerBaseUrl: 'not a url',
      }),
    ).toBeNull();
  });

  it('adds inject args and a broker plan when an apiKey is present (W2.2.2)', () => {
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
      providerApiKey: 'sk-real-key',
    });
    expect(plan!.broker).toEqual({
      host: 'api.deepseek.com',
      secretEnv: 'STEERABLE_EGRESS_SECRET',
      secretValue: 'Bearer sk-real-key',
    });
    expect(plan!.args).toEqual([
      '--bind',
      '127.0.0.1:18899',
      '--allow',
      'api.deepseek.com',
      '--control-port',
      '0',
      '--control-token-env',
      'STEERABLE_EGRESS_CONTROL_TOKEN',
      '--inject-host',
      'api.deepseek.com',
      '--inject-secret-env',
      'STEERABLE_EGRESS_SECRET',
    ]);
    // The secret value must never appear in argv (visible in ps).
    expect(plan!.args.join(' ')).not.toContain('sk-real-key');
  });

  it('skips the broker when no apiKey or the endpoint has an explicit port', () => {
    const noKey = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
    });
    expect(noKey!.broker).toBeUndefined();
    expect(noKey!.args).not.toContain('--inject-host');
    const explicitPort = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://gateway.internal:8443/v1',
      providerApiKey: 'sk-x',
    });
    expect(explicitPort!.broker).toBeUndefined();
  });

  it('merges web allowed hosts into the proxy allow-list, deduped (3.1b/3.1d)', () => {
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'https://api.deepseek.com',
      webAllowedHosts: ['example.com', 'api.deepseek.com', 'api.tavily.com'],
    });
    expect(plan!.proxiedHosts).toEqual([
      'api.deepseek.com',
      'example.com',
      'api.tavily.com',
    ]);
    expect(plan!.args).toEqual([
      '--bind',
      '127.0.0.1:18899',
      '--allow',
      'api.deepseek.com',
      '--allow',
      'example.com',
      '--allow',
      'api.tavily.com',
      '--control-port',
      '0',
      '--control-token-env',
      'STEERABLE_EGRESS_CONTROL_TOKEN',
    ]);
    // Web hosts stay out of the Seatbelt list: their traffic must go
    // THROUGH the proxy, never direct.
    expect(plan!.sandboxAllowedHosts).toEqual(['127.0.0.1:18899']);
  });

  it('still builds a plan for an http-only provider when web hosts exist', () => {
    // Local Ollama stays direct; the proxy then carries the web list only.
    const plan = buildEgressProxyPlan({
      executable: '/usr/bin/steerable-egress-proxy',
      port: 18899,
      providerBaseUrl: 'http://127.0.0.1:11434',
      webAllowedHosts: ['example.com'],
    });
    expect(plan).not.toBeNull();
    expect(plan!.proxiedHosts).toEqual(['example.com']);
    expect(plan!.sandboxAllowedHosts).toEqual(['127.0.0.1:18899', '127.0.0.1:11434']);
  });
});

describe('egressAllowEntry', () => {
  it('derives the same entry shape the boot-time allow-list uses', () => {
    // Bare host for the default port (the framework implies 443/80), and an
    // explicit port kept verbatim — a bare entry would not cover it.
    expect(egressAllowEntry('https://api.deepseek.com')).toEqual({
      entry: 'api.deepseek.com',
      host: 'api.deepseek.com',
      port: '',
      proxied: true,
    });
    expect(egressAllowEntry('https://maas-openapi.wanjiedata.com/api/v1')?.entry).toBe(
      'maas-openapi.wanjiedata.com',
    );
    expect(egressAllowEntry('https://gateway.internal:8443/v1')?.entry).toBe(
      'gateway.internal:8443',
    );
  });

  it('marks plain-http endpoints unproxied and refuses what has no host', () => {
    // Local Ollama is pinned in the sandbox profile, not in the proxy.
    expect(egressAllowEntry('http://127.0.0.1:11434')).toMatchObject({
      entry: '127.0.0.1:11434',
      proxied: false,
    });
    expect(egressAllowEntry('not a url')).toBeNull();
    expect(egressAllowEntry('')).toBeNull();
    expect(egressAllowEntry(undefined)).toBeNull();
  });
});

describe('decideEgressProxy', () => {
  it('starts the proxy when nothing opts out', () => {
    expect(decideEgressProxy({ env: {}, ambientProxies: [] })).toEqual({ start: true });
  });

  it('stays off when explicitly disabled, and says so where the user reads it', () => {
    // The reason renders verbatim in the settings "security" section, so a
    // deliberate opt-out must never look like a silent downgrade.
    expect(
      decideEgressProxy({ env: { STEERABLE_EGRESS_PROXY: '0' }, ambientProxies: [] }),
    ).toEqual({
      start: false,
      posture: { mode: 'disabled', reason: '已通过 STEERABLE_EGRESS_PROXY=0 关闭' },
    });
    // Off wins over a detected ambient proxy: the explicit switch is not a
    // fallback and must not be reported as one.
    expect(
      decideEgressProxy({
        env: { STEERABLE_EGRESS_PROXY: '0' },
        ambientProxies: ['127.0.0.1:7890'],
      }).posture,
    ).toEqual({ mode: 'disabled', reason: '已通过 STEERABLE_EGRESS_PROXY=0 关闭' });
    // Only '0' opts out — any other value keeps the proxy on.
    expect(decideEgressProxy({ env: { STEERABLE_EGRESS_PROXY: '' }, ambientProxies: [] })).toEqual(
      { start: true },
    );
  });

  it('falls back to port level under an ambient proxy, naming the endpoints found', () => {
    // This proxy dials targets directly with no upstream chain, so running it
    // behind a capturing system proxy would break egress instead of confining
    // it. The endpoints go in the reason because they are the whole diagnosis.
    expect(
      decideEgressProxy({ env: {}, ambientProxies: ['127.0.0.1:7890', '127.0.0.1:7891'] }),
    ).toEqual({
      start: false,
      posture: {
        mode: 'port-only-fallback',
        reason: '检测到系统/环境代理（127.0.0.1:7890, 127.0.0.1:7891），按主机管控已退回端口级',
      },
    });
  });
});

describe('allowEgressForBaseUrl', () => {
  it('reports nothing widened while no proxy is running', async () => {
    // The disabled and fallback postures both land here: no control endpoint
    // means no per-host confinement to widen, which callers treat as
    // "nothing to do" rather than as a failure.
    expect(await allowEgressForBaseUrl('https://maas-openapi.wanjiedata.com/api/v1')).toBe(
      false,
    );
  });
});

describe('deriveWebEgressHosts (3.1b/3.1d)', () => {
  it('returns nothing when the web tools are off', () => {
    expect(
      deriveWebEgressHosts({
        webTools: false,
        searchEnv: { STEERABLE_WEB_SEARCH_API_KEY: 'tvly-x' },
        env: { STEERABLE_WEB_ALLOWED_DOMAINS: 'example.com' },
      }),
    ).toEqual([]);
  });

  it('normalizes the allowed domains like WebToolsConfig (lowercase, strip leading dot)', () => {
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: {},
        env: { STEERABLE_WEB_ALLOWED_DOMAINS: ' Example.COM , .docs.example.org ,' },
      }),
    ).toEqual(['example.com', 'docs.example.org']);
  });

  it('adds the search API endpoint only when the sidecar executes search in-process', () => {
    // Tavily key present → sidecar-side Tavily/Brave → endpoint proxied.
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: { STEERABLE_WEB_SEARCH_API_KEY: 'tvly-x' },
        env: {},
      }),
    ).toEqual(['api.tavily.com']);
    // provider=host without a key → hosted search runs in the Electron
    // main process, no sidecar egress to allow.
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: { STEERABLE_WEB_SEARCH_PROVIDER: 'host' },
        env: {},
      }),
    ).toEqual([]);
    // Brave provider default base URL.
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: { STEERABLE_WEB_SEARCH_API_KEY: 'brave-x' },
        env: { STEERABLE_WEB_SEARCH_PROVIDER: 'brave' },
      }),
    ).toEqual(['api.search.brave.com']);
    // Explicit base URL wins (self-hosted search proxy); an explicit port
    // is preserved — a bare host entry only allows 443/80.
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: { STEERABLE_WEB_SEARCH_API_KEY: 'k' },
        env: { STEERABLE_WEB_SEARCH_BASE_URL: 'https://search.internal:8443' },
      }),
    ).toEqual(['search.internal:8443']);
    // ddg is in-process without a key — the lite HTML origin still needs CONNECT.
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: { STEERABLE_WEB_SEARCH_PROVIDER: 'ddg' },
        env: {},
      }),
    ).toEqual(['html.duckduckgo.com']);
  });

  it('drops malformed entries so the proxy (fail-loud on bad --allow) still starts', () => {
    expect(
      deriveWebEgressHosts({
        webTools: true,
        searchEnv: {},
        env: { STEERABLE_WEB_ALLOWED_DOMAINS: 'exa mple.com,ok.com,"evil.com"' },
      }),
    ).toEqual(['ok.com']);
  });
});

describe('ensureEgressProxyExecutable', () => {
  function frameworkFixture(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'egress-root-'));
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'fetch_verified_artifacts.py'), '# fixture\n');
    return root;
  }

  it('uses STEERABLE_EGRESS_PROXY_BIN when that file exists', async () => {
    const root = frameworkFixture();
    const bin = path.join(root, 'from-env');
    writeFileSync(bin, '');
    const previous = process.env.STEERABLE_EGRESS_PROXY_BIN;
    process.env.STEERABLE_EGRESS_PROXY_BIN = bin;
    try {
      const download = async () => {
        throw new Error('download should not run');
      };
      await expect(ensureEgressProxyExecutable(root, download)).resolves.toBe(bin);
      expect(resolveEgressProxyExecutable()).toBe(bin);
    } finally {
      if (previous === undefined) delete process.env.STEERABLE_EGRESS_PROXY_BIN;
      else process.env.STEERABLE_EGRESS_PROXY_BIN = previous;
    }
  });

  it('prefers a locally built binary over the public download', async () => {
    const root = frameworkFixture();
    const exe = process.platform === 'win32' ? 'steerable-egress-proxy.exe' : 'steerable-egress-proxy';
    const built = path.join(root, 'packages', 'egress-proxy', 'rs', 'target', 'debug', exe);
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, '');
    const previous = process.env.STEERABLE_EGRESS_PROXY_BIN;
    delete process.env.STEERABLE_EGRESS_PROXY_BIN;
    try {
      const download = async () => {
        throw new Error('download should not run');
      };
      await expect(ensureEgressProxyExecutable(root, download)).resolves.toBe(built);
    } finally {
      if (previous === undefined) delete process.env.STEERABLE_EGRESS_PROXY_BIN;
      else process.env.STEERABLE_EGRESS_PROXY_BIN = previous;
    }
  });

  const target =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : process.platform === 'win32'
        ? 'win32-x64'
        : 'linux-x64';
  const cachedName = `steerable-egress-proxy-bin-9.9.9-${target}${target === 'win32-x64' ? '.exe' : ''}`;

  function writeCached(dir: string, bytes: string, digestOf = bytes): string {
    mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, cachedName);
    writeFileSync(binary, bytes);
    const digest = createHash('sha256').update(digestOf).digest('hex');
    writeFileSync(`${binary}.sha256`, `${digest}  ${cachedName}\n`);
    return binary;
  }

  async function withoutEnvBin<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.STEERABLE_EGRESS_PROXY_BIN;
    delete process.env.STEERABLE_EGRESS_PROXY_BIN;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.STEERABLE_EGRESS_PROXY_BIN;
      else process.env.STEERABLE_EGRESS_PROXY_BIN = previous;
    }
  }

  function versionedFixture(): { root: string; cacheDir: string } {
    const root = frameworkFixture();
    writeFileSync(
      path.join(root, 'rust-artifacts.lock.json'),
      JSON.stringify({ artifactVersion: '9.9.9', compatibility: { egressCli: 1 } }),
    );
    return { root, cacheDir: path.join(root, 'cache') };
  }

  it('reuses a cached binary whose digest matches without downloading', async () => {
    const { root, cacheDir } = versionedFixture();
    const binary = writeCached(cacheDir, 'proxy-bytes');
    const download = async () => {
      throw new Error('download should not run');
    };
    await withoutEnvBin(async () => {
      await expect(ensureEgressProxyExecutable(root, download, cacheDir)).resolves.toBe(binary);
    });
  });

  it('refuses a cached binary whose bytes no longer match the digest', async () => {
    const { root, cacheDir } = versionedFixture();
    writeCached(cacheDir, 'tampered', 'proxy-bytes');
    await withoutEnvBin(async () => {
      await expect(ensureEgressProxyExecutable(root, async () => null, cacheDir)).resolves.toBeNull();
    });
  });

  it('downloads into the cache and verifies the result', async () => {
    const { root, cacheDir } = versionedFixture();
    const download = async (_repo: string, dir: string) => writeCached(dir, 'fresh-bytes');
    await withoutEnvBin(async () => {
      await expect(ensureEgressProxyExecutable(root, download, cacheDir)).resolves.toBe(
        path.join(cacheDir, cachedName),
      );
    });
  });
});

describe('egressBinaryCacheDir', () => {
  it('stays outside the sidecar sandbox writable root ~/.steerable', () => {
    const home = path.join(path.sep, 'home', 'u');
    const sandboxRoot = path.join(home, '.steerable');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const dir = egressBinaryCacheDir(platform, {}, home);
      expect(dir.startsWith(sandboxRoot)).toBe(false);
    }
    expect(egressBinaryCacheDir('darwin', {}, home)).toBe(
      path.join(home, 'Library', 'Caches', 'steerable', 'egress-proxy'),
    );
  });
});
