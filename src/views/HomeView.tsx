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
  Globe,
} from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { AppIcon } from '../components/AppIcon';
import { AppSummary } from '../types';
import {
  FilterEmptyState,
  PlatformResetOption,
  ViewAppActions,
  ViewShell,
  resolvePlatformReset,
} from './ViewShell';
import type { FeedStrategy } from '../services/feed';
import { useHomeFeed, HOME_FEED_PAGE } from './HomeView/useHomeFeed';
export { HOME_FEED_PAGE };

interface HomeViewProps extends ViewAppActions, PlatformResetOption {
  /**
   * 已由 App 完成平台预过滤（`platformFilteredApps`）：
   * 下方的每个分片均直接基于此数组运行。切勿在页面内重复进行平台过滤——
   * 全局设备平台选择状态由 App/Sidebar 统筹维护。
   */
  platformResolvedOtherIds?: ReadonlySet<string>;
  recentlyViewedApps?: AppSummary[];
  searchQuery?: string;
  onNavigateTrends: () => void;
  onClearRecentViews?: () => void;
  /** 推荐策略（默认 balanced），变化时 feed 从头重置。 */
  initialStrategy?: FeedStrategy;
  /** 确定性种子（默认 7），“换一批”即 +1，保证同 seed 同顺序。 */
  initialSeed?: number;
  /** 搜索在线结果集标记：true 表示当前查询的在线段有结果（apps 本身永远是本地结果）。 */
  isOnlineResults?: boolean;
  /** 搜索在线段（App 已做平台过滤，保序）：搜索态渲染在本地段下方，复用同一 AppCard。 */
  onlineApps?: AppSummary[];
  /** 正在在线搜索（在线段展示加载提示，首屏与翻页共用）。 */
  isSearchingOnline?: boolean;
  /** 已发起过在线搜索（在线段空时区分“还没搜”与“搜过无结果”）。 */
  onlineSearchPerformed?: boolean;
  /** 在线搜索是否还有下一页（后端满页/has_more 时为 true，到底后为 false）。 */
  onlineHasMore?: boolean;
  /** 在线下一页加载中（禁用重复触发，与后端 loading 同等对待）。 */
  isLoadingOnlineMore?: boolean;
  /** 在线结果触底回调：App 负责 page+1 并拼接到 apps，失败/限流由 App toast。 */
  onOnlineLoadMore?: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  apps,
  platformResolvedOtherIds,
  installedIds,
  installingIds,
  favoriteIds,
  recentlyViewedApps = [],
  searchQuery = '',
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  watchedIds,
  onToggleWatch,
  onNavigateTrends,
  onClearRecentViews,
  onResetPlatformFilter,
  isOnlineResults = false,
  onlineApps = [],
  isSearchingOnline = false,
  onlineSearchPerformed = false,
  onlineHasMore = false,
  isLoadingOnlineMore = false,
  onOnlineLoadMore,
}) => {
  const { t } = useTranslation();
  const isSearching = Boolean(searchQuery && searchQuery.trim().length > 0);
  const isPending = (a: AppSummary): boolean => {
    if (a.platforms && a.platforms.length > 0) return false;
    if (!platformResolvedOtherIds) return false;
    return !platformResolvedOtherIds.has(a.id.toLowerCase());
  };

  // ---- feed 状态与分页 Hook -------------------------------------
  const {
    heroApp,
    heroDisplayName,
    heroDisplayDesc,
    heroCategoryName,
    featuredApps,
    displayedFeed,
    hasMore,
    localHasMore,
    onlineActive,
    backendLoading,
    backendTotal,
    useBackendList,
    feedPoolLength,
    handleLoadMore,
    sentinelRef,
    setVisibleCount,
  } = useHomeFeed({
    apps,
    searchQuery,
    isOnlineResults,
    onlineHasMore,
    isLoadingOnlineMore,
    onOnlineLoadMore,
  });

  // 非搜索态筛选为空才走平台空态；搜索态本地为空但在线有结果时仍进双段展示，
  // 本地段给轻量空提示（两段都空时 App 侧整页空态已拦截，此处兜底同样进双段）。
  // 合并取舍：lane 的 handleShuffle/strategyLabel 未保留——HEAD 已固定策略并砍掉切换工具条，
  // 此处无 setSeed、无调用方，保留即编译不过；固定 balanced + seed=7 口径不变。
  if (apps.length === 0 && !isSearching) {
    // 筛选为空：全局设备平台筛选排除了所有应用。
    // 专属文案与重置按钮——绝不复用搜索页的 `owner/repo` 引导文案。
    return (
      <ViewShell viewClass="home-view">
        <FilterEmptyState
          style={{ marginTop: '40px' }}
          icon={<Search size={40} strokeWidth={1.5} />}
          title={t('home.empty_title')}
          description={t('home.empty_desc')}
          resetLabel={t('home.reset_device_filter')}
          onReset={resolvePlatformReset(onResetPlatformFilter)}
        />
      </ViewShell>
    );
  }

  return (
    <ViewShell viewClass="home-view">
      {/* 置顶推荐横幅（Linear 去彩单色展台） */}
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
              {heroApp.id === 'rustdesk/rustdesk'
                ? `${heroDisplayName} · ${t('home.rustdesk_subtitle')}`
                : `${heroDisplayName} · ${heroCategoryName}`}
            </h2>

            <p className="hero-desc">
              {heroDisplayDesc}
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
              <span className="app-tag">{heroCategoryName}</span>
              {heroApp.id === 'rustdesk/rustdesk' && (
                <span className="app-tag">{t('home.rustdesk_tag')}</span>
              )}
            </div>

            {/* 操作按钮组 */}
            <div className="hero-actions">
              <button
                className={`btn-fluent ${installedIds.has(heroApp.id) ? 'btn-secondary' : 'btn-primary'}`}
                style={{ padding: '8px 20px', fontSize: 'var(--font-base)', fontWeight: 510, display: 'inline-flex', alignItems: 'center', gap: '6px' }}
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
                style={{ padding: '9px 18px', fontSize: 'calc(13.5px * var(--font-scale))', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
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
                name={heroDisplayName}
                appId={heroApp.id}
                iconBg={heroApp.icon_bg}
                style={{ width: '100%', height: '100%', borderRadius: 'inherit' }}
                loading="eager"
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

      {/* 最近浏览应用（功能 D）：仅在非搜索态（首页）展示，搜索态不展示 */}
      {!isSearching && recentlyViewedApps && recentlyViewedApps.length > 0 && (
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
                style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}
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
                platformPending={isPending(app)}
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

      {/* 经典精选开源列表：推荐池前 4（hero 已排除） */}
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
                eager
                platformPending={isPending(app)}
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

      {/* 搜索态上下分段：本地在上、在线在下，分组头标明来源和数量，列表复用同一 AppCard */}
      {isSearching && (
        <>
          <div className="section-header" data-testid="search-local-section">
            <h3 className="section-title">
              <Package size={16} />
              <span>{t('search.local_results', `本地结果 (${apps.length})`)}</span>
            </h3>
          </div>
          {displayedFeed.length > 0 ? (
            <div className="app-grid" data-testid="search-local-grid">
              {displayedFeed.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  platformPending={isPending(app)}
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
          ) : (
            <div className="feed-end" data-testid="search-local-empty">
              {t('search.local_empty', '本地没有找到匹配应用')}
            </div>
          )}
          {localHasMore && (
            <div className="feed-more-row">
              <button
                type="button"
                data-testid="search-local-load-more"
                className="btn-fluent btn-secondary"
                onClick={() => setVisibleCount((c) => c + HOME_FEED_PAGE)}
              >
                {t('search.local_load_more', '加载更多本地结果')}
              </button>
            </div>
          )}

          <div className="section-header" style={{ marginTop: '28px' }} data-testid="search-online-section">
            <h3 className="section-title">
              <Globe size={16} />
              <span>{t('search.online_results', `在线结果 (${onlineApps.length})`)}</span>
            </h3>
          </div>
          {onlineApps.length > 0 ? (
            <div className="app-grid" data-testid="search-online-grid">
              {onlineApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  platformPending={isPending(app)}
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
          ) : (
            <div className="feed-end" data-testid="search-online-empty">
              {isSearchingOnline
                ? t('search.online_searching', '正在在线搜索…')
                : onlineSearchPerformed
                  ? t('search.online_empty', '没有找到相关在线应用，已保留本地结果')
                  : t('search.online_prompt', '按回车发起在线搜索，在这里看云端结果')}
            </div>
          )}
          {(isSearchingOnline || isLoadingOnlineMore) && (
            <div className="app-grid" data-testid="feed-skeleton" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="app-card feed-skeleton-card">
                  <div className="skeleton-box feed-skeleton-icon" />
                  <div className="feed-skeleton-lines">
                    <div className="skeleton-box feed-skeleton-line-main" />
                    <div className="skeleton-box feed-skeleton-line-sub" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* 在线段底部哨兵：触底自动 page+1 追加到在线段；不可用时靠下方按钮兜底 */}
          <div ref={sentinelRef} data-testid="feed-sentinel" className="feed-sentinel" aria-hidden="true" />
          {onlineActive ? (
            <div className="feed-more-row">
              <button
                type="button"
                data-testid="feed-load-more"
                className="btn-fluent btn-secondary"
                onClick={handleLoadMore}
                disabled={isLoadingOnlineMore}
              >
                {isLoadingOnlineMore
                  ? t('home.feed_loading', '正在加载…')
                  : t('search.online_load_more', '加载更多在线结果')}
              </button>
            </div>
          ) : (
            onlineApps.length > 0 && !onlineHasMore && (
              <div data-testid="feed-end" className="feed-end">
                {t('search.online_end', `到底了 · 在线共 ${onlineApps.length} 个`)}
              </div>
            )
          )}
        </>
      )}

      {/* 推荐 feed：首屏 20，触底自动 +20；只渲染 slice(0, visibleCount) */}
      {!isSearching && (feedPoolLength > 0 || displayedFeed.length > 0) && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">
              <Package size={16} />
              <span>{t('home.all_featured')}</span>
            </h3>
          </div>

          <div className="app-grid" data-testid="home-feed-grid">
            {displayedFeed.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                platformPending={isPending(app)}
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

          {(backendLoading || isLoadingOnlineMore) && (
            <div className="app-grid" data-testid="feed-skeleton" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="app-card feed-skeleton-card">
                  <div className="skeleton-box feed-skeleton-icon" />
                  <div className="feed-skeleton-lines">
                    <div className="skeleton-box feed-skeleton-line-main" />
                    <div className="skeleton-box feed-skeleton-line-sub" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 底部哨兵：进入视口自动续刷，不可用时靠下方按钮兜底 */}
          <div ref={sentinelRef} data-testid="feed-sentinel" className="feed-sentinel" aria-hidden="true" />

          {hasMore ? (
            <div className="feed-more-row">
              <button
                type="button"
                data-testid="feed-load-more"
                className="btn-fluent btn-secondary"
                onClick={handleLoadMore}
                disabled={backendLoading || isLoadingOnlineMore}
              >
                {backendLoading || isLoadingOnlineMore
                  ? t('home.feed_loading', '正在加载…')
                  : t('home.feed_load_more', '加载更多')}
              </button>
            </div>
          ) : (
            displayedFeed.length > 0 && (
              <div data-testid="feed-end" className="feed-end">
                {useBackendList && backendTotal !== null
                  ? t('home.feed_end_backend', `到底了 · 后端共 ${backendTotal} 个`)
                  : t('home.feed_end', `到底了 · 共 ${feedPoolLength} 个推荐`)}
              </div>
            )
          )}
        </>
      )}
    </ViewShell>
  );
};
