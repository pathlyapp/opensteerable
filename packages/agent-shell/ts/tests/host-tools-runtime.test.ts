/**
 * 产品注入的 hostTools / approval 是服务端真源。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetProductConfigForTests, setProductConfig } from '../src/product-config.js';
import {
  getResolvedHostTools,
  isProductApprovalEnabled,
  isProductLlmLocked,
  resolveRuntimeLlmSettings,
  resolveTurnApproval,
  resolveTurnChatMode,
} from '../src/host-tools-runtime.js';
import { DEFAULT_LLM_SETTINGS } from '../src/storage/llm-settings.js';

afterEach(() => {
  resetProductConfigForTests();
  delete process.env.STEERABLE_APPROVAL;
  delete process.env.DEEPSEEK_API_KEY;
});

describe('getResolvedHostTools', () => {
  it('未注入产品时缺省全开', () => {
    expect(getResolvedHostTools().terminal.chrome).toBe(true);
    expect(getResolvedHostTools()['local-fs'].chrome).toBe(true);
  });

  it('读 product.json 注入的 hostTools', () => {
    setProductConfig({
      hostTools: { terminal: false, 'local-fs': { chrome: false } },
    });
    const tools = getResolvedHostTools();
    expect(tools.terminal).toEqual({ capability: false, chrome: false });
    expect(tools['local-fs']).toEqual({ capability: true, chrome: false });
  });
});

describe('isProductApprovalEnabled / resolveTurnApproval', () => {
  it('缺省挂 host 审批', () => {
    expect(isProductApprovalEnabled()).toBe(true);
    expect(resolveTurnApproval('/tmp/approvals.json')).toMatchObject({
      mode: 'host',
      storePath: '/tmp/approvals.json',
    });
  });

  it('产品 approval:off 取消安全询问', () => {
    setProductConfig({ approval: 'off' });
    expect(isProductApprovalEnabled()).toBe(false);
    expect(resolveTurnApproval('/tmp/approvals.json')).toBeUndefined();
  });

  it('STEERABLE_APPROVAL=0 覆盖产品 host', () => {
    setProductConfig({ approval: 'host' });
    process.env.STEERABLE_APPROVAL = '0';
    expect(isProductApprovalEnabled()).toBe(false);
  });
});

describe('resolveTurnChatMode', () => {
  it('缺省放行 plan', () => {
    expect(resolveTurnChatMode('plan')).toBe('plan');
  });

  it('产品只留 agent 时客户端 plan 被钳死', () => {
    setProductConfig({ chatModes: ['agent'] });
    expect(resolveTurnChatMode('plan')).toBe('agent');
  });
});

describe('resolveRuntimeLlmSettings', () => {
  it('设置页开着时用已存/出厂默认', () => {
    expect(isProductLlmLocked()).toBe(false);
    expect(resolveRuntimeLlmSettings(null)).toEqual(DEFAULT_LLM_SETTINGS);
  });

  it('settings.llm 关掉后钉死 product.llm', () => {
    setProductConfig({
      settings: { llm: false },
      llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
    process.env.DEEPSEEK_API_KEY = 'sk-product';
    expect(isProductLlmLocked()).toBe(true);
    expect(resolveRuntimeLlmSettings(null)).toMatchObject({
      model: 'deepseek-chat',
      apiKey: 'sk-product',
    });
  });
});
