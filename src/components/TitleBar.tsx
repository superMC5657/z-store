import React, { useEffect, useRef, useState } from 'react';
import { Clock, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from './BrandLogo';
import { api } from '../services/api';

interface TitleBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  language?: string;
  onToggleLanguage?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
  language,
  onToggleLanguage,
  isSidebarCollapsed = false,
  onToggleSidebar,
}) => {
  const { t, i18n } = useTranslation();
  const currentLang = language || i18n.language || 'zh-CN';
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [isMaximized, setIsMaximized] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  const loadSearchHistory = async () => {
    try {
      const history = await api.getSearchHistory();
      setSearchHistory(history);
    } catch {
      // 忽略错误
    }
  };

  useEffect(() => {
    loadSearchHistory();
  }, []);

  // 点击外部区域时关闭下拉面板
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  // 全局快捷键：Ctrl+K 聚焦搜索，Escape 取消聚焦
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleInputChange = (val: string) => {
    setLocalQuery(val);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    // 150ms 防抖响应（FR-1.1）
    debounceTimerRef.current = setTimeout(() => {
      onSearchChange(val);
      if (val.trim()) {
        api.recordSearchQuery(val.trim()).then(loadSearchHistory).catch(() => {});
      }
    }, 250);
  };

  const handleSelectHistory = (query: string) => {
    setLocalQuery(query);
    onSearchChange(query);
    setIsDropdownOpen(false);
    api.recordSearchQuery(query).then(loadSearchHistory).catch(() => {});
  };

  const handleClearHistory = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.clearSearchHistory();
      setSearchHistory([]);
    } catch {
      // 忽略错误
    }
  };

  const handleRemoveHistoryItem = async (e: React.MouseEvent, item: string) => {
    e.stopPropagation();
    try {
      await api.removeSearchQuery(item);
      setSearchHistory((prev) => prev.filter((x) => x !== item));
    } catch {
      // 忽略错误
    }
  };

  const handleMinimize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // 纯浏览器预览模式
    }
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
      setIsMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // 纯浏览器预览模式
    }
  };

  const handleClose = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // 纯浏览器预览模式
    }
  };

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // 只有双击标题栏空白行区域才触发窗口最大化/还原
    // 点击或快速双击按钮、搜索框、输入控件、快捷键气泡、历史浮层或窗口按钮等控件时坚决不触发
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('select') ||
      target.closest('.search-box') ||
      target.closest('.win-controls') ||
      target.closest('.win-btn') ||
      target.closest('.theme-toggle-btn') ||
      target.closest('.nav-toggle-btn') ||
      target.closest('.search-kbd') ||
      target.closest('a')
    ) {
      return;
    }
    handleMaximize();
  };

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={handleHeaderDoubleClick}
    >
      <div className={`titlebar-left ${isSidebarCollapsed ? 'collapsed' : ''}`} data-tauri-drag-region>
        {onToggleSidebar && (
          <button
            className="nav-toggle-btn"
            data-tauri-drag-region="false"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={onToggleSidebar}
            title={isSidebarCollapsed ? t('titlebar.nav_toggle_expand') : t('titlebar.nav_toggle_collapse')}
            aria-label={isSidebarCollapsed ? t('titlebar.nav_toggle_expand') : t('titlebar.nav_toggle_collapse')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <div className="app-brand-badge" data-tauri-drag-region>
          <BrandLogo theme={theme} size={22} />
          <span data-tauri-drag-region>Z-Store</span>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <div
          className="search-box"
          ref={searchBoxRef}
          data-tauri-drag-region="false"
          onDoubleClick={(e) => e.stopPropagation()}
          style={{ position: 'relative' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={localQuery}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => {
              loadSearchHistory();
              setIsDropdownOpen(true);
            }}
            placeholder={t('titlebar.search_placeholder')}
          />
          <kbd
            className="search-kbd"
            onClick={() => {
              searchInputRef.current?.focus();
              searchInputRef.current?.select();
            }}
            title="快捷键: ⌘K / Ctrl+K 激活搜索"
          >
            ⌘K
          </kbd>

          {/* 搜索历史记录浮层气泡 */}
          {isDropdownOpen && searchHistory.length > 0 && !localQuery && (
            <div className="search-history-dropdown">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '8px',
                  fontSize: '11.5px',
                  color: 'var(--text-tertiary)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <Clock size={12} strokeWidth={1.5} />
                  <span>{t('titlebar.search_history')}</span>
                </span>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-xs)',
                  }}
                  title={t('titlebar.clear_history_tooltip')}
                >
                  {t('titlebar.clear_all')}
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {searchHistory.map((item) => (
                  <div
                    key={item}
                    onClick={() => handleSelectHistory(item)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '3px 8px',
                      borderRadius: 'var(--radius-xs)',
                      background: 'var(--bg-acrylic-hover)',
                      border: '1px solid var(--border-subtle)',
                      fontSize: '12px',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      transition: 'border-color 0.1s ease',
                    }}
                  >
                    <span>{item}</span>
                    <span
                      onClick={(e) => handleRemoveHistoryItem(e, item)}
                      style={{
                        color: 'var(--text-tertiary)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '0 2px',
                      }}
                      title={t('titlebar.delete_history_item')}
                    >
                      ×
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="titlebar-right" data-tauri-drag-region>
        {onToggleLanguage && (
          <button
            type="button"
            className="theme-toggle-btn lang-toggle-btn"
            data-tauri-drag-region="false"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={onToggleLanguage}
            title={t('titlebar.lang_toggle_tooltip')}
            aria-label={t('titlebar.lang_toggle_tooltip')}
          >
            <Languages size={13} strokeWidth={1.5} />
            <span>{currentLang.startsWith('en') ? '中文' : 'EN'}</span>
          </button>
        )}

        <button
          className="theme-toggle-btn"
          data-tauri-drag-region="false"
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={onToggleTheme}
          title={t('titlebar.theme_toggle')}
        >
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div className="win-controls" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()}>
          <div className="win-btn" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleMinimize} title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}>
            <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
              <rect width="10" height="1" />
            </svg>
          </div>
          <div className="win-btn" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleMaximize} title={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')} aria-label={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
                <rect x="0.5" y="2.5" width="7" height="7" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            )}
          </div>
          <div className="win-btn close" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleClose} title={t('titlebar.close')} aria-label={t('titlebar.close')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </div>
        </div>
      </div>
    </header>
  );
};
