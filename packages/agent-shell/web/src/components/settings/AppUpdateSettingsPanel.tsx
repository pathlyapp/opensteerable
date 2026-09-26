import { LuInfo } from 'react-icons/lu';
import { useAppRelease } from '@/components/SidebarRelease';

/**
 * 综合设置里的版本与更新。侧栏只显示版本号；检查、下载和安装在这里。
 * 没有桌面更新通道时不渲染。
 */
export function AppUpdateSettingsPanel() {
  const release = useAppRelease();
  if (!release.version) return null;
  const detail =
    release.actionTitle && release.actionTitle !== release.actionLabel
      ? release.actionTitle
      : null;

  return (
    <section className="space-y-2" data-testid="settings-section-update">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
        <LuInfo className="h-3.5 w-3.5 text-agent-muted-foreground" />
        关于
      </h2>
      <div className="flex items-center gap-3 rounded-agent-md border border-agent-border bg-agent-card p-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-agent-foreground">当前版本</p>
          <p
            className="mt-1 text-xs tabular-nums text-agent-muted-foreground"
            data-testid="settings-app-version"
          >
            v{release.version}
          </p>
          {detail ? (
            <p className="mt-1 text-xs leading-relaxed text-agent-muted-foreground">{detail}</p>
          ) : null}
        </div>
        {release.actionLabel ? (
          <button
            type="button"
            className={[
              'flex h-7 shrink-0 items-center rounded-full px-3 text-xs transition-colors',
              release.emphasize
                ? 'bg-agent-foreground font-medium text-agent-canvas hover:opacity-90'
                : 'border border-agent-border text-agent-foreground hover:bg-agent-foreground/5',
              release.clickable ? '' : 'cursor-default opacity-60',
            ].join(' ')}
            data-testid="settings-app-update"
            title={release.actionTitle}
            disabled={!release.clickable}
            onClick={release.run}
          >
            {release.actionLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
