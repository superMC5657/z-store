import React from 'react';
import { useTranslation } from 'react-i18next';
import { AppIcon } from './AppIcon';

/** 各档外框尺寸、圆角、安全留白与徽章/emoji 字号统一在 `.app-icon-frame.size-*` 中定义。 */
export type AppIconFrameSize = 'sm' | 'md' | 'lg';

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
 * - 内容按光学安全留白内缩：图片走 `fit="contain"` 防非方形/满幅图标被圆角裁切，
 *   首字母徽章与 emoji 内缩为同尺寸、铺 `iconBg` 的小圆角内块；
 * - `AppIcon` 在内缩模式下容器透明，中性底板只由外框提供。
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
      insetPadding="var(--icon-frame-inset)"
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
