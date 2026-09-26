/**
 * 对话包 / 配置包的读写。路由只负责在产品开关打开时把请求转进来。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeToolPolicy } from './agent-capability.js';
import {
  PORTABLE_CHAT_KIND,
  PORTABLE_CHATS_KIND,
  PORTABLE_CONFIG_KIND,
  PORTABLE_MESSAGE_LIMIT,
  PORTABLE_SCHEMA_VERSION,
  isClientSectionId,
  llmSectionFromSettings,
  mcpSectionFromServer,
  previewPortable,
  readChatDocument,
  readConfigDocument,
  readPortableProject,
  rewriteAttachmentRefs,
  selectedServerSections,
  webSearchSectionFromSettings,
  type PortableAgentSection,
  type PortableChatDocument,
  type PortableConfigDocument,
  type PortableConfigSections,
  type PortableMcpSection,
  type ServerSectionId,
} from './portable-bundle.js';
import { isProductLlmLocked } from '../host-tools-runtime.js';
import { ensureProjectHome } from '../project-home.js';
import type { ProjectRegistry } from '../project-registry.js';
import type { CreateMcpServerInput, McpServerRegistry } from '../mcp-server-registry.js';
import { getUserDataDir } from '../runtime.js';
import {
  chatAttachmentsDirPath,
  isValidChatAttachmentsKey,
  saveAttachmentFiles,
} from '../attachments.js';
import {
  sanitizeCompatOverrides,
  sanitizeLlmProvider,
  sanitizePresetsChoice,
  sanitizeVendorId,
  type LlmSettings,
} from '../storage/llm-settings.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import type { ChatMessageRecord } from '../storage/index.js';

const ATTACHMENT_FILE_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;

export interface PortableResponse {
  status: number;
  data: unknown;
}

function fail(status: number, detail: string): PortableResponse {
  return { status, data: { detail, error: detail } };
}

function exportedAt(): string {
  return new Date().toISOString();
}

async function listUserSkillNames(): Promise<string[]> {
  const dir = path.join(getUserDataDir(), 'skills');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function exportConfigDocument(
  store: ScopedStore,
  mcp: McpServerRegistry | null,
  includeSecrets: boolean,
): Promise<PortableConfigDocument> {
  const sections: PortableConfigSections = {};
  const llm = await store.getLlmSettings();
  if (llm) {
    sections.llm = llmSectionFromSettings(llm as unknown as Record<string, unknown>, includeSecrets);
  }
  const webSearch = await store.getWebSearchSettings();
  if (webSearch) sections.webSearch = webSearchSectionFromSettings(webSearch, includeSecrets);
  const telemetry = await store.getTelemetrySettings();
  if (telemetry) {
    sections.telemetry = {
      endpoint: telemetry.endpoint,
      privacyMode: telemetry.privacyMode,
      serviceName: telemetry.serviceName,
    };
  }
  const insights = await store.getInsightsSettings();
  if (insights) {
    sections.insights = {
      shareBehavior: insights.shareBehavior,
      shareConversation: insights.shareConversation,
      shareProfile: insights.shareProfile,
      promptedAt: typeof insights.promptedAt === 'string' ? insights.promptedAt : undefined,
      apiBase: insights.apiBase,
      profile: { ...insights.profile },
    };
  }
  if (mcp) {
    const servers = mcp.list();
    if (servers.length > 0) {
      sections.mcp = servers.map((server) => mcpSectionFromServer(server, includeSecrets));
    }
  }
  const agents = (await store.listChatAgents(true)).filter((agent) => !agent.isBuiltin);
  if (agents.length > 0) {
    sections.agents = agents.map((agent) => ({
      name: agent.name,
      slug: agent.slug,
      icon: agent.icon,
      color: agent.color,
      description: agent.description,
      rolePrompt: agent.rolePrompt,
      forbiddenPrompt: agent.forbiddenPrompt,
      skillIds: [...agent.skillIds],
      toolPolicy: agent.toolPolicy,
      allowExternalSkills: agent.allowExternalSkills,
      loadAllSkills: agent.loadAllSkills,
      isArchived: agent.isArchived,
      sortOrder: agent.sortOrder,
    }));
  }
  const skillNames = await listUserSkillNames();
  if (skillNames.length > 0) sections.skills = { names: skillNames };
  return {
    kind: PORTABLE_CONFIG_KIND,
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    exportedAt: exportedAt(),
    includeSecrets,
    sections,
  };
}

async function readChatAttachments(chatId: string): Promise<PortableChatDocument['attachments']> {
  if (!isValidChatAttachmentsKey(chatId)) return [];
  const dir = chatAttachmentsDirPath(chatId);
  let names: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const attachments: PortableChatDocument['attachments'] = [];
  let total = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const bytes = await readFile(full);
      if (bytes.byteLength > ATTACHMENT_FILE_BYTES || total + bytes.byteLength > ATTACHMENT_TOTAL_BYTES) {
        attachments.push({ name, size: bytes.byteLength, omitted: true });
        continue;
      }
      total += bytes.byteLength;
      attachments.push({ name, size: bytes.byteLength, data: bytes.toString('base64') });
    } catch {
      attachments.push({ name, size: 0, omitted: true });
    }
  }
  return attachments;
}

export async function exportChatDocument(
  store: ScopedStore,
  chatId: string,
  projects: ProjectRegistry | null = null,
): Promise<PortableChatDocument | null> {
  const chat = await store.getChat(chatId);
  if (!chat) return null;
  const newestFirst = await store.listMessages(chatId, PORTABLE_MESSAGE_LIMIT);
  const messages = newestFirst.slice().reverse().map((message) => ({
    role: message.role,
    content: message.content,
    messageMetadata: message.messageMetadata,
    createdAt: message.createdAt,
  }));
  return {
    kind: PORTABLE_CHAT_KIND,
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    exportedAt: exportedAt(),
    chat: {
      title: chat.title,
      agentId: chat.agentId,
      isPinned: chat.isPinned,
      systemPrompt: chat.systemPrompt,
      pinnedRefs: chat.pinnedRefs,
    },
    ...(linkedProject(projects, chat.projectId) ?? {}),
    messages,
    truncated: newestFirst.length >= PORTABLE_MESSAGE_LIMIT,
    attachments: await readChatAttachments(chatId),
  };
}

async function applyLlm(
  store: ScopedStore,
  section: NonNullable<PortableConfigSections['llm']>,
): Promise<string | null> {
  if (isProductLlmLocked()) return '本产品的模型由部署配置固定';
  const current = await store.getLlmSettings();
  const next: LlmSettings = {
    provider: sanitizeLlmProvider(section.provider),
    vendorId: sanitizeVendorId(section.vendorId),
    model: section.model?.trim() || current?.model || 'deepseek-chat',
    baseUrl: section.baseUrl,
    apiKey: section.apiKeyIncluded ? section.apiKey : current?.apiKey,
    temperature: section.temperature,
    systemPrompt: section.systemPrompt,
    maxTotalTokens: section.maxTotalTokens,
    compat: sanitizeCompatOverrides(section.compat),
    presets: sanitizePresetsChoice(section.presets),
    execTimeoutSeconds:
      typeof section.execTimeoutSeconds === 'number' && section.execTimeoutSeconds > 0
        ? Math.floor(section.execTimeoutSeconds)
        : undefined,
  };
  await store.setLlmSettings(next);
  return null;
}

async function applyMcp(
  mcp: McpServerRegistry | null,
  servers: PortableMcpSection[],
): Promise<string | null> {
  if (!mcp) return 'MCP 注册表不可用';
  for (const server of servers) {
    const name = server.name?.trim();
    const command = server.command?.trim();
    if (!name || !command) continue;
    const input: CreateMcpServerInput = {
      name,
      command,
      args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
      cwd: server.cwd,
      enabled: server.enabled !== false,
      ...(server.envIncluded && server.env ? { env: server.env } : {}),
    };
    const existing = mcp.list().find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (existing) mcp.update(existing.id, input);
    else mcp.create({ ...input, env: input.env ?? {} });
  }
  return null;
}

async function applyAgents(
  store: ScopedStore,
  incoming: PortableAgentSection[],
): Promise<string[]> {
  const notes: string[] = [];
  const current = await store.listChatAgents(true);
  for (const agent of incoming) {
    const name = agent.name?.trim();
    if (!name) continue;
    if (current.some((item) => item.isBuiltin && item.name === name)) {
      notes.push(`跳过与内置智能体同名的「${name}」`);
      continue;
    }
    const fields = {
      slug: agent.slug ?? null,
      icon: agent.icon ?? null,
      color: agent.color ?? null,
      description: agent.description ?? null,
      rolePrompt: agent.rolePrompt ?? null,
      forbiddenPrompt: agent.forbiddenPrompt ?? null,
      skillIds: Array.isArray(agent.skillIds) ? agent.skillIds.map((id) => String(id)) : [],
      toolPolicy: normalizeToolPolicy(agent.toolPolicy),
      allowExternalSkills: agent.allowExternalSkills !== false,
      loadAllSkills: agent.loadAllSkills === true,
      isArchived: agent.isArchived === true,
      sortOrder: typeof agent.sortOrder === 'number' ? agent.sortOrder : 0,
      isBuiltin: false,
    };
    const found = current.find((item) => !item.isBuiltin && item.name === name);
    if (found) {
      await store.updateChatAgent(found.id, fields);
    } else {
      const created = await store.createChatAgent({ name, ...fields });
      current.push(created);
    }
  }
  return notes;
}

async function applySkills(names: string[]): Promise<string[]> {
  const present = new Set(await listUserSkillNames());
  return names.filter((name) => typeof name === 'string' && name && !present.has(name));
}

export async function importConfigDocument(
  store: ScopedStore,
  mcp: McpServerRegistry | null,
  raw: unknown,
  selected: readonly string[] | undefined,
): Promise<PortableResponse> {
  const doc = readConfigDocument(raw);
  if ('error' in doc) return fail(400, doc.error);
  const ids = selectedServerSections(doc.sections, selected);
  const applied: ServerSectionId[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const notes: string[] = [];
  let missingSkills: string[] = [];

  for (const id of ids) {
    if (id === 'llm' && doc.sections.llm) {
      const reason = await applyLlm(store, doc.sections.llm);
      if (reason) skipped.push({ id, reason });
      else applied.push(id);
    } else if (id === 'webSearch' && doc.sections.webSearch) {
      const current = await store.getWebSearchSettings();
      const section = doc.sections.webSearch;
      await store.setWebSearchSettings({
        provider: section.provider === 'ddg' ? 'ddg' : 'tavily',
        apiKey: section.apiKeyIncluded ? section.apiKey : current?.apiKey,
      });
      applied.push(id);
    } else if (id === 'telemetry' && doc.sections.telemetry) {
      const telemetry = doc.sections.telemetry;
      await store.setTelemetrySettings({
        endpoint: telemetry.endpoint,
        privacyMode: telemetry.privacyMode === 'full' ? 'full' : 'metadata',
        serviceName: telemetry.serviceName,
      });
      applied.push(id);
    } else if (id === 'insights' && doc.sections.insights) {
      await store.setInsightsSettings(doc.sections.insights);
      applied.push(id);
    } else if (id === 'mcp' && doc.sections.mcp) {
      const reason = await applyMcp(mcp, doc.sections.mcp);
      if (reason) skipped.push({ id, reason });
      else applied.push(id);
    } else if (id === 'agents' && doc.sections.agents) {
      notes.push(...(await applyAgents(store, doc.sections.agents)));
      applied.push(id);
    } else if (id === 'skills' && doc.sections.skills) {
      missingSkills = await applySkills(doc.sections.skills.names ?? []);
      applied.push(id);
    }
  }

  const clientSections = (selected ?? []).filter(isClientSectionId);
  return {
    status: 200,
    data: { applied, skipped, notes, missingSkills, clientSections },
  };
}

function linkedProject(
  projects: ProjectRegistry | null,
  projectId: string | null,
): { project: NonNullable<PortableChatDocument['project']> } | null {
  if (!projects || !projectId) return null;
  const project = projects.get(projectId);
  if (!project) return null;
  return {
    project: {
      name: project.name,
      folderPath: project.folderPath,
      sourceFolders: project.sourceFolders ?? [],
      trusted: project.trusted === true,
    },
  };
}

/**
 * 同名项目沿用本机已有记录，不改它的目录。没有同名项目时按导出的路径登记，
 * 路径不存在就建一个空目录。源文件夹和其他目录里的文件都不复制。
 */
function bindImportedProject(projects: ProjectRegistry | null, raw: unknown): string | null {
  if (!projects) return null;
  const project = readPortableProject(raw);
  if (!project) return null;
  const existing = projects.get(project.name);
  if (existing) return existing.id;
  ensureProjectHome(project.folderPath);
  const created = projects.create({
    name: project.name,
    folderPath: project.folderPath,
    sourceFolders: project.sourceFolders,
  });
  if (project.trusted) projects.setTrusted(created.id, true);
  return created.id;
}

async function importChatDocument(
  store: ScopedStore,
  raw: unknown,
  projects: ProjectRegistry | null,
): Promise<{
  response: PortableResponse;
  written?: { chatId: string; title: string; messageCount: number };
}> {
  const doc = readChatDocument(raw);
  if ('error' in doc) return { response: fail(400, doc.error) };
  const created = await store.createChat(
    doc.chat.title.trim(),
    doc.chat.agentId,
    bindImportedProject(projects, doc.project),
  );
  const pinnedRefs = Array.isArray(doc.chat.pinnedRefs) ? doc.chat.pinnedRefs : null;
  await store.updateChat(created.id, {
    isPinned: doc.chat.isPinned === true,
    systemPrompt: typeof doc.chat.systemPrompt === 'string' ? doc.chat.systemPrompt : null,
    pinnedRefs,
  });

  const pathByName = new Map<string, string>();
  const files = (doc.attachments ?? []).filter((file) => file && typeof file.data === 'string' && !file.omitted);
  if (files.length > 0) {
    const saved = await saveAttachmentFiles(
      created.id,
      files.map((file) => ({ name: file.name, data: file.data })),
    );
    for (const file of saved.files) {
      if (file.path) pathByName.set(file.name, file.path);
    }
  }

  const messages = doc.messages.slice(0, PORTABLE_MESSAGE_LIMIT);
  for (const message of messages) {
    let content = message.content;
    let metadata = message.messageMetadata;
    for (const [name, nextPath] of pathByName) {
      content = rewriteAttachmentRefs(content, name, nextPath);
      if (metadata) metadata = rewriteAttachmentRefs(metadata, name, nextPath);
    }
    await store.addMessage(created.id, message.role as ChatMessageRecord['role'], content, metadata);
  }

  const written = {
    chatId: created.id,
    title: created.title,
    messageCount: messages.length,
  };
  return {
    written,
    response: {
      status: 200,
      data: { ...written, attachmentsSaved: pathByName.size },
    },
  };
}

async function importSubmittedChats(
  store: ScopedStore,
  raw: unknown,
  projects: ProjectRegistry | null,
): Promise<PortableResponse> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { kind?: unknown }).kind !== PORTABLE_CHATS_KIND) {
    return (await importChatDocument(store, raw, projects)).response;
  }
  const preview = previewPortable(raw);
  if ('error' in preview) return fail(400, preview.error);
  const bundle = raw as { chats?: unknown };
  if (!Array.isArray(bundle.chats)) return fail(400, '对话包里没有对话');
  const docs = [];
  for (const item of bundle.chats) {
    const doc = readChatDocument(item);
    if ('error' in doc) return fail(400, doc.error);
    docs.push(doc);
  }
  const imported: Array<{ chatId: string; title: string; messageCount: number }> = [];
  for (const doc of docs) {
    const result = await importChatDocument(store, doc, projects);
    if (!result.written) return result.response;
    imported.push(result.written);
  }
  const messageCount = imported.reduce((sum, item) => sum + item.messageCount, 0);
  return {
    status: 200,
    data: {
      chatId: imported[0]?.chatId ?? '',
      title: imported.length === 1 ? (imported[0]?.title ?? '') : `${imported.length} 条对话`,
      messageCount,
      chatCount: imported.length,
    },
  };
}

function readBodyDocument(body: unknown): { document: unknown; sections?: string[] } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as { document?: unknown; sections?: unknown };
  if (!('document' in record)) return null;
  const sections = Array.isArray(record.sections)
    ? record.sections.filter((item): item is string => typeof item === 'string')
    : undefined;
  return { document: record.document, sections };
}

export async function handlePortableRequest(input: {
  method: string;
  pathname: string;
  includeSecrets: boolean;
  body: unknown;
  store: ScopedStore;
  mcp: McpServerRegistry | null;
  projects: ProjectRegistry | null;
}): Promise<PortableResponse> {
  const { method, pathname, store, mcp } = input;

  if (method === 'GET' && pathname === '/api/v2/portable/config') {
    return {
      status: 200,
      data: await exportConfigDocument(store, mcp, input.includeSecrets),
    };
  }

  if (method === 'POST' && pathname === '/api/v2/portable/preview') {
    const wrapped = readBodyDocument(input.body);
    if (!wrapped) return fail(400, '缺少 document');
    const preview = previewPortable(wrapped.document);
    if ('error' in preview) return fail(400, preview.error);
    return { status: 200, data: preview };
  }

  if (method === 'POST' && pathname === '/api/v2/portable/config') {
    const wrapped = readBodyDocument(input.body);
    if (!wrapped) return fail(400, '缺少 document');
    return importConfigDocument(store, mcp, wrapped.document, wrapped.sections);
  }

  if (method === 'POST' && pathname === '/api/v2/portable/chats') {
    const wrapped = readBodyDocument(input.body);
    if (!wrapped) return fail(400, '缺少 document');
    return importSubmittedChats(store, wrapped.document, input.projects);
  }

  const chatMatch = pathname.match(/^\/api\/v2\/chats\/([^/]+)\/portable$/);
  if (chatMatch && method === 'GET') {
    const doc = await exportChatDocument(store, decodeURIComponent(chatMatch[1]), input.projects);
    if (!doc) return fail(404, 'Chat not found');
    return { status: 200, data: doc };
  }

  return fail(404, 'Not found');
}
