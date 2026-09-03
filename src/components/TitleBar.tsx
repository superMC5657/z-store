import React, { useEffect, useRef, useState } from 'react';
import { BrandLogo } from './BrandLogo';
import { api } from '../services/api';

interface TitleBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
  isSidebarCollapsed = false,
  onToggleSidebar,
}) => {
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
      // ignore
    }
  };

  useEffect(() => {
    loadSearchHistory();
  }, []);

  // Close dropdown on click outside
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
      // ignore
    }
  };

  const handleRemoveHistoryItem = async (e: React.MouseEvent, item: string) => {
    e.stopPropagation();
    try {
      await api.removeSearchQuery(item);
      setSearchHistory((prev) => prev.filter((x) => x !== item));
    } catch {
      // ignore
    }
  };

  const handleMinimize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // Browser preview mode
    }
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
      setIsMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // Browser preview mode
    }
  };

  const handleClose = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // Browser preview mode
    }
  };

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={handleMaximize}
    >
      <div className="titlebar-left">
        {onToggleSidebar && (
          <button
            className="nav-toggle-btn"
            onClick={onToggleSidebar}
            title={isSidebarCollapsed ? "展开侧边导航栏" : "折叠侧边导航栏"}
            aria-label="切换侧边导航栏"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <div className="app-brand-badge">
          <BrandLogo theme={theme} size={22} />
          <span>Z-Store</span>
          <span
            style={{
              fontSize: '10px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--brand-subtle)',
              color: 'var(--brand-primary)',
              marginLeft: '4px',
            }}
          >
            Fluent 2.0
          </span>
        </div>
      </div>

      <div className="titlebar-center">
        <div className="search-box" ref={searchBoxRef} style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            placeholder="搜索开源应用、别名、GitHub 仓库 (例如: vlc, 远程桌面, rustdesk)..."
          />
          <kbd
            className="search-kbd"
            onClick={() => {
              searchInputRef.current?.focus();
              searchInputRef.current?.select();
            }}
            title="快捷键: Ctrl + K 激活搜索"
          >
            Ctrl K
          </kbd>

          {/* Search History Dropdown Popover */}
          {isDropdownOpen && searchHistory.length > 0 && !localQuery && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                right: 0,
                background: 'var(--bg-acrylic, rgba(30, 30, 30, 0.95))',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                borderRadius: '8px',
                border: '1px solid var(--border-acrylic, rgba(255, 255, 255, 0.12))',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                padding: '10px 14px',
                zIndex: 1000,
                textAlign: 'left',
              }}
            >
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
                <span>🕒 搜索历史</span>
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
                    borderRadius: '4px',
                  }}
                  title="清空所有搜索历史"
                >
                  清空全部
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
                      padding: '4px 10px',
                      borderRadius: '12px',
                      background: 'var(--bg-acrylic-thin, rgba(255, 255, 255, 0.06))',
                      border: '1px solid var(--border-acrylic, rgba(255, 255, 255, 0.08))',
                      fontSize: '12px',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
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
                      title="删除此条记录"
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

      <div className="titlebar-right">
        <button className="theme-toggle-btn" onClick={onToggleTheme} title="切换深色/浅色外观">
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div className="win-controls">
          <div className="win-btn" onClick={handleMinimize} title="最小化" aria-label="最小化">
            <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
              <rect width="10" height="1" />
            </svg>
          </div>
          <div className="win-btn" onClick={handleMaximize} title={isMaximized ? "向下还原" : "最大化"} aria-label={isMaximized ? "向下还原" : "最大化"}>
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
          <div className="win-btn close" onClick={handleClose} title="关闭" aria-label="关闭">
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
