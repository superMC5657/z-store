import React, { useEffect, useRef, useState } from 'react';
import { BrandLogo } from './BrandLogo';
import { api } from '../services/api';
import { HostTokenEntry } from '../types';

interface TitleBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNavigateSettings?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
  isSidebarCollapsed = false,
  onToggleSidebar,
  onNavigateSettings,
}) => {
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [isMaximized, setIsMaximized] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [hostTokens, setHostTokens] = useState<HostTokenEntry[]>([]);
  const [showQuotaTooltip, setShowQuotaTooltip] = useState(false);
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

  const loadQuota = async () => {
    try {
      const tokens = await api.getHostTokens();
      setHostTokens(tokens);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadSearchHistory();
    loadQuota();
    const timer = setInterval(loadQuota, 30000);
    const handleQuotaChanged = () => loadQuota();
    window.addEventListener('zstore:quota-updated', handleQuotaChanged);

    let isMounted = true;
    let unlistenFn: (() => void) | null = null;
    api.onQuotaUpdated((payload) => {
      if (!isMounted) return;
      setHostTokens((prev) => {
        const cleanHost = payload.host.toLowerCase();
        const idx = prev.findIndex((t) => t.host.toLowerCase() === cleanHost);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = {
            ...copy[idx],
            rate_limit_remaining: payload.rate_limit_remaining,
            rate_limit_limit: payload.rate_limit_limit,
            rate_limit_reset: payload.rate_limit_reset,
            updated_at: Math.floor(Date.now() / 1000),
          };
          return copy;
        } else {
          return [
            ...prev,
            {
              host: payload.host,
              token: '',
              rate_limit_remaining: payload.rate_limit_remaining,
              rate_limit_limit: payload.rate_limit_limit,
              rate_limit_reset: payload.rate_limit_reset,
              updated_at: Math.floor(Date.now() / 1000),
            },
          ];
        }
      });
    }).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      isMounted = false;
      clearInterval(timer);
      window.removeEventListener('zstore:quota-updated', handleQuotaChanged);
      if (unlistenFn) {
        unlistenFn();
      }
    };
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
                background: 'var(--bg-surface-flyout)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-highlight)',
                boxShadow: 'var(--shadow-modal), 0 0 20px rgba(0, 0, 0, 0.25)',
                padding: '12px 14px',
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
        {/* Rate Limit Indicator Pill (Feature E) */}
        {(() => {
          const ghEntry = hostTokens.find((t) => t.host.toLowerCase() === 'github.com');
          const hasRemaining =
            ghEntry?.rate_limit_remaining !== undefined && ghEntry?.rate_limit_remaining !== null;
          const remaining = ghEntry?.rate_limit_remaining ?? 0;
          const limit = ghEntry?.rate_limit_limit ?? (ghEntry?.token ? 5000 : 60);
          const isConfigured = !!ghEntry?.token;

          let pillDot = '🟢';
          let pillColor = '#10b981';
          let pillBg = 'rgba(16, 185, 129, 0.12)';
          let pillBorder = 'rgba(16, 185, 129, 0.28)';
          let pillText = hasRemaining ? `API ${remaining}/${limit}` : 'API 探测中...';

          if (!hasRemaining) {
            pillDot = '⚪';
            pillColor = 'var(--text-tertiary)';
            pillBg = 'rgba(255, 255, 255, 0.05)';
            pillBorder = 'var(--border-subtle)';
          } else if (remaining <= 0) {
            pillDot = '🔴';
            pillColor = '#ef4444';
            pillBg = 'rgba(239, 68, 68, 0.12)';
            pillBorder = 'rgba(239, 68, 68, 0.28)';
            pillText = 'API 耗尽';
          } else if (limit <= 100 ? remaining <= 10 : remaining <= 100) {
            pillDot = '🟡';
            pillColor = '#f59e0b';
            pillBg = 'rgba(245, 158, 11, 0.12)';
            pillBorder = 'rgba(245, 158, 11, 0.28)';
            pillText = `API ${remaining}/${limit}`;
          }

          const resetTimeStr = ghEntry?.rate_limit_reset
            ? new Date(ghEntry.rate_limit_reset * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            : null;

          return (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={onNavigateSettings}
                onMouseEnter={() => setShowQuotaTooltip(true)}
                onMouseLeave={() => setShowQuotaTooltip(false)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: onNavigateSettings ? 'pointer' : 'default',
                  background: pillBg,
                  border: `1px solid ${pillBorder}`,
                  color: pillColor,
                  outline: 'none',
                  transition: 'all 0.15s ease',
                }}
                title="点击前往设置中心配置 API 密钥"
              >
                <span>{pillDot}</span>
                <span>{pillText}</span>
              </button>

              {showQuotaTooltip && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: '240px',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-surface-flyout)',
                    border: '1px solid var(--border-highlight)',
                    boxShadow: 'var(--shadow-modal), 0 0 24px rgba(0, 0, 0, 0.3)',
                    zIndex: 1000,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    fontSize: '12px',
                    backdropFilter: 'blur(28px) saturate(180%)',
                    WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                    pointerEvents: 'none',
                  }}
                >
                  <div style={{ fontWeight: 600, borderBottom: '1px solid var(--border-acrylic)', paddingBottom: '4px' }}>
                    🌐 API 速率配额感知
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                    <span>GitHub:</span>
                    <span style={{ fontWeight: 500, color: pillColor }}>
                      {hasRemaining ? `${remaining} / ${limit}` : '探测中...'}
                    </span>
                  </div>
                  {resetTimeStr && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-tertiary)', fontSize: '11px' }}>
                      <span>配额重置时间:</span>
                      <span>{resetTimeStr}</span>
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                    {isConfigured ? '已配置个人 PAT (配额 5000/h)' : '未配置 PAT (公共 IP 限流 60/h)'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--brand-primary)', marginTop: '4px' }}>
                    💡 点击前往设置配置令牌
                  </div>
                </div>
              )}
            </div>
          );
        })()}

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
