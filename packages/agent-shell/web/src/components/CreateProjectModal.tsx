/**
 * 新建 / 编辑项目弹窗（Codex 式）：项目是带名字的容器，可附加多个源文件夹。
 * 家目录由后端建在 Documents/<应用名>/<项目名>/；源文件夹只放宽读取。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuFolder, LuFolderPlus, LuX } from 'react-icons/lu';
import { BRAND_NAME } from '@/brand';
import { getElectronBridge } from '@/lib/electron-bridge';

export interface ProjectFormValues {
  name: string;
  sourceFolders: string[];
}

export interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: ProjectFormValues) => Promise<void>;
  mode?: 'create' | 'edit';
  initial?: ProjectFormValues;
  onDelete?: () => Promise<void> | void;
}

export function CreateProjectModal({
  open,
  onClose,
  onCreate,
  mode = 'create',
  initial,
  onDelete,
}: CreateProjectModalProps) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(initial?.name ?? '');
  const [sourceFolders, setSourceFolders] = useState(initial?.sourceFolders ?? []);
  const [folderDraft, setFolderDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialFoldersKey = (initial?.sourceFolders ?? []).join('\0');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setSourceFolders(initial?.sourceFolders ?? []);
    setFolderDraft('');
    setSubmitting(false);
    setDeleting(false);
    setConfirmDelete(false);
    setError(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, initial?.name, initialFoldersKey]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const trimmed = name.trim();
  const homePreview = `~/Documents/${BRAND_NAME}/${trimmed || '项目名'}`;
  const titleId = isEdit ? 'edit-project-title' : 'create-project-title';

  const addSourceFolder = (folder: string) => {
    const next = folder.trim();
    if (!next) return;
    setSourceFolders((prev) => (prev.includes(next) ? prev : [...prev, next]));
    setFolderDraft('');
    setError(null);
  };

  const handleAddFolder = async () => {
    const typed = folderDraft.trim();
    if (typed) {
      addSourceFolder(typed);
      return;
    }
    const result = await getElectronBridge()?.local?.selectDirectory({
      title: '添加源文件夹',
    });
    if (!result || result.canceled || result.filePaths.length === 0) {
      if (!getElectronBridge()?.local?.selectDirectory) {
        setError('请输入文件夹路径');
      }
      return;
    }
    addSourceFolder(result.filePaths[0]);
  };

  const handleSubmit = async () => {
    if (!trimmed || submitting || deleting) return;
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

  const handleDelete = async () => {
    if (!onDelete || deleting || submitting) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
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
      aria-labelledby={titleId}
      data-testid={isEdit ? 'edit-project-dialog' : 'create-project-dialog'}
    >
      <div className="flex w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-agent-border bg-agent-canvas shadow-2xl">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 id={titleId} className="text-base font-semibold text-agent-foreground">
            {isEdit ? '编辑项目' : '新建项目'}
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
              data-testid={isEdit ? 'edit-project-name' : 'create-project-name'}
            />
          </label>
          {!isEdit && (
            <p className="px-1 text-[11px] text-agent-muted-foreground">
              默认位置：{homePreview}
            </p>
          )}

          <div>
            <div className="mb-2 text-sm text-agent-foreground">源文件夹</div>
            <div className="overflow-hidden rounded-2xl border border-agent-border">
              {sourceFolders.map((folder) => (
                <div
                  key={folder}
                  className="flex items-center gap-2 border-b border-agent-border/60 px-3 py-2 text-xs text-agent-foreground"
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
                </div>
              ))}
              <div className="flex items-center gap-2 px-3 py-2">
                <LuFolderPlus className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                <input
                  type="text"
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleAddFolder();
                    }
                  }}
                  placeholder="输入路径或点添加浏览"
                  className="h-7 min-w-0 flex-1 bg-transparent text-xs text-agent-foreground outline-none placeholder:text-agent-muted-foreground"
                  data-testid={isEdit ? 'edit-project-folder-path' : 'create-project-folder-path'}
                />
                <button
                  type="button"
                  onClick={() => void handleAddFolder()}
                  className="shrink-0 rounded-full px-2 py-1 text-xs font-medium text-agent-foreground hover:bg-agent-muted"
                  data-testid={isEdit ? 'edit-project-add-folder' : 'create-project-add-folder'}
                >
                  添加
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-agent-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 pb-4 pt-1">
          {onDelete && (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting || submitting}
              title={
                confirmDelete
                  ? '再次点击确认删除（会话会保留为无项目对话）'
                  : '删除项目（会话保留为无项目对话）'
              }
              className="mr-auto h-9 rounded-full px-3 text-sm text-agent-destructive transition-colors hover:bg-agent-destructive/10 disabled:opacity-40"
              data-testid="edit-project-delete"
            >
              {confirmDelete ? '再次点击确认删除' : '删除本地项目'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`h-9 rounded-full px-4 text-sm text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground ${
              onDelete ? '' : 'ml-auto'
            }`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!trimmed || submitting || deleting}
            className="h-9 rounded-full bg-agent-foreground px-4 text-sm font-medium text-agent-canvas transition-opacity disabled:opacity-40"
            data-testid={isEdit ? 'edit-project-submit' : 'create-project-submit'}
          >
            {submitting ? (isEdit ? '保存中…' : '创建中…') : isEdit ? '保存' : '创建项目'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
