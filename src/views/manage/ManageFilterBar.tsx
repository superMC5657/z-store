import React from 'react';
import { CountBadge } from '../../components/CountBadge';
import { Search, X } from 'lucide-react';

export interface ManageFilterTab<T extends string = string> {
  id: T;
  label: string;
  count?: number;
}

interface ManageFilterBarProps<T extends string = string> {
  tabs?: ManageFilterTab<T>[];
  activeTab?: T;
  onTabChange?: (id: T) => void;
  tabsAriaLabel?: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchPlaceholder: string;
  clearSearchLabel: string;
  rightExtra?: React.ReactNode;
}

/**
 * 管理工作台控制带：
 * 左侧为轻量下划线状态筛选标签（禁用 `.segmented-group` 以保持契约纯粹），
 * 右侧为可选扩展控件（如排序切换）与即时筛选输入框。
 */
export function ManageFilterBar<T extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  tabsAriaLabel,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  clearSearchLabel,
  rightExtra,
}: ManageFilterBarProps<T>): React.ReactElement {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0 && typeof onTabChange === 'function';

  return (
    <div className="manage-controls-bar">
      {hasTabs ? (
        <div className="manage-filter-tabs" role="tablist" aria-label={tabsAriaLabel}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`manage-filter-tab ${isActive ? 'active' : ''}`.trim()}
                onClick={() => onTabChange(tab.id)}
              >
                <span>{tab.label}</span>
                {typeof tab.count === 'number' && <CountBadge value={tab.count} active={isActive} />}
              </button>
            );
          })}
        </div>
      ) : (
        <div />
      )}

      <div className="manage-controls-right">
        {rightExtra}
        <label className="manage-search-box">
          <Search size={13} strokeWidth={1.5} aria-hidden="true" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {searchQuery.trim() !== '' && (
            <button
              type="button"
              className="manage-search-clear"
              onClick={() => onSearchChange('')}
              title={clearSearchLabel}
              aria-label={clearSearchLabel}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          )}
        </label>
      </div>
    </div>
  );
}
