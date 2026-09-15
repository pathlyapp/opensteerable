import { describe, expect, it } from 'vitest';
import {
  LOCAL_ASSISTANT_AGENT_ID,
  getBrand,
  setProductBrand,
} from '../src/brand.js';

describe('brand / shell 默认（无产品注入）', () => {
  it('中性 Steerable Shell 品牌 + 默认智能体 local-assistant（3.1 起产品品牌由 products/<id>/ 注入）', () => {
    const brand = getBrand();
    expect(brand.displayName).toBe('Steerable Shell');
    expect(brand.defaultAgentId).toBe(LOCAL_ASSISTANT_AGENT_ID);
  });
});

describe('brand / setProductBrand 注入（产品组装根 products/<id>/active.ts 的入口）', () => {
  it('注入后 getBrand 反映产品品牌；重复注入抛错', () => {
    setProductBrand({
      displayName: 'DomainTool智能助手',
      agentName: 'DomainTool智能助手',
      tagline: 'domain解释智能助手',
      defaultAgentId: 'domain_tool-operator',
    });
    const brand = getBrand();
    expect(brand.displayName).toBe('DomainTool智能助手');
    expect(brand.defaultAgentId).toBe('domain_tool-operator');
    expect(() =>
      setProductBrand({
        displayName: 'x',
        agentName: 'x',
        tagline: 'x',
        defaultAgentId: 'x',
      }),
    ).toThrow(/already set/);
  });
});
