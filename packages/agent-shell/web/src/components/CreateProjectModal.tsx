/**
 * 新建项目弹窗（Codex 式）：项目是带名字的容器，不是「选中的那个文件夹」。
 * 家目录由后端建在 Documents/<应用名>/<项目名>/；这里可选附加源文件夹。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuFolder, LuFolderPlus, LuX } from 'react-icons/lu';
import { BRAND_NAME } from '@/brand';
import { getElectronBridge, isElectron } from '@/lib/electron-bridge';

export interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; sourceFolders: string[] }) => Promise<void>;
}

export function CreateProjectModal({ open, onClose, onCreate }: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [sourceFolders, setSourceFolders] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSourceFolders([]);
    setSubmitting(false);
    setError(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const trimmed = name.trim();
  const homePreview = `~/Documents/${BRAND_NAME}/${trimmed || '项目名'}`;

  const handleAddFolder = async () => {
    if (!isElectron()) return;
    const result = await getElectronBridge()?.local?.selectDirectory({
      title: '添加源文件夹',
    });
    if (!result || result.canceled || result.filePaths.length === 0) return;
    const next = result.filePaths[0];
    setSourceFolders((prev) => (prev.includes(next) ? prev : [...prev, next]));
  };

  const handleSubmit = async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: trimmed, sourceFolders });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-title"
      data-testid="create-project-dialog"
    >
      <div className="flex w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-agent-border bg-agent-canvas shadow-2xl">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 id="create-project-title" className="text-base font-semibold text-agent-foreground">
            新建项目
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
            aria-label="关闭"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-3">
          <label className="flex h-10 items-center gap-2 rounded-full border border-agent-border bg-agent-canvas px-3 focus-within:border-agent-foreground/40">
            <LuFolder className="h-4 w-4 shrink-0 text-agent-muted-foreground" />
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              placeholder="项目名称"
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-agent-foreground outline-none placeholder:text-agent-muted-foreground"
              data-testid="create-project-name"
            />
          </label>
          <p className="px-1 text-[11px] text-agent-muted-foreground">
            默认位置：{homePreview}
          </p>

          <div>
            <div className="mb-2 text-sm text-agent-foreground">源文件夹</div>
            {sourceFolders.length > 0 && (
              <ul className="mb-2 space-y-1">
                {sourceFolders.map((folder) => (
                  <li
                    key={folder}
                    className="flex items-center gap-2 rounded-lg bg-agent-muted/40 px-2.5 py-1.5 text-xs text-agent-foreground"
                  >
                    <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono" title={folder}>
                      {folder}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSourceFolders((prev) => prev.filter((item) => item !== folder))
                      }
                      className="rounded-full p-0.5 text-agent-muted-foreground hover:text-agent-foreground"
                      aria-label={`移除 ${folder}`}
                    >
                      <LuX className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-agent-border px-4 py-8">
              <span className="text-sm text-agent-muted-foreground">添加此电脑上的文件夹</span>
              <button
                type="button"
                onClick={() => void handleAddFolder()}
                disabled={!isElectron()}
                className="flex h-8 items-center gap-1.5 rounded-full border border-agent-border px-4 text-xs font-medium text-agent-foreground transition-colors hover:bg-agent-muted disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="create-project-add-folder"
              >
                <LuFolderPlus className="h-3.5 w-3.5" />
                添加
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-agent-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-full px-4 text-sm text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!trimmed || submitting}
            className="h-9 rounded-full bg-agent-foreground px-4 text-sm font-medium text-agent-canvas transition-opacity disabled:opacity-40"
            data-testid="create-project-submit"
          >
            {submitting ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
