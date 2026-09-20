import { BRAND_NAME, BRAND_TITLE, getBrandLogoUrl } from '@/brand';

export interface BrandLockupProps {
  className?: string;
  onClick?: () => void;
}

/**
 * 侧栏品牌锁头。配了 brand.title 就 logo + 标题；没配标题则只显示 logo，
 * 并按原图宽高比缩放（一体字标不要压成方图）。
 * 自带 px-2.5 内边距，与侧边栏下方各功能行、会话行的图标在一条垂直参考线上（left: 20px）精准对齐。
 */
export function BrandLockup({ className, onClick }: BrandLockupProps = {}) {
  const title = BRAND_TITLE.trim();
  return (
    <div
      onClick={onClick}
      className={[
        'flex min-w-0 items-center gap-2 px-2.5',
        onClick ? 'cursor-pointer select-none transition-opacity hover:opacity-85' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <img
        src={getBrandLogoUrl()}
        alt={title || BRAND_NAME}
        className={`${title ? 'h-5' : 'h-6'} w-auto max-w-[10rem] flex-shrink-0 select-none object-contain object-left`}
        draggable={false}
      />
      {title ? (
        <span className="truncate text-xs font-semibold tracking-tight text-agent-foreground leading-none">
          {title}
        </span>
      ) : null}
    </div>
  );
}

