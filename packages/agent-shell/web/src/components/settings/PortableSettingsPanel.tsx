import { useState } from 'react';
import { LuDownload, LuUpload } from 'react-icons/lu';
import { hostToolChrome, settingsChrome } from '@/lib/host-tools';
import { BRAND_NAME } from '@/brand';
import {
  applyClientSections,
  fetchChatDocument,
  fetchConfigDocument,
  finishConfigDocument,
  importChatDocument,
  importConfigDocument,
  listPortableChats,
  parsePortableText,
  pickJsonFile,
  portableErrorMessage,
  previewPortableDocument,
  safeDownloadName,
  saveJsonFile,
  type PortablePreview,
} from '@/lib/portable';

const EXPORT_SECTIONS: Array<{ id: string; label: string; visible: () => boolean }> = [
  { id: 'appearance', label: '界面', visible: () => settingsChrome('appearance') },
  { id: 'execPolicy', label: '命令权限', visible: () => hostToolChrome('local-fs') },
  { id: 'llm', label: '本地模型', visible: () => settingsChrome('llm') },
  { id: 'webSearch', label: '网络搜索', visible: () => settingsChrome('web-search') },
  { id: 'insights', label: '帮助改进产品', visible: () => settingsChrome('insights') },
  { id: 'telemetry', label: '遥测', visible: () => settingsChrome('telemetry') },
  { id: 'mcp', label: 'MCP 服务', visible: () => settingsChrome('mcp') },
  { id: 'agents', label: '智能体', visible: () => settingsChrome('agents') },
  { id: 'skills', label: '技能引用', visible: () => settingsChrome('skills') },
];

function projectClause(chat: { projectName?: string; projectCount?: number }): string | null {
  const count = chat.projectCount ?? 0;
  if (count <= 0) return null;
  if (count === 1 && chat.projectName) {
    return `项目「${chat.projectName}」（不含目录里的文件，同名项目沿用本机已有的）`;
  }
  return `${count} 个项目（不含目录里的文件，同名项目沿用本机已有的）`;
}

function describeChat(preview: PortablePreview): string {
  const chat = preview.chat;
  if (!chat) return '将作为新会话导入，不覆盖现有对话。';
  const bits = [`${chat.messageCount} 条消息`];
  if (chat.attachmentCount > 0) bits.push(`${chat.attachmentCount} 个附件`);
  if (chat.omittedAttachmentCount > 0) bits.push(`${chat.omittedAttachmentCount} 个附件因过大未包含`);
  if (chat.truncated) bits.push('消息已达到导出上限');
  const project = projectClause(chat);
  if (project) bits.push(project);
  if ((chat.count ?? 1) > 1) return `将新增 ${chat.count} 条对话，共 ${bits.join('，')}。不覆盖现有会话。`;
  return `将新增对话「${chat.title}」：${bits.join('，')}。不覆盖现有会话。`;
}

function describeImport(preview: PortablePreview): string {
  if (preview.includeSecrets) return '这份配置包含 API Key。导入后会写入本机。';
  return '将按勾选覆盖对应设置。未出现的段保持不动。钥匙默认不在包里，导入后需要自己填写。';
}

/**
 * 设置页「备份与迁移」：导出/导入配置和对话。
 * API Key 默认不进配置包。对话一律作为新会话导入。
 */
export function PortableSettingsPanel() {
  const visible = EXPORT_SECTIONS.filter((item) => item.visible());
  const [mode, setMode] = useState<'idle' | 'export' | 'export-chats' | 'import' | 'import-chat'>('idle');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(visible.map((item) => item.id)));
  const [chatRows, setChatRows] = useState<Array<{ id: string; title: string }>>([]);
  const [chatIds, setChatIds] = useState<Set<string>>(new Set());
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [preview, setPreview] = useState<PortablePreview | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleChat = (id: string) => {
    setChatIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startExportChats = async () => {
    setError(null);
    setStatus(null);
    setMode('export-chats');
    setBusy(true);
    try {
      const rows = await listPortableChats();
      setChatRows(rows);
      setChatIds(new Set(rows.map((row) => row.id)));
    } catch (err) {
      setError(portableErrorMessage(err));
      setMode('idle');
    } finally {
      setBusy(false);
    }
  };

  const confirmExportChats = async () => {
    const chosen = chatRows.filter((row) => chatIds.has(row.id));
    if (chosen.length === 0) {
      setError('请至少选择一条对话');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chats = [];
      for (const row of chosen) chats.push(await fetchChatDocument(row.id));
      const saved = await saveJsonFile(safeDownloadName(BRAND_NAME, '对话'), {
        kind: 'steerable-chats',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        chats,
      });
      setStatus(saved ? `已保存到 ${saved}` : '已取消');
      if (saved) setMode('idle');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startExport = () => {
    setError(null);
    setStatus(null);
    setIncludeSecrets(false);
    setSelected(new Set(visible.map((item) => item.id)));
    setMode('export');
  };

  const confirmExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const fetched = await fetchConfigDocument(includeSecrets);
      const finished = finishConfigDocument(fetched, selected);
      if (Object.keys(finished.sections).length === 0) {
        setError('没有可导出的内容');
        return;
      }
      const saved = await saveJsonFile(safeDownloadName(BRAND_NAME, '配置'), finished);
      setStatus(saved ? `已保存到 ${saved}` : '已取消');
      if (saved) setMode('idle');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    setError(null);
    setStatus(null);
    const text = await pickJsonFile();
    if (!text) return;
    const parsed = parsePortableText(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const next = await previewPortableDocument(parsed.value);
      setDocument(parsed.value);
      if (next.kind === 'steerable-chat' || next.kind === 'steerable-chats') {
        setPreview(next);
        setMode('import-chat');
        return;
      }
      setPreview(next);
      setSelected(new Set(next.sections.map((section) => section.id)));
      setMode('import');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!document || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const sections = preview.sections.filter((section) => selected.has(section.id));
      const record = document as { sections?: Record<string, unknown> };
      const serverIds = sections.filter((section) => !section.clientOnly).map((section) => section.id);
      const result = serverIds.length > 0
        ? await importConfigDocument(document, serverIds)
        : { applied: [], skipped: [], notes: [], missingSkills: [], clientSections: [] };
      applyClientSections(record.sections ?? {}, selected);
      const appliedLabels = sections
        .filter((section) => section.clientOnly || result.applied.includes(section.id))
        .map((section) => section.label);
      const parts = [`已导入${appliedLabels.length > 0 ? `：${appliedLabels.join('、')}` : ''}`];
      for (const item of result.skipped) parts.push(item.reason);
      for (const note of result.notes) parts.push(note);
      if (result.missingSkills.length > 0) {
        parts.push(`本机没有这些技能：${result.missingSkills.join('、')}`);
      }
      setStatus(parts.join('。'));
      setMode('idle');
      setPreview(null);
      setDocument(null);
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmImportChat = async () => {
    if (!document || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importChatDocument(document);
      const count = preview.chat?.count ?? 1;
      setStatus(count > 1 ? `已导入 ${count} 条对话` : `已导入对话「${result.title}」`);
      setMode('idle');
      setPreview(null);
      setDocument(null);
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setMode('idle');
    setPreview(null);
    setDocument(null);
  };

  return (
    <div
      className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5"
      data-testid="portable-settings-panel"
    >
      <p className="text-xs leading-relaxed text-agent-muted-foreground">
        导出配置或对话记录，带到另一台电脑后再导入。对话会连同所属项目一起导出，不包含项目目录里的文件。对话作为新会话导入，不覆盖现有记录。API Key 默认不包含。
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={startExport}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5"
          data-testid="portable-export-config"
        >
          <LuDownload className="h-3.5 w-3.5" />
          导出配置
        </button>
        <button
          type="button"
          onClick={() => void startExportChats()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-60"
          data-testid="portable-export-chats"
        >
          <LuDownload className="h-3.5 w-3.5" />
          导出对话
        </button>
        <button
          type="button"
          onClick={() => void startImport()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-60"
          data-testid="portable-import-config"
        >
          <LuUpload className="h-3.5 w-3.5" />
          导入
        </button>
      </div>

      {mode === 'export' && (
        <fieldset className="space-y-1.5" data-testid="portable-export-form">
          <legend className="text-xs font-medium text-agent-foreground">导出哪些段</legend>
          {visible.map((item) => (
            <label key={item.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                data-testid={`portable-section-${item.id}`}
              />
              {item.label}
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-agent-foreground">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(event) => setIncludeSecrets(event.target.checked)}
              data-testid="portable-include-secrets"
            />
            包含 API Key
          </label>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">
            勾选后文件等同于钥匙，不要发给别人，也不要提交到仓库。
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmExport()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-export-confirm"
            >
              {busy ? '导出中' : '保存文件'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              取消
            </button>
          </div>
        </fieldset>
      )}

      {mode === 'export-chats' && (
        <fieldset className="space-y-1.5" data-testid="portable-export-chats-form">
          <legend className="text-xs font-medium text-agent-foreground">导出哪些对话</legend>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">
            这些对话所属的项目会一起写进文件，只保留名称和目录位置，不打包目录里的文件。
          </p>
          {busy && chatRows.length === 0 ? (
            <p className="text-xs text-agent-muted-foreground">正在读取对话…</p>
          ) : chatRows.length === 0 ? (
            <p className="text-xs text-agent-muted-foreground">还没有对话。</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              <label className="flex items-center gap-1.5 text-xs text-agent-foreground">
                <input
                  type="checkbox"
                  checked={chatIds.size === chatRows.length}
                  onChange={() => {
                    setChatIds(chatIds.size === chatRows.length ? new Set() : new Set(chatRows.map((row) => row.id)));
                  }}
                  data-testid="portable-chats-all"
                />
                全部（{chatRows.length}）
              </label>
              {chatRows.map((row) => (
                <label key={row.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
                  <input
                    type="checkbox"
                    checked={chatIds.has(row.id)}
                    onChange={() => toggleChat(row.id)}
                    data-testid={`portable-chat-${row.id}`}
                  />
                  <span className="min-w-0 truncate">{row.title}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || chatRows.length === 0}
              onClick={() => void confirmExportChats()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-export-chats-confirm"
            >
              {busy ? '导出中' : '保存文件'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              取消
            </button>
          </div>
        </fieldset>
      )}

      {mode === 'import-chat' && preview && (
        <div className="space-y-1.5" data-testid="portable-import-chat-form">
          <p className="text-xs leading-relaxed text-agent-foreground">{describeChat(preview)}</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmImportChat()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-import-chat-confirm"
            >
              {busy ? '导入中' : '导入'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && preview && (
        <fieldset className="space-y-1.5" data-testid="portable-import-form">
          <legend className="text-xs font-medium text-agent-foreground">导入哪些段</legend>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">{describeImport(preview)}</p>
          {preview.sections.map((section) => (
            <label key={section.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
              <input
                type="checkbox"
                checked={selected.has(section.id)}
                onChange={() => toggle(section.id)}
                data-testid={`portable-import-section-${section.id}`}
              />
              <span>{section.label}</span>
              <span className="text-agent-muted-foreground">{section.detail}</span>
            </label>
          ))}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmImport()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-import-confirm"
            >
              {busy ? '导入中' : '导入'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              取消
            </button>
          </div>
        </fieldset>
      )}

      {status && (
        <p className="text-xs text-agent-muted-foreground" data-testid="portable-status">
          {status}
        </p>
      )}
      {error && (
        <p className="text-xs text-agent-destructive" data-testid="portable-error">
          {error}
        </p>
      )}
    </div>
  );
}
