/**
 * 对话包与配置包的渲染层。产品须把 VITE_PORTABLE 打成 'true' 才出现入口。
 * 界面档位和命令权限存在 localStorage，由这里并进配置包；其余段走本地后端。
 */

import { getElectronBridge } from '@/lib/electron-bridge';
import { listChats } from '@/lib/local-api';
import { persistExecPolicy, readStoredExecPolicy, type ExecPolicy } from '@/lib/exec-policy';
import {
  isThinkingDisplayMode,
  persistThinkingDisplay,
  readThinkingDisplay,
  type ThinkingDisplayMode,
} from '@/lib/show-thinking-content';

export function isPortableEnabled(): boolean {
  return import.meta.env.VITE_PORTABLE === 'true';
}

export interface PortablePreviewSection {
  id: string;
  label: string;
  detail: string;
  clientOnly: boolean;
  hasSecret: boolean;
}

export const PORTABLE_CHATS_CHANGED_EVENT = 'steerable-portable-chats-changed';

export interface PortablePreview {
  kind: 'steerable-config' | 'steerable-chat' | 'steerable-chats';
  includeSecrets: boolean;
  sections: PortablePreviewSection[];
  chat?: {
    title: string;
    messageCount: number;
    attachmentCount: number;
    omittedAttachmentCount: number;
    truncated: boolean;
    count?: number;
    projectName?: string;
    projectCount?: number;
  };
}

export interface PortableConfigDocument {
  kind: 'steerable-config';
  schemaVersion: number;
  exportedAt: string;
  includeSecrets: boolean;
  sections: Record<string, unknown>;
}

export interface PortableImportResult {
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
  missingSkills: string[];
  clientSections: string[];
}

export interface PortableChatImportResult {
  chatId: string;
  title: string;
  messageCount: number;
  attachmentsSaved: number;
}

const CLIENT_SECTION_IDS = ['appearance', 'execPolicy'] as const;

export function portableErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return '操作失败';
  const message = err.message.trim();
  if (!message) return '操作失败';
  try {
    const parsed = JSON.parse(message) as { detail?: unknown; error?: unknown };
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // 后端在浏览器模式直接给出文案；桌面模式把 JSON 放进 message。
  }
  return message;
}

export function parsePortableText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '文件不是 JSON' };
  }
}

export function safeDownloadName(stem: string, suffix: string): string {
  const cleaned = stem.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${cleaned || '导出'}-${suffix}.json`;
}

export function readLocalSections(): { appearance: { thinkingDisplay: ThinkingDisplayMode }; execPolicy: { policy: ExecPolicy } } {
  return {
    appearance: { thinkingDisplay: readThinkingDisplay() },
    execPolicy: { policy: readStoredExecPolicy() },
  };
}

/** 把勾选的本机段并进服务端导出的配置包，并删掉没勾的段。 */
export function finishConfigDocument(
  document: PortableConfigDocument,
  selected: ReadonlySet<string>,
): PortableConfigDocument {
  const sections: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(document.sections)) {
    if (selected.has(id)) sections[id] = value;
  }
  const local = readLocalSections();
  if (selected.has('appearance')) sections.appearance = local.appearance;
  if (selected.has('execPolicy')) sections.execPolicy = local.execPolicy;
  return { ...document, sections };
}

export function applyClientSections(
  sections: Record<string, unknown>,
  selected: ReadonlySet<string>,
): void {
  if (selected.has('appearance')) {
    const appearance = sections.appearance as { thinkingDisplay?: unknown } | undefined;
    if (isThinkingDisplayMode(appearance?.thinkingDisplay)) {
      persistThinkingDisplay(appearance.thinkingDisplay);
    }
  }
  if (selected.has('execPolicy')) {
    const policy = (sections.execPolicy as { policy?: unknown } | undefined)?.policy;
    if (policy === 'workspace' || policy === 'full') persistExecPolicy(policy);
  }
}

export function isClientSection(id: string): boolean {
  return (CLIENT_SECTION_IDS as readonly string[]).includes(id);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const bridge = getElectronBridge();
  if (!bridge) throw new Error('当前环境没有本地后端');
  return bridge.localBackend.request<T>(body === undefined ? { method, path } : { method, path, body });
}

export async function fetchConfigDocument(includeSecrets: boolean): Promise<PortableConfigDocument> {
  const flag = includeSecrets ? '1' : '0';
  return request<PortableConfigDocument>('GET', `/api/v2/portable/config?includeSecrets=${flag}`);
}

export async function fetchChatDocument(chatId: string): Promise<unknown> {
  return request('GET', `/api/v2/chats/${encodeURIComponent(chatId)}/portable`);
}

/** 设置页导出对话用。按更新时间分页拉全，避免只导出第一页。 */
export async function listPortableChats(): Promise<Array<{ id: string; title: string }>> {
  const rows: Array<{ id: string; title: string }> = [];
  let page = 1;
  for (;;) {
    const res = await listChats({ page, limit: 100 });
    for (const chat of res.chats) {
      rows.push({ id: chat.id, title: chat.title.trim() || '未命名对话' });
    }
    if (!res.pagination.hasMore || page >= 50) break;
    page += 1;
  }
  return rows;
}

export async function previewPortableDocument(document: unknown): Promise<PortablePreview> {
  return request<PortablePreview>('POST', '/api/v2/portable/preview', { document });
}

export async function importConfigDocument(
  document: unknown,
  sections: readonly string[],
): Promise<PortableImportResult> {
  return request<PortableImportResult>('POST', '/api/v2/portable/config', { document, sections });
}

export async function importChatDocument(document: unknown): Promise<PortableChatImportResult> {
  const result = await request<PortableChatImportResult>('POST', '/api/v2/portable/chats', { document });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PORTABLE_CHATS_CHANGED_EVENT));
  }
  return result;
}

export async function saveJsonFile(filename: string, data: unknown): Promise<string | null> {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const save = getElectronBridge()?.local?.saveTextFile;
  if (save) {
    const saved = await save({ title: '导出', defaultPath: filename, content });
    if (saved.canceled || !saved.filePath) return null;
    return saved.filePath;
  }
  if (typeof document === 'undefined') return filename;
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return filename;
}

export function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
