import React from 'react';
import { useTranslation } from 'react-i18next';
import { AppIcon } from './AppIcon';

export type AppIconFrameSize = 'sm' | 'md' | 'lg';

/**
 * 各档图片安全留白（px）。`AppIcon` 仅在图片激活时以 inline 方式应用留白，
 * 故此值留在 TS；外框尺寸、圆角与徽章/emoji 字号在 `.app-icon-frame.size-*` 中定义。
 */
const IMG_PADDING: Record<AppIconFrameSize, number> = { sm: 2, md: 3, lg: 4 };

interface AppIconFrameProps {
  icon: string;
  name: string;
  appId?: string;
  iconBg?: string;
  /** `sm` 28px 紧凑列表；`md` 36px 常规列表行；`lg` 48px 详情头部。 */
  size?: AppIconFrameSize;
  /** 所在列表项处于选中态时加亮描边。 */
  selected?: boolean;
  iconOverride?: string;
  loading?: 'eager' | 'lazy';
  className?: string;
  onClick?: () => void;
  title?: string;
}

/**
 * 全站统一的应用图标框：
 * - 外框是带 `--bg-input` 底色与 `--border-subtle` 描边的中性容器；
 * - 内图走 `fit="contain"` + 光学安全留白，避免非方形/满幅图标被圆角裁切；
 * - 回退首字母徽章与 emoji 铺满外框。
 * 底色挂在外框上，因为 `AppIcon` 有图时会用 inline 透明背景覆盖自身 class 背景。
 */
export const AppIconFrame: React.FC<AppIconFrameProps> = ({
  icon,
  name,
  appId,
  iconBg,
  size = 'md',
  selected = false,
  iconOverride,
  loading,
  className,
  onClick,
  title,
}) => {
  const { t } = useTranslation();
  const frameClass = [
    'app-icon-frame',
    `size-${size}`,
    onClick ? 'is-clickable' : '',
    selected ? 'is-selected' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <AppIcon
      icon={icon}
      name={name}
      appId={appId}
      iconBg={iconBg}
      iconOverride={iconOverride}
      loading={loading}
      className="app-icon-frame-inner"
      fit="contain"
      imgPadding={IMG_PADDING[size]}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={frameClass}
        onClick={onClick}
        title={title}
        aria-label={title ? t('app.icon_action_label', { name, action: title }) : name}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={frameClass} title={title}>
      {content}
    </div>
  );
};
