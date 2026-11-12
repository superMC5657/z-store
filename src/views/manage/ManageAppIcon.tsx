import React from 'react';
import { AppIcon } from '../../components/AppIcon';

interface ManageAppIconProps {
  icon: string;
  name: string;
  appId: string;
  iconBg?: string;
  size?: 'md' | 'sm';
  onClick?: () => void;
  title?: string;
}

/**
 * 管理工作台专用的光学安全区图标框：
 * - 外框固定 36×36px（sm 28×28px）圆角中性容器；
 * - 内图统一走 `fit="contain"` + 光学安全留白，避免非方形/满幅应用图标被圆角强行裁切；
 * - 回退首字母徽章与 emoji 仍无缝铺满容器。
 */
export const ManageAppIcon: React.FC<ManageAppIconProps> = ({
  icon,
  name,
  appId,
  iconBg,
  size = 'md',
  onClick,
  title,
}) => {
  const frameClass = [
    'manage-icon-frame',
    size === 'sm' ? 'size-sm' : '',
    onClick ? 'is-clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <AppIcon
      icon={icon}
      name={name}
      appId={appId}
      iconBg={iconBg}
      className="manage-icon-inner"
      fit="contain"
      imgPadding={size === 'sm' ? 3 : 4}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={frameClass}
        onClick={onClick}
        title={title}
        aria-label={title ? `${name}: ${title}` : name}
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
