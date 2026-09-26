import type { PortablePreview } from '@/lib/portable';

/**
 * 导入单条对话前的确认。对话一律作为新会话插入，不覆盖本地同名会话。
 */
export function PortableChatImportDialog({
  preview,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  preview: PortablePreview;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const chat = preview.chat;
  const bits = chat
    ? [
        `${chat.messageCount} 条消息`,
        chat.attachmentCount > 0 ? `${chat.attachmentCount} 个附件` : null,
        chat.omittedAttachmentCount > 0 ? `${chat.omittedAttachmentCount} 个附件因过大未包含` : null,
        chat.truncated ? '消息已达到导出上限' : null,
        (chat.projectCount ?? 0) <= 0
          ? null
          : chat.projectCount === 1 && chat.projectName
            ? `项目「${chat.projectName}」（不含目录里的文件）`
            : `${chat.projectCount} 个项目（不含目录里的文件）`,
      ].filter((item): item is string => Boolean(item))
    : [];

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4" data-testid="portable-chat-import">
      <div className="w-full max-w-sm space-y-2 rounded-agent-lg border border-agent-border bg-agent-canvas p-3 shadow-lg">
        <h2 className="text-xs font-semibold text-agent-foreground">导入对话</h2>
        <p className="text-xs leading-relaxed text-agent-foreground">
          {(chat?.count ?? 1) > 1
            ? `将新增 ${chat?.count} 条对话，共 ${chat?.messageCount ?? 0} 条消息。`
            : `将新增对话「${chat?.title ?? '未命名'}」。${bits.join('，')}。`}
          不会覆盖现有会话。
        </p>
        {error && <p className="text-xs text-agent-destructive">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
            data-testid="portable-chat-import-confirm"
          >
            {busy ? '导入中' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
