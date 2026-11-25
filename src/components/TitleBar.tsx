import React, { useEffect, useRef, useState } from 'react';
import { Clock, Languages, Moon, Sun, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from './BrandLogo';
import { tauriApi } from '../services/api';
import { closeWindow, minimizeWindow, toggleMaximizeWindow, isWindowMaximized } from '../services/desktop';

interface TitleBarProps {
  searchQuery: string;
  onSearchDraft?: (q: string) => void;
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
  onSearchDraft,
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
  const lastCompositionEndAtRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  const loadSearchHistory = async () => {
    try {
      const history = await tauriApi.getSearchHistory();
      setSearchHistory(history);
    } catch {
      // 忽略错误
    }
  };

  useEffect(() => {
    loadSearchHistory();
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
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

  // 全局快捷键：Ctrl+K 聚焦搜索（弹窗打开时让位给模态焦点陷阱），Escape 取消聚焦并收起下拉
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'Escape') {
        if (document.activeElement === searchInputRef.current) {
          setIsDropdownOpen(false);
          searchInputRef.current?.blur();
        } else if (searchBoxRef.current?.contains(document.activeElement)) {
          setIsDropdownOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleInputChange = (val: string) => {
    setLocalQuery(val);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (!val.trim()) {
      onSearchChange('');
      return;
    }
    // 立即通知上层清空旧在线残留并同步当前输入词，再防抖执行本地检索
    onSearchDraft?.(val);
    // 250ms 防抖响应（纯本地内存搜索，不写/读历史）
    debounceTimerRef.current = setTimeout(() => {
      onSearchChange(val);
    }, 250);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    lastCompositionEndAtRef.current = e.timeStamp;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      if (
        lastCompositionEndAtRef.current !== null &&
        Math.abs(e.timeStamp - lastCompositionEndAtRef.current) < 50
      ) {
        return;
      }
      e.preventDefault();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setIsDropdownOpen(false);
      const query = localQuery.trim();
      // 搜索框回车仅立即执行本地搜索并记录搜索历史，在线搜索由用户在结果页显式点击触发
      onSearchChange(localQuery);
      if (query) {
        tauriApi.recordSearchQuery(query).then(loadSearchHistory).catch(() => {});
      }
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      searchInputRef.current?.blur();
    }
  };

  const handleSelectHistory = (query: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setLocalQuery(query);
    onSearchChange(query);
    setIsDropdownOpen(false);
    tauriApi.recordSearchQuery(query).then(loadSearchHistory).catch(() => {});
  };

  const handleClearHistory = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await tauriApi.clearSearchHistory();
      setSearchHistory([]);
    } catch {
      // 忽略错误
    }
  };

  const handleRemoveHistoryItem = async (e: React.MouseEvent, item: string) => {
    e.stopPropagation();
    try {
      await tauriApi.removeSearchQuery(item);
      setSearchHistory((prev) => prev.filter((x) => x !== item));
    } catch {
      // 忽略错误
    }
  };

  const handleMinimize = async () => {
    try {
      await minimizeWindow();
    } catch {
      // 纯浏览器预览模式
    }
  };

  const handleMaximize = async () => {
    try {
      await toggleMaximizeWindow();
      setIsMaximized(await isWindowMaximized());
    } catch {
      // 纯浏览器预览模式
    }
  };

  const handleClose = async () => {
    try {
      await closeWindow();
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
            type="button"
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
          <span data-tauri-drag-region>ZStore</span>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <div
          className="search-box fluent-input-search"
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
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={handleKeyDown}
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
            title={t('titlebar.search_shortcut_title')}
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
                  fontSize: 'calc(11.5px * var(--font-scale))',
                  color: 'var(--text-tertiary)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <Clock size={12} strokeWidth={1.5} />
                  <span>{t('titlebar.search_history')}</span>
                </span>
                <button
                  type="button"
                  className="btn-fluent btn-ghost btn-sm"
                  onClick={handleClearHistory}
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
                    className="search-history-chip"
                  >
                    <span>{item}</span>
                    <button
                      type="button"
                      className="search-history-chip-remove"
                      onClick={(e) => handleRemoveHistoryItem(e, item)}
                      title={t('titlebar.delete_history_item')}
                      aria-label={t('titlebar.delete_history_item')}
                    >
                      <X size={11} strokeWidth={1.5} />
                    </button>
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
            <span>{currentLang.startsWith('en') ? t('titlebar.lang_target_zh') : 'EN'}</span>
          </button>
        )}

        <button
          type="button"
          className="theme-toggle-btn"
          data-tauri-drag-region="false"
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={onToggleTheme}
          title={t('titlebar.theme_toggle')}
          aria-label={t('titlebar.theme_toggle')}
        >
          {theme === 'dark' ? (
            <Sun size={14} strokeWidth={1.5} />
          ) : (
            <Moon size={14} strokeWidth={1.5} />
          )}
        </button>

        <div className="win-controls" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" className="win-btn" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleMinimize} title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}>
            <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
              <rect width="10" height="1" />
            </svg>
          </button>
          <button type="button" className="win-btn" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleMaximize} title={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')} aria-label={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
                <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
                <rect x="0.5" y="2.5" width="7" height="7" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            )}
          </button>
          <button type="button" className="win-btn close" data-tauri-drag-region="false" onDoubleClick={(e) => e.stopPropagation()} onClick={handleClose} title={t('titlebar.close')} aria-label={t('titlebar.close')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.25">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
};
