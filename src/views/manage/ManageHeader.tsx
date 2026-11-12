import React from 'react';
import { CountBadge } from '../../components/CountBadge';

interface ManageHeaderProps {
  icon: React.ReactNode;
  title: string;
  count?: number;
  subtitle?: string;
  actions?: React.ReactNode;
}

/**
 * 管理工作台统一顶栏：
 * 左侧呈现统一尺寸线性图标 + 标题 + 数量角标 + 摘要副标题，右侧呈现主次分离的动作按钮簇。
 */
export const ManageHeader: React.FC<ManageHeaderProps> = ({
  icon,
  title,
  count,
  subtitle,
  actions,
}) => {
  return (
    <header className="manage-header">
      <div className="manage-header-main">
        <div className="manage-title-row">
          <span className="manage-title-icon" aria-hidden="true">
            {icon}
          </span>
          <h3 className="manage-title">
            <span>{title}</span>
            {typeof count === 'number' && <CountBadge value={count} />}
          </h3>
        </div>
        {subtitle ? <p className="manage-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="manage-actions-cluster">{actions}</div> : null}
    </header>
  );
};
