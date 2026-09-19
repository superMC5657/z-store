import React, { useEffect, useState } from 'react';
import { OAuthUser, ViewType } from '../types';
import { api } from '../services/api';
import { GitHubIcon, PlatformIcon } from './icons/PlatformIcons';

interface SidebarProps {
  currentView: ViewType;
  onSelectView: (view: ViewType) => void;
  installedCount: number;
  hasUpdates: boolean;
  onOpenAccount: () => void;
  isCollapsed?: boolean;
  /** Multi-select device-platform filter. Defaults to all platforms (no filtering). */
  selectedPlatforms?: Set<string>;
  /** Toggle callback only — the last-one guard lives in App/platformFilter. */
  onTogglePlatform?: (id: string) => void;
  /** Optional per-platform app counts; accepted as prop, never computed here. */
  platformCounts?: Record<string, number>;
}

interface NavItemConfig {
  id: ViewType;
  label: string;
  group: string;
  icon: React.ReactNode;
  badge?: number | boolean;
}

interface PlatformFilterItem {
  id: string;
  label: string;
}

/** Labels mirror CategoriesView platform options. Order mirrors PLATFORM_IDS. */
export const PLATFORM_FILTER_ITEMS: PlatformFilterItem[] = [
  { id: 'windows', label: 'Windows' },
  { id: 'android', label: 'Android' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'ios', label: 'iOS' },
];

/** Render order. 设备平台 sits above 偏好与系统. */
const NAV_GROUP_ORDER = ['发现与探索', '应用资产', '设备平台', '偏好与系统'] as const;

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  installedCount,
  hasUpdates,
  onOpenAccount,
  isCollapsed = false,
  selectedPlatforms = new Set(PLATFORM_FILTER_ITEMS.map((p) => p.id)),
  onTogglePlatform = () => {},
  platformCounts,
}) => {
  const [oauthUser, setOauthUser] = useState<OAuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.getOAuthUser().then((u) => {
        if (!cancelled) setOauthUser(u);
      }).catch(() => {
        if (!cancelled) setOauthUser(null);
      });
    };
    load();
    window.addEventListener('zstore:oauth-changed', load);
    window.addEventListener('zstore:data-imported', load);
    return () => {
      cancelled = true;
      window.removeEventListener('zstore:oauth-changed', load);
      window.removeEventListener('zstore:data-imported', load);
    };
  }, []);
  const navItems: NavItemConfig[] = [
    // 发现与探索
    {
      id: 'home',
      label: '精选发现',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      id: 'trends',
      label: '趋势榜单',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      ),
    },
    {
      id: 'categories',
      label: '分类浏览',
      group: '发现与探索',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="7" x="3" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="14" rx="1.5" />
          <rect width="7" height="7" x="3" y="14" rx="1.5" />
        </svg>
      ),
    },

    // 应用资产
    {
      id: 'installed',
      label: '已安装应用',
      group: '应用资产',
      badge: installedCount,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m7.5 4.27 9 5.15" />
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      ),
    },
    {
      id: 'updates',
      label: '更新中心',
      group: '应用资产',
      badge: hasUpdates,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
      ),
    },
    {
      id: 'favorites',
      label: '我的收藏',
      group: '应用资产',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    },

    // 偏好与系统
    {
      id: 'settings',
      label: '系统设置',
      group: '偏好与系统',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
  ];

  return (
    <aside
      className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}
      role="navigation"
      aria-label="主要导航"
    >
      {NAV_GROUP_ORDER.map((group, groupIndex) => (
        <React.Fragment key={group}>
          {groupIndex > 0 && <div className="sidebar-divider" />}

          {group === '设备平台' ? (
            <>
              <div className="nav-group-title">设备平台</div>
              {PLATFORM_FILTER_ITEMS.map((platform) => {
                const isChecked = selectedPlatforms.has(platform.id);
                const count = platformCounts?.[platform.id];
                return (
                  <button
                    key={platform.id}
                    role="checkbox"
                    aria-checked={isChecked}
                    data-platform-id={platform.id}
                    className={`nav-item ${isChecked ? 'active' : ''}`}
                    onClick={() => onTogglePlatform(platform.id)}
                    title={isCollapsed ? platform.label : undefined}
                  >
                    <span className="nav-icon">
                      <PlatformIcon platform={platform.id} />
                    </span>
                    <span className="nav-label">{platform.label}</span>

                    {typeof count === 'number' && (
                      <span className="nav-badge">{count}</span>
                    )}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              <div className="nav-group-title">{group}</div>
              {navItems
                .filter((item) => item.group === group)
                .map((item) => {
                  const isSelected = currentView === item.id;
                  return (
                    <button
                      key={item.id}
                      className={`nav-item ${isSelected ? 'active' : ''}`}
                      onClick={() => onSelectView(item.id)}
                      title={isCollapsed ? item.label : undefined}
                      aria-label={item.label}
                    >
                      <span className="nav-icon">
                        {item.icon}
                        {typeof item.badge === 'boolean' && item.badge && (
                          <span className="nav-icon-badge-dot" />
                        )}
                      </span>
                      <span className="nav-label">{item.label}</span>

                      {typeof item.badge === 'number' && item.badge > 0 && (
                        <span className="nav-badge">{item.badge}</span>
                      )}
                      {typeof item.badge === 'boolean' && item.badge && (
                        <span className="nav-badge-dot" />
                      )}
                    </button>
                  );
                })}
            </>
          )}
        </React.Fragment>
      ))}

      {/* Bottom GitHub Account Capsule */}
      <div className="sidebar-footer">
        <button
          className="network-pill"
          onClick={onOpenAccount}
          title={
            oauthUser
              ? oauthUser.is_expired
                ? `GitHub 授权已失效: ${oauthUser.login} (点击重新登录)`
                : `GitHub 已登录: ${oauthUser.login} (点击管理)`
              : '登录 GitHub（标星与高配额）'
          }
          aria-label={
            oauthUser
              ? oauthUser.is_expired
                ? `GitHub 授权已失效: ${oauthUser.login}`
                : `GitHub 已登录: ${oauthUser.login}`
              : '登录 GitHub'
          }
          style={oauthUser?.is_expired ? { borderColor: 'rgba(234, 179, 8, 0.4)', background: 'rgba(234, 179, 8, 0.08)' } : undefined}
        >
          {oauthUser ? (
            <>
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                {oauthUser.avatar_url ? (
                  <img
                    src={oauthUser.avatar_url}
                    alt={oauthUser.login}
                    style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      opacity: oauthUser.is_expired ? 0.65 : 1,
                      filter: oauthUser.is_expired ? 'grayscale(50%)' : 'none',
                    }}
                  />
                ) : (
                  <span className="status-dot" />
                )}
                {oauthUser.is_expired && (
                  <span
                    style={{
                      position: 'absolute',
                      right: '-2px',
                      bottom: '-2px',
                      width: '7px',
                      height: '7px',
                      borderRadius: '50%',
                      backgroundColor: '#eab308',
                      border: '1.5px solid var(--bg-primary, #0f172a)',
                    }}
                    title="登录已失效"
                  />
                )}
              </div>
              {!isCollapsed && (
                <span
                  className="network-pill-text"
                  style={{ color: oauthUser.is_expired ? '#eab308' : undefined }}
                >
                  {oauthUser.is_expired
                    ? '登录已失效'
                    : oauthUser.login.length > 14
                    ? `${oauthUser.login.slice(0, 13)}…`
                    : oauthUser.login}
                </span>
              )}
            </>
          ) : (
            <>
              <GitHubIcon size={14} />
              {!isCollapsed && <span className="network-pill-text">GitHub 登录</span>}
            </>
          )}
        </button>
      </div>
    </aside>
  );
};
