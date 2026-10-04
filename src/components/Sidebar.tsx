import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { OAuthUser, ViewType } from '../types';
import { api } from '../services/api';
import { GitHubIcon, PlatformIcon } from './icons/PlatformIcons';
import { PLATFORM_IDS, PLATFORM_META, type PlatformId } from '../lib/platformFilter';

interface SidebarProps {
  currentView: ViewType;
  onSelectView: (view: ViewType) => void;
  installedCount: number;
  hasUpdates: boolean;
  onOpenAccount: () => void;
  isCollapsed?: boolean;
  /** 多选设备平台过滤器。空集合为有效状态（渲染空筛选提示界面）。 */
  selectedPlatforms?: Set<PlatformId>;
  /** 仅负责触发切换回调——切换运算逻辑统筹于 lib/platformFilter。 */
  onTogglePlatform?: (id: PlatformId) => void;
  /** 一键恢复全选（ sidebar 头部「全部」按钮用；未传入时回退为逐个补选）。 */
  onResetPlatforms?: () => void;
  /** 可选的各平台应用数量统计；由上层作为属性传入，本组件不自行计算。 */
  platformCounts?: Record<PlatformId, number>;
}

interface NavGroupConfig {
  id: 'discovery' | 'assets' | 'platforms' | 'system';
  i18nKey:
    | 'nav.groups.discovery'
    | 'nav.groups.assets'
    | 'nav.groups.platforms'
    | 'nav.groups.system';
}

interface NavItemConfig {
  id: ViewType;
  label: string;
  groupId: 'discovery' | 'assets' | 'system';
  icon: React.ReactNode;
  badge?: number | boolean;
}

/** 渲染次序。「设备平台」分组位于「偏好与系统」之上。 */
const NAV_GROUPS: ReadonlyArray<NavGroupConfig> = [
  { id: 'discovery', i18nKey: 'nav.groups.discovery' },
  { id: 'assets', i18nKey: 'nav.groups.assets' },
  { id: 'platforms', i18nKey: 'nav.groups.platforms' },
  { id: 'system', i18nKey: 'nav.groups.system' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  installedCount,
  hasUpdates,
  onOpenAccount,
  isCollapsed = false,
  selectedPlatforms = new Set<PlatformId>(PLATFORM_IDS),
  onTogglePlatform = () => {},
  onResetPlatforms,
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
  const { t } = useTranslation();
  const selectedCount = PLATFORM_IDS.filter((id) => selectedPlatforms.has(id)).length;
  const isAllPlatforms = selectedCount === PLATFORM_IDS.length;
  const handleResetPlatforms = () => {
    if (onResetPlatforms) {
      onResetPlatforms();
      return;
    }
    // 兜底：逐个补选未选中的平台（过滤运算仍在 lib/platformFilter 侧）。
    for (const id of PLATFORM_IDS) {
      if (!selectedPlatforms.has(id)) onTogglePlatform(id);
    }
  };
  const navItems: NavItemConfig[] = [
    // 发现与探索
    {
      id: 'home',
      label: t('nav.items.home'),
      groupId: 'discovery',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      id: 'categories',
      label: t('nav.items.categories'),
      groupId: 'discovery',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="7" x="3" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="14" rx="1.5" />
          <rect width="7" height="7" x="3" y="14" rx="1.5" />
        </svg>
      ),
    },
    {
      id: 'trends',
      label: t('nav.items.trends'),
      groupId: 'discovery',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      ),
    },

    // 应用资产
    {
      id: 'installed',
      label: t('nav.items.installed'),
      groupId: 'assets',
      badge: installedCount,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m7.5 4.27 9 5.15" />
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      ),
    },
    {
      id: 'updates',
      label: t('nav.items.updates'),
      groupId: 'assets',
      badge: hasUpdates,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
      ),
    },
    {
      id: 'favorites',
      label: t('nav.items.favorites'),
      groupId: 'assets',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    },

    // 偏好与系统
    {
      id: 'settings',
      label: t('nav.items.settings'),
      groupId: 'system',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
      {NAV_GROUPS.map((group, groupIndex) => (
        <React.Fragment key={group.id}>
          {groupIndex > 0 && <div className="sidebar-divider" />}

          {group.id === 'platforms' ? (
            <>
              <div className="platform-head" title={t('nav.platforms_counts_hint')}>
                <div className="nav-group-title">{t(group.i18nKey)}</div>
                <span className="platform-summary" aria-hidden="true">
                  {selectedCount}/{PLATFORM_IDS.length}
                </span>
                {!isAllPlatforms && (
                  <button
                    type="button"
                    className="platform-reset"
                    onClick={handleResetPlatforms}
                    title={t('nav.platforms_show_all')}
                  >
                    {t('nav.platforms_show_all')}
                  </button>
                )}
              </div>
              <div className="platform-grid" role="group" aria-label={t(group.i18nKey)}>
                {PLATFORM_IDS.map((platformId) => {
                  const isChecked = selectedPlatforms.has(platformId);
                  const count = platformCounts?.[platformId];
                  // OS 名是专有名词无需翻译；虚拟 other 经 i18n 取“其他 / Other”。
                  const label = platformId === 'other' ? t('nav.platforms_other') : PLATFORM_META[platformId].label;
                  return (
                    <button
                      key={platformId}
                      type="button"
                      role="checkbox"
                      aria-checked={isChecked}
                      aria-label={typeof count === 'number' ? `${label} ${count}` : label}
                      data-platform-id={platformId}
                      className={`platform-chip ${isChecked ? 'active' : ''}`}
                      onClick={() => onTogglePlatform(platformId)}
                      title={isCollapsed ? label : typeof count === 'number' ? `${label} · ${count}` : label}
                    >
                      <span className="platform-chip-icon">
                        <PlatformIcon platform={platformId} />
                      </span>
                      {typeof count === 'number' && (
                        <span className="platform-chip-count">{count}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="nav-group-title">{t(group.i18nKey)}</div>
              {navItems
                .filter((item) => item.groupId === group.id)
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

      {/* 底部 GitHub 账号快捷入口胶囊 */}
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
