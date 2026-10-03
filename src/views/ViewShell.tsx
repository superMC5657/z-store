import React from 'react';
import { EmptyState } from '../components/EmptyState';
import type { AppSummary } from '../types';

/**
 * B3-G12 前端收敛：各 View 共享的壳与平台筛选空状态。
 *
 * 收敛前各 View 重复的内容：
 * - 外层 `<div className="*-view view-entrance">` 壳
 * - `broadcastPlatformReset` 兜底（HomeView / TrendsView 各自内联一份）
 * - `.filter-empty-reset` 空状态按钮（Home / Categories / Trends 文案各写一份）
 *
 * 约束：后端字段不动；此处只收敛前端展示层。`viewClass` 保持各 View
 * 原有的 CSS 类名不变，已有测试的选择器（`.filter-empty-reset` 等）不受影响。
 */

export const PLATFORM_FILTER_STORAGE_KEY = 'z-store:platform-filter:v1';
export const PLATFORM_RESET_EVENT = 'zstore:reset-platform-filter';

/**
 * 当 App 尚未接入 `onResetPlatformFilter` 时的兜底重置方案：
 * 清理持久化存储（App 的 `loadSelectedPlatforms` 在缺少键时会回退至全选集合），
 * 并向所有监听器广播重置意图。键名字符串与 App.PLATFORM_FILTER_STORAGE_KEY 一致；
 * 此处保持字面量以避免 view 与 App 之间的循环引用。
 */
export function broadcastPlatformReset(): void {
  try {
    window.localStorage.removeItem(PLATFORM_FILTER_STORAGE_KEY);
  } catch {
    // 忽略：存储抛错时保持内存中的选择
  }
  window.dispatchEvent(new CustomEvent(PLATFORM_RESET_EVENT));
}

/** 各内容 View 共用的应用网格 Props（Home / Categories / Favorites / Trends 对齐）。 */
export interface ViewAppActions {
  apps: AppSummary[];
  installedIds: Set<string>;
  installingIds?: Set<string>;
  favoriteIds: Set<string>;
  watchedIds?: Set<string>;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleWatch?: (id: string) => void;
}

/** 全局设备平台筛选重置扩展点（可选：未传入时回退为广播兜底）。 */
export interface PlatformResetOption {
  onResetPlatformFilter?: () => void;
}

/** 必选平台重置（CategoriesView：空状态重置按钮始终经 App 恢复全量设备集合）。 */
export interface RequiredPlatformReset {
  onResetPlatformFilter: () => void;
}

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

export interface ViewShellProps {
  /** 各 View 原有的根类名（如 `home-view`），`view-entrance` 由壳统一追加。 */
  viewClass: string;
  children: React.ReactNode;
}

/** 各 View 统一外壳：保留原根类名，仅收敛 `view-entrance` 拼接。 */
export const ViewShell: React.FC<ViewShellProps> = ({ viewClass, children }) => {
  return <div className={`${viewClass} view-entrance`}>{children}</div>;
};

export interface FilterEmptyStateProps {
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

/**
 * 平台筛选为空的统一空状态：EmptyState + `.filter-empty-reset` 重置按钮。
 * 文案由调用方传入（各 View 的 i18n 键保持不变）。
 */
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
