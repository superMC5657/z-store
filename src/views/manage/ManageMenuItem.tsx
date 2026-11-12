import React from 'react';

interface ManageMenuItemProps {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  danger?: boolean;
  onClick: () => void;
  title?: string;
}

/**
 * 管理工作台弹出菜单项：统一收口图标槽、标题与可选徽标结构。
 */
export const ManageMenuItem: React.FC<ManageMenuItemProps> = ({
  icon,
  label,
  badge,
  danger = false,
  onClick,
  title,
}) => (
  <button
    type="button"
    className={`flyout-item ${danger ? 'flyout-item-danger' : ''}`.trim()}
    onClick={onClick}
    title={title}
  >
    <span className="flyout-item-icon">{icon}</span>
    <span className="flyout-item-content">
      <span className="flyout-item-title">
        <span>{label}</span>
        {badge ? <span className="flyout-item-badge">{badge}</span> : null}
      </span>
    </span>
  </button>
);
