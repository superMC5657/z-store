import React from 'react';
import {
  Search,
  Sparkles,
  Play,
  Zap,
  ArrowRight,
  Clock,
  Trash2,
  Package,
} from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { AppIcon } from '../components/AppIcon';
import { AppSummary } from '../types';

interface HomeViewProps {
  /**
   * Already platform-filtered by App (`platformFilteredApps`): every slice
   * below executes on this array as-is. Never filter by platform in-page —
   * the global device-platform selection lives in App/Sidebar.
   */
  apps: AppSummary[];
  installedIds: Set<string>;
  installingIds?: Set<string>;
  favoriteIds: Set<string>;
  recentlyViewedApps?: AppSummary[];
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  watchedIds?: Set<string>;
  onToggleWatch?: (id: string) => void;
  onNavigateTrends: () => void;
  onClearRecentViews?: () => void;
  /**
   * Seam for App to wire the global platform reset (Todo 7). When omitted,
   * the reset button falls back to clearing the persisted selection and
   * broadcasting `zstore:reset-platform-filter` on window.
   */
  onResetPlatformFilter?: () => void;
}

/**
 * Fallback reset when App has not wired `onResetPlatformFilter` yet:
 * drop the persisted selection (App's `loadSelectedPlatforms` falls back to
 * the full set on a missing key) and broadcast the intent for any listener.
 * Key string mirrors App.PLATFORM_FILTER_STORAGE_KEY; kept literal here to
 * avoid a view→App import cycle.
 */
function broadcastPlatformReset(): void {
  try {
    window.localStorage.removeItem('zstore:platform-filter:v1');
  } catch {
    // ignore: throwing storage keeps the in-memory selection
  }
  window.dispatchEvent(new CustomEvent('zstore:reset-platform-filter'));
}

export const HomeView: React.FC<HomeViewProps> = ({
  apps,
  installedIds,
  installingIds,
  favoriteIds,
  recentlyViewedApps = [],
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  watchedIds,
  onToggleWatch,
  onNavigateTrends,
  onClearRecentViews,
  onResetPlatformFilter,
}) => {
  if (apps.length === 0) {
    // Filter-empty: the global device-platform selection excluded every app.
    // Dedicated copy + reset affordance — never the search `owner/repo` guide.
    return (
      <div className="home-view">
        <div className="empty-state-card" style={{ marginTop: '40px' }}>
          <Search size={44} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', marginBottom: '14px' }} />
          <h4 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 600 }}>当前设备筛选下暂无收录应用</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '540px', lineHeight: '1.6', margin: '0 auto 16px auto' }}>
            侧栏「设备平台」中所选设备组合没有命中任何收录应用。放宽勾选项，或一键恢复全部设备后即可继续浏览精选。
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn-fluent btn-primary filter-empty-reset"
              onClick={() => {
                if (onResetPlatformFilter) {
                  onResetPlatformFilter();
                } else {
                  broadcastPlatformReset();
                }
              }}
            >
              重置设备筛选
            </button>
          </div>
        </div>
      </div>
    );
  }

  // `apps` arrives pre-filtered: hero prefers rustdesk but only within the
  // set — when rustdesk was filtered out, the first remaining app takes over.
  const heroApp = apps.find((a) => a.id === 'rustdesk') || apps[0];
  // 排除已在官方置顶推荐（Hero Banner）中展示的应用，避免在下方精选列表中重复推荐
  const nonHeroApps = heroApp ? apps.filter((a) => a.id !== heroApp.id) : apps;
  const featuredApps = nonHeroApps.slice(0, 4);
  const remainingApps = nonHeroApps.slice(4);

  return (
    <div className="home-view view-entrance">
      {/* Hero Acrylic Banner (PRD 5.1 & Section 3) */}
      {heroApp && (
        <div
          className="hero-banner"
          onClick={() => onOpenDetail(heroApp.id)}
          role="banner"
          tabIndex={0}
        >
          <div className="hero-content">
            <div className="hero-tag">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Sparkles size={12} style={{ color: '#eab308' }} />
                <span>本周编辑精选推荐</span>
              </span>
              <span>·</span>
              <span>跨平台开源精选</span>
            </div>

            <h2 className="hero-title">
              {heroApp.id === 'rustdesk/rustdesk' || heroApp.id === 'rustdesk'
                ? `${heroApp.name} · 安全流畅的开源远程桌面`
                : `${heroApp.name} · ${heroApp.category_name}`}
            </h2>

            <p className="hero-desc">
              {heroApp.description}
            </p>

            {/* Meta Tags */}
            <div className="hero-tags">
              <span className="app-tag app-tag-star">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>{(heroApp.stars / 1000).toFixed(1)}k Stars</span>
              </span>
              <span className="app-tag app-tag-license">{heroApp.license} 协议</span>
              <span className="app-tag">{heroApp.category_name}</span>
              {(heroApp.id === 'rustdesk/rustdesk' || heroApp.id === 'rustdesk') && (
                <span className="app-tag">自建中继 · 端到端加密</span>
              )}
            </div>

            {/* Actions */}
            <div className="hero-actions">
              <button
                className={`btn-fluent ${installedIds.has(heroApp.id) ? 'btn-secondary' : 'btn-primary'}`}
                style={{ padding: '9px 22px', fontSize: '13.5px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                disabled={installingIds?.has(heroApp.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickInstall(heroApp.id);
                }}
              >
                {installingIds?.has(heroApp.id) ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span className="spinner-icon" style={{ width: '12px', height: '12px', borderWidth: '1.5px' }} />
                    <span>正在安装...</span>
                  </span>
                ) : installedIds.has(heroApp.id) ? (
                  <>
                    <Play size={14} />
                    <span>已就绪 · 打开</span>
                  </>
                ) : (
                  <>
                    <Zap size={14} />
                    <span>安装</span>
                  </>
                )}
              </button>
              <button
                className="btn-fluent btn-secondary"
                style={{ padding: '9px 18px', fontSize: '13.5px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigateTrends();
                }}
              >
                <span>探索飙升热榜</span>
                <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <div className="hero-visual">
            <div className="hero-icon-card">
              <AppIcon
                icon={heroApp.icon}
                name={heroApp.name}
                appId={heroApp.id}
                iconBg={heroApp.icon_bg}
                style={{ width: '100%', height: '100%', borderRadius: 'inherit' }}
              />
            </div>
            <div className="hero-verified-badge" title="该开源项目已通过官方仓库认证">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <polyline points="9 12 11 14 15 10" />
              </svg>
              <span>官方认证 · Verified</span>
            </div>
          </div>
        </div>
      )}

      {/* Recently Viewed Apps (Feature D) */}
      {recentlyViewedApps && recentlyViewedApps.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="section-title">
              <Clock size={16} />
              <span>最近浏览</span>
            </h3>
            {onClearRecentViews && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={onClearRecentViews}
              >
                <Trash2 size={11} />
                <span>清空记录</span>
              </button>
            )}
          </div>
          <div className="app-grid">
            {recentlyViewedApps.slice(0, 4).map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIds.has(app.id)}
                isWatched={watchedIds?.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        </div>
      )}

      {/* Featured Grid */}
      {featuredApps.length > 0 && (
        <>
          <div className="section-header">
            <h3 className="section-title">
              <Sparkles size={16} />
              <span>经典精选开源软件</span>
            </h3>
          </div>
          <div className="app-grid">
            {featuredApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIds.has(app.id)}
                isWatched={watchedIds?.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        </>
      )}

      {/* Discover All Grid */}
      {remainingApps.length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">
              <Package size={16} />
              <span>全部精选开源收录</span>
            </h3>
          </div>
          <div className="app-grid">
            {remainingApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIds.has(app.id)}
                isWatched={watchedIds?.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
