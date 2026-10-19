import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  Search,
  Sparkles,
  Play,
  Zap,
  ArrowRight,
  ChevronsDown,
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
import { useOnlinePullToLoadMore } from './HomeView/useOnlinePullToLoadMore';
import { queueAssembledRowIcons, admitIconHit } from '../services/iconStore';
import { isPlatformLoading } from '../lib/platformFilter';
import { annotateIsCataloged, annotateOnlineCataloged, buildCatalogIdSet, isInstalled as selectIsInstalled, mergeLocalLookups, selectIsManagedOpt } from '../app/selectors';
import { resolveVerifiedBadgeVariant } from '../components/VerifiedBadge';
import { normalizeId } from '../services/normalizeId';
import { tauriApi } from '../services/api';
import { moveInToDraft } from '../services/custom/draft';
import { notifyToast } from '../utils/notify';
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
  /**
   * custom 草稿已存在 id 集（归一小写；App 侧以后端 customApps 全量 + 本地乐观移入合成，
   * 即 `selectMergedCatalogApps` 会命中 custom 行的 id 集合）：
   * 供在线段富卡内部移入入口抑制已存在项，缺席即不抑制。
   */
  customIds?: ReadonlySet<string>;
  /**
   * 本地收录全量（App 侧 collectedSummaries：仅 collected 系未归档）：
   * 供本地段/在线段叠加黄标（远端已存在同仓行亦命中，蓝优先）；
   * 缺席即回退目录自带本地行；就绪后经 deps 重标（缺席透传，避免误终态）。
   */
  localApps?: readonly AppSummary[];
}

export const HomeView: React.FC<HomeViewProps> = ({
  apps,
  platformResolvedOtherIds = new Set<string>(),
  installedIds,
  installingIds,
  favoriteIds,
  managedIds = null,
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
  customIds,
  localApps,
}) => {
  const { t } = useTranslation();
  const isSearching = Boolean(searchQuery && searchQuery.trim().length > 0);
  // loading 徽标口径统一经选择器接口.

  // 移入收录（一键 save_custom_app 草稿，status=draft/platforms [] loading）：
  // 经 tauriApi（视图禁直调 invoke，命令表驱动），platforms [] 复用 lite 确认链（缺席即 loading，编辑页可手改）。
  // 入口收进 AppCard 内部操作区（仅未收录 external 行渲染），此处只保留动作实现；
  // useCallback 稳定引用，富卡 memo 不因父渲染失效。
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set<string>());
  const movingRef = useRef<Set<string>>(new Set<string>());
  const handleMoveIn = useCallback(async (app: AppSummary) => {
    const key = app.id;
    if (movingRef.current.has(key)) return;
    movingRef.current.add(key);
    setMovingIds((prev) => new Set(prev).add(key));
    try {
      const res = await moveInToDraft(app);
      if (!res.ok) {
        notifyToast(
          t('custom.move_in_failed', {
            defaultValue: `移入收录失败：${res.error ?? ''}`,
          }),
          'error',
        );
        return;
      }
      notifyToast(
        t('custom.moved_in', { defaultValue: `已移入收录草稿：${res.id}` }),
        'success',
      );
    } finally {
      movingRef.current.delete(key);
      setMovingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [t]);

  // 在线落定处显式标注 is_cataloged（catalog id 集 canonical 比对）。
  // App 侧 useAppSelectors 已标注，此处再守一次（直接渲染 HomeView 的单测/预览同样生效）；
  // 显式标记优先于 category 兜底，已收录在线仍正确隐藏。
  // 本地橘黄：目录用 apps 数组本体（含本地 source，远端优先语义由上游合并保证），
  // 同 id/owner-repo 命中本地叠加 source='local'/status（蓝优先；远端已存在同仓行经显式 localApps 亦命中）。
  // custom 缺席透传，就绪后经 localApps deps 重标（缺席不误终态）。
  const annotatedOnlineApps = React.useMemo(
    () => annotateOnlineCataloged(onlineApps, apps, localApps),
    [onlineApps, apps, localApps],
  );

  // 合并目录基线（远端优先去重语义由上游保证，此处仅搬标记/星数，不重排）。
  const localRowsForMark = React.useMemo(
    () => apps.filter((a) => (a as { source?: unknown }).source === 'local'),
    [apps],
  );
  // 显式本地（含远端已存在同仓的收录行）+ 目录自带本地行统一为 lookup：
  // localApps 缺席即回退目录自带；就绪后重标经 deps 自动。
  const localLookupForMark = React.useMemo(
    () => mergeLocalLookups(localRowsForMark, localApps),
    [localRowsForMark, localApps],
  );
  const catalogIdsForMark = React.useMemo(() => buildCatalogIdSet(apps), [apps]);
  const starsByIdForMark = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of apps) {
      const k = normalizeId(a.id);
      if (k && !m.has(k)) m.set(k, a.stars);
    }
    return m;
  }, [apps]);
  const withLocalAndStars = React.useCallback(
    (r: AppSummary): AppSummary => {
      let next = annotateIsCataloged(r, catalogIdsForMark, localLookupForMark);
      const k = normalizeId(r.id);
      const wantStars = k ? starsByIdForMark.get(k) : undefined;
      if (typeof wantStars === 'number' && next.stars !== wantStars) {
        next = { ...next, stars: wantStars };
      }
      return next;
    },
    [catalogIdsForMark, localLookupForMark, starsByIdForMark],
  );

  // 最近浏览黄标：后端回读无 source/status（仅拼远端 catalog + 详情缓存），此处按当前
  // 合并后 apps（含本地）叠加本地标记（蓝优先、不改排序/去重，仅搬标记供 AppCard 黄标）。
  // 星数以合并目录为准（recent 旧快照 vs 内存值统一为目录值，recent 侧 patch 后同步由 detail 链完成）。
  const annotatedRecentApps = React.useMemo(
    () => recentlyViewedApps.map((r) => withLocalAndStars(r)),
    [recentlyViewedApps, withLocalAndStars],
  );

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

  // 在线段越界续拉：armed 边界条可见 + 滚动到底 + 继续下拉手势才调 handleLoadMore（续 1 页 20 个）。
  // 到底本身不自动拉；加载中/失败中不重复触发，冷静过后可再拉重试。
  const onlineArmedRef = useOnlinePullToLoadMore({
    enabled: onlineActive,
    loading: isSearchingOnline || isLoadingOnlineMore,
    onLoadMore: handleLoadMore,
  });

  // 后端 feed/精选同样叠本地标记（后端 to_summary 无 source/status，前端未叠则黄标丢失）；
  // 星数以合并目录为准；跨段同一 id 精选侧去重（保留最近浏览，精选/feed 滤除，保持相对顺序）。
  const annotatedFeaturedApps = React.useMemo(
    () => featuredApps.map((r) => withLocalAndStars(r)),
    [featuredApps, withLocalAndStars],
  );
  const annotatedDisplayedFeed = React.useMemo(
    () => displayedFeed.map((r) => withLocalAndStars(r)),
    [displayedFeed, withLocalAndStars],
  );
  const recentVisibleIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of annotatedRecentApps.slice(0, 4)) {
      const k = normalizeId(r.id);
      if (k) s.add(k);
    }
    return s;
  }, [annotatedRecentApps]);
  const dedupedFeaturedApps = React.useMemo(
    () => annotatedFeaturedApps.filter((a) => !recentVisibleIds.has(normalizeId(a.id))),
    [annotatedFeaturedApps, recentVisibleIds],
  );
  const dedupedDisplayedFeed = React.useMemo(
    () => annotatedDisplayedFeed.filter((a) => !recentVisibleIds.has(normalizeId(a.id))),
    [annotatedDisplayedFeed, recentVisibleIds],
  );

  // 首开即有标 + 空图标按需拉取：custom 缺席即透传无标（apps 无本地则无标，加载后重标经 deps 自动）；
  // 空 icon 行（recent/精选/feed）触发一次 restoreOrFetchIconCycle（不全量刷，去重防抖）。
  const emptyIconFetchedRef = useRef<Set<string>>(new Set<string>());
  useEffect(() => {
    const candidates: AppSummary[] = [
      ...annotatedRecentApps.slice(0, 4),
      ...dedupedFeaturedApps,
      ...dedupedDisplayedFeed.slice(0, 20),
    ];
    for (const row of candidates) {
      const icon = typeof row.icon === 'string' ? row.icon.trim() : '';
      if (icon !== '') continue;
      const key = normalizeId(row.id);
      if (!key || emptyIconFetchedRef.current.has(key)) continue;
      emptyIconFetchedRef.current.add(key);
      void (async () => {
        try {
          const cycle = await tauriApi.restoreOrFetchIconCycle(row.id);
          const remote = typeof cycle?.remote_url === 'string' ? cycle.remote_url.trim() : '';
          const fallback = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
          const persistUrl =
            remote !== '' ? remote : !fallback.startsWith('data:') && fallback !== '' ? fallback : '';
          if (persistUrl === '' || (!persistUrl.startsWith('http://') && !persistUrl.startsWith('https://'))) return;
          try {
            admitIconHit({ id: row.id, icon: persistUrl });
          } catch {
            // 店内写口失败不阻塞
          }
        } catch {
          // 单行失败不阻塞其余（下次渲染不重试，由详情进入时再治愈）
        }
      })();
    }
  }, [annotatedRecentApps, dedupedFeaturedApps, dedupedDisplayedFeed]);

  // 组装落盘补齐：首页各列表段（置顶/精选/feed/最近浏览/在线段）http 远端图标入队进盘
  //（前 30 上限，`data:`/空跳过；在线段组装侧已入队，此处重入队经店内去重无害）。
  // 空图标行已走上只按需拉取，此处仍只收 http（空行不入队，避免全量刷）。
  useEffect(() => {
    if (heroApp) queueAssembledRowIcons([heroApp]);
    queueAssembledRowIcons(dedupedFeaturedApps);
    queueAssembledRowIcons(dedupedDisplayedFeed);
    if (annotatedRecentApps.length > 0) queueAssembledRowIcons(annotatedRecentApps);
    if (onlineApps.length > 0) queueAssembledRowIcons(onlineApps);
  }, [heroApp, dedupedFeaturedApps, dedupedDisplayedFeed, annotatedRecentApps, onlineApps]);

  // 非搜索态筛选为空才走平台空态；搜索态本地为空但在线有结果时仍进双段展示，
  // 本地段给轻量空提示（两段都空时 App 侧整页空态已拦截，此处兜底同样进双段）。
  // 首页固定 balanced 排序与 seed 7，无策略切换工具条。
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
                className={`btn-fluent ${selectIsInstalled(heroApp.id, installedIds) ? 'btn-secondary' : 'btn-primary'}`}
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
                ) : selectIsInstalled(heroApp.id, installedIds) ? (
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
            {(() => {
              const heroBadge = resolveVerifiedBadgeVariant(
                heroApp as { is_verified?: unknown; source?: unknown; status?: unknown },
              );
              if (heroBadge === 'verified') {
                return (
                  <div className="hero-verified-badge" title={t('home.verified_tooltip')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <polyline points="9 12 11 14 15 10" />
                    </svg>
                    <span>{t('home.verified_badge')}</span>
                  </div>
                );
              }
              if (heroBadge === 'local') {
                return (
                  <div className="hero-verified-badge hero-local-badge" title={t('app.local_badge')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <polyline points="9 12 11 14 15 10" />
                    </svg>
                    <span>{t('app.local_badge')}</span>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>
      )}

      {/* 最近浏览应用（功能 D）：仅在非搜索态（首页）展示，搜索态不展示 */}
      {!isSearching && annotatedRecentApps && annotatedRecentApps.length > 0 && (
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
            {annotatedRecentApps.slice(0, 4).map((app) => (
              <AppCard
                key={app.id}
                app={app}
                platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                isInstalled={selectIsInstalled(app.id, installedIds)}
                isManaged={selectIsManagedOpt(app.id, managedIds)}
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

      {/* 经典精选开源列表：推荐池前 4（hero 已排除，跨段复用最近浏览去重） */}
      {dedupedFeaturedApps.length > 0 && (
        <>
          <div className="section-header">
            <h3 className="section-title">
              <Sparkles size={16} />
              <span>{t('home.classic_featured')}</span>
            </h3>
          </div>
          <div className="app-grid">
            {dedupedFeaturedApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                eager
                platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                isInstalled={selectIsInstalled(app.id, installedIds)}
                isManaged={selectIsManagedOpt(app.id, managedIds)}
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
          {annotatedDisplayedFeed.length > 0 ? (
            <div className="app-grid" data-testid="search-local-grid">
              {annotatedDisplayedFeed.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                  isInstalled={selectIsInstalled(app.id, installedIds)}
                  isManaged={selectIsManagedOpt(app.id, managedIds)}
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
          {annotatedOnlineApps.length > 0 ? (
            <div className="app-grid" data-testid="search-online-grid">
              {annotatedOnlineApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                  isInstalled={selectIsInstalled(app.id, installedIds)}
                  isManaged={selectIsManagedOpt(app.id, managedIds)}
                  isInstalling={installingIds?.has(app.id)}
                  isFavorite={favoriteIds.has(app.id)}
                  isWatched={watchedIds?.has(app.id)}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                  onToggleWatch={onToggleWatch}
                  onMoveInApp={handleMoveIn}
                  isMovingIn={movingIds.has(app.id)}
                  isCustomExisting={customIds?.has(normalizeId(app.id)) ?? false}
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
          {/* 在线段底部哨兵：只续本地段，在线段不触底自动拉（见 useHomeFeed 注释） */}
          <div ref={sentinelRef} data-testid="feed-sentinel" className="feed-sentinel" aria-hidden="true" />
          {onlineActive ? (
            <div
              ref={onlineArmedRef}
              data-testid="online-armed-boundary"
              className="online-armed"
              data-loading={isSearchingOnline || isLoadingOnlineMore ? 'true' : 'false'}
            >
              <div className="online-armed-line">
                <ChevronsDown size={15} aria-hidden="true" />
                <span>
                  {isSearchingOnline || isLoadingOnlineMore
                    ? t('search.online_loading_more', '正在加载下 20 个…')
                    : t('search.online_armed_more', '已到底 · 继续下拉加载更多')}
                </span>
                <ChevronsDown size={15} aria-hidden="true" />
              </div>
              <div className="online-armed-sub">
                {t('search.online_armed_hint', `已加载 ${onlineApps.length} 个 · 每次续拉 20 个`)}
              </div>
              <div className="feed-more-row online-armed-btn">
                <button
                  type="button"
                  data-testid="feed-load-more"
                  className="btn-fluent btn-secondary"
                  onClick={handleLoadMore}
                  disabled={isSearchingOnline || isLoadingOnlineMore}
                >
                  {isSearchingOnline || isLoadingOnlineMore
                    ? t('home.feed_loading', '正在加载…')
                    : t('search.online_load_more', '加载更多在线结果')}
                </button>
              </div>
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

      {/* 推荐 feed：首屏 20，触底自动 +20；只渲染 slice(0, visibleCount)，跨段复用最近浏览去重 */}
      {!isSearching && (feedPoolLength > 0 || dedupedDisplayedFeed.length > 0) && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">
              <Package size={16} />
              <span>{t('home.all_featured')}</span>
            </h3>
          </div>

          <div className="app-grid" data-testid="home-feed-grid">
            {dedupedDisplayedFeed.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                isInstalled={selectIsInstalled(app.id, installedIds)}
                isManaged={selectIsManagedOpt(app.id, managedIds)}
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
            dedupedDisplayedFeed.length > 0 && (
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
