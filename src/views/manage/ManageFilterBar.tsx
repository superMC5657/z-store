import React from 'react';
import { CountBadge } from '../../components/CountBadge';
import { Search, X } from 'lucide-react';

export interface ManageFilterTab<T extends string = string> {
  id: T;
  label: string;
  count?: number;
}

/** 即时筛选输入框的全部配置；四项同进同退，缺一则输入框无可读标签。 */
export interface ManageFilterSearch {
  query: string;
  onChange: (query: string) => void;
  placeholder: string;
  clearLabel: string;
}

interface ManageFilterBarProps<T extends string = string> {
  tabs?: ManageFilterTab<T>[];
  activeTab?: T;
  onTabChange?: (id: T) => void;
  tabsAriaLabel?: string;
  search?: ManageFilterSearch;
  rightExtra?: React.ReactNode;
}

/**
 * 管理工作台控制带：
 * 左侧为轻量下划线状态筛选标签（禁用 `.segmented-group` 以保持契约纯粹），
 * 右侧为可选扩展控件（如排序切换）与可选即时筛选输入框（传入 `search` 时渲染）。
 */
export function ManageFilterBar<T extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  tabsAriaLabel,
  search,
  rightExtra,
}: ManageFilterBarProps<T>): React.ReactElement {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0 && typeof onTabChange === 'function';
  const hasRight = Boolean(rightExtra) || Boolean(search);

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

      {hasRight && (
        <div className="manage-controls-right">
          {rightExtra}
          {search && (
            <label className="manage-search-box">
              <Search size={13} strokeWidth={1.5} aria-hidden="true" />
              <input
                type="text"
                value={search.query}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder}
                aria-label={search.placeholder}
              />
              {search.query.trim() !== '' && (
                <button
                  type="button"
                  className="manage-search-clear"
                  onClick={() => search.onChange('')}
                  title={search.clearLabel}
                  aria-label={search.clearLabel}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              )}
            </label>
          )}
        </div>
      )}
    </div>
  );
}
