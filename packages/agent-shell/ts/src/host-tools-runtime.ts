/**
 * 把产品注入的 hostTools / approval 接到解析器。
 * host-tools.ts 保持无 node 依赖，供测试与渲染层复用解析规则。
 */
import os from 'node:os';
import path from 'node:path';
import { getProductConfig } from './product-config.js';
import {
  buildHostApproval,
  isHostIpcAllowed,
  resolveHostTools,
  type HostToolsConfig,
  type ResolvedHostTools,
} from './host-tools.js';

export function getResolvedHostTools(): ResolvedHostTools {
  return resolveHostTools(getProductConfig().hostTools as HostToolsConfig | undefined);
}

export function isProductApprovalEnabled(): boolean {
  return (
    buildHostApproval({
      productApproval: getProductConfig().approval,
      envApproval: process.env.STEERABLE_APPROVAL,
      storePath: 'unused',
    }) !== undefined
  );
}

export function resolveTurnApproval(
  storePath = path.join(os.homedir(), '.steerable', 'approvals.json'),
): ReturnType<typeof buildHostApproval> {
  return buildHostApproval({
    productApproval: getProductConfig().approval,
    envApproval: process.env.STEERABLE_APPROVAL,
    storePath,
  });
}

export function assertHostIpcAllowed(channel: string): void {
  if (!isHostIpcAllowed(channel, getResolvedHostTools())) {
    throw new Error(`${channel} is disabled for this product`);
  }
}
