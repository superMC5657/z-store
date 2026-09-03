import React from 'react';
import { BrandLogo } from './BrandLogo';

interface TitleBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
}) => {
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
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
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
        <div className="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索开源应用、别名、GitHub 仓库 (例如: vlc, 远程桌面, rustdesk)..."
          />
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
          <div className="win-btn" onClick={handleMinimize} title="最小化">─</div>
          <div className="win-btn" onClick={handleMaximize} title="最大化">□</div>
          <div className="win-btn close" onClick={handleClose} title="关闭">✕</div>
        </div>
      </div>
    </header>
  );
};
