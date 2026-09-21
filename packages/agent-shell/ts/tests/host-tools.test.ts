/**
 * 宿主工具族解析：产品声明 → chrome / capability / 围栏 / 路由 / 审批。
 * 服务端与渲染层共用本模块，缺省全开。
 */
import { describe, expect, it } from 'vitest';
import {
  buildHostApproval,
  clampChatMode,
  clampExecPolicy,
  familyForHostToolName,
  hasGeneralSettingsChrome,
  isApprovalEnabled,
  isHostIpcAllowed,
  isHostRouteAllowed,
  isHostToolCapabilityEnabled,
  resolveChatModes,
  resolveHostTools,
  resolveSettingsChrome,
  sanitizeRightPanelKind,
} from '../src/host-tools.js';

const etownConfig = {
  terminal: false as const,
  'local-fs': { chrome: false },
};

describe('resolveHostTools', () => {
  it('缺省全开（中性 shell / 未声明的族）', () => {
    const tools = resolveHostTools();
    expect(tools.terminal).toEqual({ capability: true, chrome: true });
    expect(tools['local-fs']).toEqual({ capability: true, chrome: true });
    expect(tools.projects).toEqual({ capability: true, chrome: true });
    expect(tools['background-tasks'].chrome).toBe(true);
  });

  it('false 关掉整族；对象可只关 chrome', () => {
    const tools = resolveHostTools(etownConfig);
    expect(tools.terminal).toEqual({ capability: false, chrome: false });
    expect(tools['local-fs']).toEqual({ capability: true, chrome: false });
    expect(tools.mcp.chrome).toBe(true);
  });

  it('对象必须显式 chrome: true 才开入口', () => {
    expect(resolveHostTools({ 'local-fs': { capability: true } })['local-fs'].chrome).toBe(
      false,
    );
    expect(
      resolveHostTools({ 'local-fs': { capability: true, chrome: true } })['local-fs'].chrome,
    ).toBe(true);
  });
});

describe('clampExecPolicy', () => {
  it('入口关掉时无视客户端 full，钳死 workspace', () => {
    const tools = resolveHostTools(etownConfig);
    expect(clampExecPolicy('full', tools)).toBe('workspace');
    expect(clampExecPolicy('workspace', tools)).toBe('workspace');
  });

  it('入口开着时才放行 full', () => {
    const tools = resolveHostTools({ 'local-fs': true });
    expect(clampExecPolicy('full', tools)).toBe('full');
    expect(clampExecPolicy('danger', tools)).toBe('workspace');
  });
});

describe('isHostRouteAllowed', () => {
  const etown = resolveHostTools(etownConfig);

  it('公文：可见终端与本机打开/附件入口拒绝；选目录留给项目/技能', () => {
    expect(isHostRouteAllowed('/host/terminal/list', etown)).toBe(false);
    expect(isHostRouteAllowed('/host/terminal/exec', etown)).toBe(false);
    expect(isHostRouteAllowed('/host/local/open-path', etown)).toBe(false);
    expect(isHostRouteAllowed('/host/attachments/save', etown)).toBe(false);
    expect(isHostRouteAllowed('/host/local/select-directory', etown)).toBe(true);
  });

  it('公文：local-fs 能力路由仍开（模型侧读写/脚本）', () => {
    expect(isHostRouteAllowed('/host/local/exec-shell', etown)).toBe(true);
    expect(isHostRouteAllowed('/host/local/read-file', etown)).toBe(true);
    expect(isHostRouteAllowed('/host/local/write-file', etown)).toBe(true);
  });

  it('审批与转向不受工具族拦截', () => {
    expect(isHostRouteAllowed('/host/steer', etown)).toBe(true);
    expect(isHostRouteAllowed('/host/approval/decide', etown)).toBe(true);
  });
});

describe('isHostToolCapabilityEnabled / familyForHostToolName', () => {
  it('maps local_* / mcp__* / task_* to families', () => {
    expect(familyForHostToolName('local_exec_shell')).toBe('local-fs');
    expect(familyForHostToolName('mcp__docs__search')).toBe('mcp');
    expect(familyForHostToolName('task_run')).toBe('background-tasks');
    expect(familyForHostToolName('delegate_subagent')).toBeNull();
  });

  it('族 capability 关掉后模型看不到该族工具；包工具不受影响', () => {
    const tools = resolveHostTools({ 'local-fs': false });
    expect(isHostToolCapabilityEnabled('local_read_file', tools)).toBe(false);
    expect(isHostToolCapabilityEnabled('cflog_scan', tools)).toBe(true);
  });

  it('公文关掉 chrome 仍保留 local_* 能力', () => {
    const tools = resolveHostTools(etownConfig);
    expect(isHostToolCapabilityEnabled('local_exec_shell', tools)).toBe(true);
  });
});

describe('sanitizeRightPanelKind', () => {
  it('恢复持久化 terminal 时若产品没引入则丢掉', () => {
    expect(sanitizeRightPanelKind('terminal', resolveHostTools(etownConfig))).toBeNull();
    expect(sanitizeRightPanelKind('terminal', resolveHostTools({ terminal: true }))).toBe(
      'terminal',
    );
    expect(sanitizeRightPanelKind('ppt', resolveHostTools(etownConfig))).toBe('ppt');
  });
});

describe('isApprovalEnabled', () => {
  it('缺省挂 host 审批', () => {
    expect(isApprovalEnabled()).toBe(true);
    expect(isApprovalEnabled({ productApproval: 'host' })).toBe(true);
  });

  it('产品 approval:off 关掉命令安全询问', () => {
    expect(isApprovalEnabled({ productApproval: 'off' })).toBe(false);
  });

  it('STEERABLE_APPROVAL=0 仍是调试逃生口', () => {
    expect(isApprovalEnabled({ productApproval: 'host', envApproval: '0' })).toBe(false);
  });

  it('approval:off 不构造 host 审批对象', () => {
    expect(
      buildHostApproval({ productApproval: 'off', storePath: '/tmp/a.json' }),
    ).toBeUndefined();
    expect(
      buildHostApproval({ productApproval: 'host', storePath: '/tmp/a.json' }),
    ).toEqual({
      mode: 'host',
      timeoutMs: 120_000,
      storePath: '/tmp/a.json',
    });
  });
});

describe('resolveChatModes / clampChatMode', () => {
  it('缺省 Agent + Plan', () => {
    expect(resolveChatModes(undefined)).toEqual(['agent', 'plan']);
    expect(clampChatMode('plan')).toBe('plan');
  });

  it('只声明 Agent 时钳死 plan', () => {
    const modes = resolveChatModes(['agent']);
    expect(modes).toEqual(['agent']);
    expect(clampChatMode('plan', modes)).toBe('agent');
    expect(clampChatMode('agent', modes)).toBe('agent');
  });

  it('空数组回落 Agent', () => {
    expect(resolveChatModes([])).toEqual(['agent']);
  });
});

describe('resolveSettingsChrome', () => {
  it('缺省全开', () => {
    const chrome = resolveSettingsChrome();
    expect(chrome.appearance).toBe(true);
    expect(chrome.llm).toBe(true);
    expect(chrome.agents).toBe(true);
    expect(hasGeneralSettingsChrome(chrome)).toBe(true);
  });

  it('false 藏入口；关了的宿主工具族一并藏对应设置段', () => {
    const chrome = resolveSettingsChrome(
      { diagnose: false, security: false, telemetry: false },
      resolveHostTools({ mcp: false, plugins: false, web: false }),
    );
    expect(chrome.appearance).toBe(true);
    expect(chrome.llm).toBe(true);
    expect(chrome.diagnose).toBe(false);
    expect(chrome.security).toBe(false);
    expect(chrome.telemetry).toBe(false);
    expect(chrome.mcp).toBe(false);
    expect(chrome.skills).toBe(false);
    expect(chrome['web-search']).toBe(false);
  });
});

describe('isHostIpcAllowed', () => {
  const etown = resolveHostTools(etownConfig);

  it('可见终端通道跟 chrome 走', () => {
    expect(isHostIpcAllowed('terminal:list', etown)).toBe(false);
    expect(isHostIpcAllowed('terminal:exec', etown)).toBe(false);
    expect(isHostIpcAllowed('terminal:list', resolveHostTools({ terminal: true }))).toBe(true);
  });

  it('本机打开 / 附件入口跟 chrome 走；选目录与模型侧 local:* 仍开', () => {
    expect(isHostIpcAllowed('local:open-path', etown)).toBe(false);
    expect(isHostIpcAllowed('attachments:save', etown)).toBe(false);
    expect(isHostIpcAllowed('local:select-directory', etown)).toBe(true);
    expect(isHostIpcAllowed('local:exec-shell', etown)).toBe(true);
    expect(isHostIpcAllowed('local:read-file', etown)).toBe(true);
  });
});
