import React from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
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
   * 已由 App 完成平台预过滤（`platformFilteredApps`）：
   * 下方的每个分片均直接基于此数组运行。切勿在页面内重复进行平台过滤——
   * 全局设备平台选择状态由 App/Sidebar 统筹维护。
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
   * 由 App 接驳全局平台重置的扩展点。当未传入时，
   * 重置按钮回退为直接清理持久化存储并在 window 上广播 `zstore:reset-platform-filter`。
   */
  onResetPlatformFilter?: () => void;
}

/**
 * 当 App 尚未接入 `onResetPlatformFilter` 时的兜底重置方案：
 * 清理持久化存储（App 的 `loadSelectedPlatforms` 在缺少键时会回退至全选集合），
 * 并向所有监听器广播重置意图。键名字符串与 App.PLATFORM_FILTER_STORAGE_KEY 一致；
 * 此处保持字面量以避免 view 与 App 之间的循环引用。
 */
function broadcastPlatformReset(): void {
  try {
    window.localStorage.removeItem('zstore:platform-filter:v1');
  } catch {
    // 忽略：存储抛错时保持内存中的选择
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
  const { t } = useTranslation();

  if (apps.length === 0) {
    // 筛选为空：全局设备平台筛选排除了所有应用。
    // 专属文案与重置按钮——绝不复用搜索页的 `owner/repo` 引导文案。
    return (
      <div className="home-view">
        <div className="empty-state-card" style={{ marginTop: '40px' }}>
          <Search size={44} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', marginBottom: '14px' }} />
          <h4 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 600 }}>{t('home.empty_title')}</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '540px', lineHeight: '1.6', margin: '0 auto 16px auto' }}>
            {t('home.empty_desc')}
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
              {t('home.reset_device_filter')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // `apps` 传入时已完成预过滤：置顶优先展示 rustdesk，但仅限在当前结果集内；
  // 当 rustdesk 被过滤掉时，由结果集中的首个应用接替置顶。
  const heroApp = apps.find((a) => a.id === 'rustdesk') || apps[0];
  // 排除已在官方置顶推荐（Hero Banner）中展示的应用，避免在下方精选列表中重复推荐
  const nonHeroApps = heroApp ? apps.filter((a) => a.id !== heroApp.id) : apps;
  const featuredApps = nonHeroApps.slice(0, 4);
  const remainingApps = nonHeroApps.slice(4);

  return (
    <div className="home-view view-entrance">
      {/* 置顶亚克力横幅（PRD 5.1 与第 3 节规范） */}
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
                <span>{t('home.hero_tag_featured')}</span>
              </span>
              <span>·</span>
              <span>{t('home.hero_tag_cross_platform')}</span>
            </div>

            <h2 className="hero-title">
              {heroApp.id === 'rustdesk/rustdesk' || heroApp.id === 'rustdesk'
                ? `${heroApp.name} · ${t('home.rustdesk_subtitle')}`
                : `${heroApp.name} · ${heroApp.category_name}`}
            </h2>

            <p className="hero-desc">
              {heroApp.description}
            </p>

            {/* 元信息标签 */}
            <div className="hero-tags">
              <span className="app-tag app-tag-star">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>{(heroApp.stars / 1000).toFixed(1)}k Stars</span>
              </span>
              <span className="app-tag app-tag-license">{heroApp.license} {t('home.license_suffix')}</span>
              <span className="app-tag">{heroApp.category_name}</span>
              {(heroApp.id === 'rustdesk/rustdesk' || heroApp.id === 'rustdesk') && (
                <span className="app-tag">{t('home.rustdesk_tag')}</span>
              )}
            </div>

            {/* 操作按钮组 */}
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
                    <span>{t('app.installing')}</span>
                  </span>
                ) : installedIds.has(heroApp.id) ? (
                  <>
                    <Play size={14} />
                    <span>{t('home.ready_open')}</span>
                  </>
                ) : (
                  <>
                    <Zap size={14} />
                    <span>{t('app.install')}</span>
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
                <span>{t('home.explore_trends')}</span>
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
            {Boolean(heroApp.is_verified) && (
              <div className="hero-verified-badge" title={t('home.verified_tooltip')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 11 14 15 10" />
                </svg>
                <span>{t('home.verified_badge')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 最近浏览应用（功能 D） */}
      {recentlyViewedApps && recentlyViewedApps.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="section-title">
              <Clock size={16} />
              <span>{t('home.recent_views')}</span>
            </h3>
            {onClearRecentViews && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={onClearRecentViews}
              >
                <Trash2 size={11} />
                <span>{t('home.clear_recent')}</span>
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

      {/* 经典精选开源列表 */}
      {featuredApps.length > 0 && (
        <>
          <div className="section-header">
            <h3 className="section-title">
              <Sparkles size={16} />
              <span>{t('home.classic_featured')}</span>
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

      {/* 全部精选开源收录列表 */}
      {remainingApps.length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">
              <Package size={16} />
              <span>{t('home.all_featured')}</span>
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
