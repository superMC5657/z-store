import React from 'react';
import { EmptyState } from '../components/EmptyState';
import { broadcastPlatformReset } from '../lib/platformFilter';
import type { AppContextProps } from '../app/AppContext';
import type { AppSummary } from '../types';

/** 各内容 View 共用的应用网格 Props（缺失字段从 AppContext 补齐，显式传入优先）。 */
export interface ViewAppActions extends AppContextProps {
  apps: AppSummary[];
}

/** 未提供成员集合时的空集（模块级常量，保持 memo 依赖稳定）。 */
export const EMPTY_IDS: Set<string> = new Set<string>();

/** 未提供动作回调时的空操作。 */
export const noopAction = (): void => {};

/** 统一解析平台重置动作：优先调用方回调，否则广播兜底。 */
export function resolvePlatformReset(onReset?: () => void): () => void {
  return () => {
    if (onReset) {
      onReset();
    } else {
      broadcastPlatformReset();
    }
  };
}

interface ViewShellProps {
  /** 各 View 的根类名（如 `home-view`），`view-entrance` 由壳统一追加。 */
  viewClass: string;
  children: React.ReactNode;
}

/** 各 View 统一外壳：保留各 View 根类名，统一追加 `view-entrance`。 */
export const ViewShell: React.FC<ViewShellProps> = ({ viewClass, children }) => {
  return <div className={`${viewClass} view-entrance`}>{children}</div>;
};

interface FilterEmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  resetLabel: React.ReactNode;
  onReset: () => void;
  /** 保持各 View 原按钮主次样式，默认为 primary。 */
  variant?: 'primary' | 'secondary';
  style?: React.CSSProperties;
  className?: string;
}

/** 平台筛选结果为空时的统一空状态（含 `.filter-empty-reset` 重置按钮）。 */
export const FilterEmptyState: React.FC<FilterEmptyStateProps> = ({
  icon,
  title,
  description,
  resetLabel,
  onReset,
  variant = 'primary',
  style,
  className,
}) => {
  return (
    <EmptyState
      style={style}
      className={className}
      icon={icon}
      title={title}
      description={description}
      action={(
        <button type="button" className={`btn-fluent btn-${variant} filter-empty-reset`} onClick={onReset}>
          {resetLabel}
        </button>
      )}
    />
  );
};
