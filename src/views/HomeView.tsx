import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Shuffle,
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
import { getAppDisplayName, getAppDescription, getCategoryLabel } from '../utils/appHelper';
/**
 * B3-G12 收敛：View 层经 services/api 的 tauriApi 拿后端 feed。
 * 用命名空间导入 + 运行时守卫（而非具名直引），避免 App 系测试对
 * services/api 的局部 mock 缺少新导出时炸掉整个 HomeView 模块。
 */
import * as apiModule from '../services/api';
import { rankFeed, resolveHero, sliceFeed, type FeedStrategy } from '../services/feed';

type HomeFeedPage = {
  items: AppSummary[];
  total: number;
  has_more: boolean;
};

const apiMod = apiModule as unknown as {
  tauriApi?: {
    getHomeFeed?: (limit: number, offset: number, seed?: number, strategy?: string) => Promise<HomeFeedPage>;
  };
  isTauri?: boolean;
};

/**
 * 安全读取 api 模块字段：App 系测试用局部 mock 替换了 services/api 且只提供
 * `api`/`DEFAULT_SETTINGS`，直接点取缺失导出会同步抛错——此处一律 try/catch
 * 吞掉并视为“后端不可用”，走本地 rankFeed 兜底。
 */
function readIsTauriFlag(): boolean | undefined {
  try {
    return apiMod.isTauri;
  } catch {
    return undefined;
  }
}

function readHomeFeedFn():
  | ((limit: number, offset: number, seed?: number, strategy?: string) => Promise<HomeFeedPage>)
  | undefined {
  try {
    const t = apiMod.tauriApi;
    if (t && typeof t.getHomeFeed === 'function') return t.getHomeFeed.bind(t);
    return undefined;
  } catch {
    return undefined;
  }
}

/** 是否可走后端 feed：优先 api 模块标记，缺失时看 TAURI 桥是否存在。 */
function canUseHomeFeedBackend(): boolean {
  const flag = readIsTauriFlag();
  if (flag === true) return true;
  if (flag === false) return false;
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
}

/** 后端优先取一页；命令不存在/模块被 mock 掉时抛错，调用方回退本地。 */
async function fetchHomeFeedPage(limit: number, offset: number, seed: number, strategy?: string): Promise<HomeFeedPage> {
  const fn = readHomeFeedFn();
  if (typeof fn !== 'function') throw new Error('home feed backend unavailable');
  const raw = (await fn(limit, offset, seed, strategy)) as unknown as {
    items?: unknown;
    total?: unknown;
    has_more?: unknown;
    hasMore?: unknown;
  };
  const items = Array.isArray(raw?.items) ? (raw.items as AppSummary[]) : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  const more = (raw?.has_more ?? raw?.hasMore) as unknown;
  return { items, total, has_more: more === true };
}

/** Feed 每次续刷的页大小：首屏 20，触底再 +20。 */
export const HOME_FEED_PAGE = 20;
/** 首页 1 次请求补偿 hero(1)+featured(4)，保证首屏 feed 能填满 20。 */
const FIRST_PAGE_LIMIT = HOME_FEED_PAGE + 5;

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
  /** 搜索在线结果集标记：true 表示当前 apps 来自在线搜索（本地为 0 后调在线第 1 页）。 */
  isOnlineResults?: boolean;
  /** 在线搜索是否还有下一页（后端满页/has_more 时为 true，到底后为 false）。 */
  onlineHasMore?: boolean;
  /** 在线下一页加载中（禁用重复触发，与后端 loading 同等对待）。 */
  isLoadingOnlineMore?: boolean;
  /** 在线结果触底回调：App 负责 page+1 并拼接到 apps，失败/限流由 App toast。 */
  onOnlineLoadMore?: () => void;
}

const STRATEGIES: FeedStrategy[] = ['balanced', 'stars', 'fresh'];

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
  initialStrategy = 'balanced',
  initialSeed = 7,
  isOnlineResults = false,
  onlineHasMore = false,
  isLoadingOnlineMore = false,
  onOnlineLoadMore,
}) => {
  const { t, i18n } = useTranslation();
  const isSearching = Boolean(searchQuery && searchQuery.trim().length > 0);
  const isPending = (a: AppSummary): boolean => {
    if (a.platforms && a.platforms.length > 0) return false;
    if (!platformResolvedOtherIds) return false;
    return !platformResolvedOtherIds.has(a.id.toLowerCase());
  };

  // ---- feed 状态：策略/种子/可见数 -----------------------------------------
  const [strategy, setStrategy] = useState<FeedStrategy>(initialStrategy);
  const [seed, setSeed] = useState<number>(initialSeed);
  const [visibleCount, setVisibleCount] = useState(HOME_FEED_PAGE);

  // 后端分页状态：成功即走后端 order，失败（命令不存在/非 Tauri）即本地 fallback。
  const [backendItems, setBackendItems] = useState<AppSummary[]>([]);
  const [backendHasMore, setBackendHasMore] = useState(false);
  const [backendTotal, setBackendTotal] = useState<number | null>(null);
  const [backendActive, setBackendActive] = useState(false);
  const [backendLoading, setBackendLoading] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  loadingRef.current = backendLoading || isLoadingOnlineMore;
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const strategyRef = useRef(strategy);
  strategyRef.current = strategy;
  const backendItemsRef = useRef(backendItems);
  backendItemsRef.current = backendItems;

  // apps/strategy/seed/query 变化 → 可见数回到首屏 20；
  // 但在线翻页是“追加”（prev 为新数组前缀）时保持可见数，避免 page+1 刚拼进来就被重置回 20。
  const prevAppsRef = useRef<AppSummary[]>([]);
  const prevQueryRef = useRef<string>(searchQuery);
  const prevStrategySeedRef = useRef<string>(`${initialStrategy}|${initialSeed}`);
  useEffect(() => {
    const prevApps = prevAppsRef.current;
    const curTag = `${strategy}|${seed}`;
    const prevTag = prevStrategySeedRef.current;
    let shouldReset = true;
    if (
      prevTag === curTag &&
      prevQueryRef.current === searchQuery &&
      prevApps.length > 0 &&
      apps.length > prevApps.length
    ) {
      const isAppend = prevApps.every((a, i) => apps[i]?.id === a.id);
      if (isAppend) shouldReset = false;
    }
    if (shouldReset) setVisibleCount(HOME_FEED_PAGE);
    prevAppsRef.current = apps;
    prevQueryRef.current = searchQuery;
    prevStrategySeedRef.current = curTag;
  }, [apps, searchQuery, strategy, seed]);

  // ---- 本地推荐池（唯一过滤入口仍是 apps=platformFilteredApps） --------------
  // 搜索态保序：搜索结果按入参原序（后端 search_apps 打分顺序）直接分页，
  // 跳过 resolveHero/rankFeed/featured 切分；非搜索态（发现）保持 hero+featured+rankFeed 不变。
  // isSearching 沿用现有 searchQuery 派生（App 已透传 searchQuery/isOnlineResults，无需新增 prop）。
  const heroApp = useMemo(
    () => (isSearching ? undefined : resolveHero(apps)),
    [apps, isSearching],
  );
  const heroDisplayName = heroApp ? getAppDisplayName(heroApp) : '';
  const heroDisplayDesc = heroApp ? getAppDescription(heroApp, i18n.language) : '';
  const heroCategoryName = heroApp ? getCategoryLabel(heroApp.category, heroApp.category_name, t) : '';

  const nonHeroApps = useMemo(
    () => {
      if (isSearching) return apps;
      return heroApp ? apps.filter((a) => a.id !== heroApp.id) : apps;
    },
    [apps, heroApp, isSearching],
  );
  const rankedRest = useMemo(
    () => {
      // 搜索态：按入参原序直接返回，不重排（sliceFeed 只做切片）。
      if (isSearching) return apps;
      return rankFeed(nonHeroApps, seed, strategy);
    },
    [nonHeroApps, seed, strategy, isSearching, apps],
  );
  // 本地排序口径不动：发现态 rankFeed 打分 + sliceFeed 分页（首屏 20，触底 +20）；
  // 搜索态 featured 为空、feedPool 即原序 apps，visibleLocal=首屏 20 切片。
  const featuredApps = useMemo(
    () => (isSearching ? [] : sliceFeed(rankedRest, 0, 4)),
    [rankedRest, isSearching],
  );
  const feedPool = useMemo(
    () => {
      if (isSearching) return apps;
      return sliceFeed(rankedRest, 4, Math.max(0, rankedRest.length - 4));
    },
    [rankedRest, isSearching, apps],
  );
  // 本地兜底分页：只渲染 slice(0, visibleCount)，绝不全量 .map。
  const visibleLocal = useMemo(() => sliceFeed(feedPool, 0, visibleCount), [feedPool, visibleCount]);

  // ---- 后端优先：get_home_feed 分页 ----------------------------------------
  // 平台过滤仍以 apps 为准：后端条目先交集平台集合、再排除已展示的 hero/featured，
  // 全选时零过滤，与本地池完全一致；窄筛选时以后端 has_more 为准继续翻页。
  useEffect(() => {
    if (!canUseHomeFeedBackend()) return;
    let cancelled = false;
    setBackendLoading(true);
    setBackendHasMore(false);
    fetchHomeFeedPage(FIRST_PAGE_LIMIT, 0, seedRef.current, strategyRef.current)
      .then((res) => {
        if (cancelled) return;
        setBackendItems(res.items);
        setBackendTotal(res.total);
        setBackendHasMore(res.has_more);
        setBackendActive(true);
        setBackendLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // 命令不存在（后端 lane 未就绪）→ 静默回退本地 rankFeed。
        setBackendActive(false);
        setBackendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [strategy, seed]);

  const platformIdSet = useMemo(
    () => new Set(apps.map((a) => a.id.toLowerCase())),
    [apps],
  );
  const displayedIds = useMemo(() => {
    const set = new Set<string>();
    if (heroApp) set.add(heroApp.id.toLowerCase());
    for (const f of featuredApps) set.add(f.id.toLowerCase());
    return set;
  }, [heroApp, featuredApps]);

  const backendFeed = useMemo(
    () =>
      backendItems.filter(
        (s) => platformIdSet.has(s.id.toLowerCase()) && !displayedIds.has(s.id.toLowerCase()),
      ),
    [backendItems, platformIdSet, displayedIds],
  );

  // 搜索态保序：按入参原序 sliceFeed 切片分页（不重排）；后端 feed 仅在非搜索态启用，避免搜索结果被后端 order 污染。
  const useBackendList = !isSearching && backendActive && backendFeed.length > 0;
  const displayedFeed = useBackendList ? sliceFeed(backendFeed, 0, visibleCount) : visibleLocal;
  const localHasMore = useBackendList ? backendHasMore : visibleLocal.length < feedPool.length;
  // 在线结果集：本地 slice 已到底但后端还有下一页时，哨兵保持存活，触底即 page+1。
  const onlineActive = isSearching && isOnlineResults && onlineHasMore;
  const hasMore = localHasMore || onlineActive;

  const loadMoreRef = useRef<() => void>(() => {});
  const handleLoadMore = useCallback(() => {
    if (loadingRef.current) return;
    if (isLoadingOnlineMore) return;
    setVisibleCount((c) => c + HOME_FEED_PAGE);
    // 非搜索态：后端已就绪且还有下一页 → 增量拉取；失败则保持本地列表不变。
    if (!isSearching && canUseHomeFeedBackend() && backendActive && backendHasMore) {
      const offset = backendItemsRef.current.length;
      setBackendLoading(true);
      loadingRef.current = true;
      fetchHomeFeedPage(HOME_FEED_PAGE, offset, seedRef.current, strategyRef.current)
        .then((res) => {
          setBackendItems((prev) => [...prev, ...res.items]);
          if (typeof res.total === 'number') setBackendTotal(res.total);
          setBackendHasMore(res.has_more);
          setBackendLoading(false);
        })
        .catch(() => {
          setBackendLoading(false);
        });
    }
    // 搜索在线结果集：滚动到底且后端满页/has_more 时自动要下一页（page+1），由 App 拼接到 apps。
    if (isSearching && isOnlineResults && onlineHasMore && onOnlineLoadMore) {
      onOnlineLoadMore();
    }
  }, [backendActive, backendHasMore, isSearching, isOnlineResults, onlineHasMore, onOnlineLoadMore, isLoadingOnlineMore]);
  loadMoreRef.current = handleLoadMore;

  // 底部哨兵：进入视口自动 +20（搜索态同样首屏 20+哨兵+20）；无 IntersectionObserver（测试/旧环境）时靠“加载更多”按钮兜底。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, useBackendList, displayedFeed.length, onlineActive, isOnlineResults]);

  const handleShuffle = useCallback(() => {
    setSeed((s) => (Number.isFinite(s) ? Math.floor(s) + 1 : 7));
  }, []);

  const strategyLabel = (s: FeedStrategy): string => {
    if (s === 'stars') return t('home.feed_stars', '最热');
    if (s === 'fresh') return t('home.feed_fresh', '新发现');
    return t('home.feed_balanced', '推荐');
  };

  if (apps.length === 0) {
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

      {/* 推荐 feed：首屏 20，触底自动 +20；只渲染 slice(0, visibleCount) */}
      {(feedPool.length > 0 || displayedFeed.length > 0) && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">
              <Package size={16} />
              <span>{t('home.all_featured')}</span>
            </h3>
          </div>

          <div className="feed-toolbar">
            <div className="feed-strategy" role="group" aria-label={t('home.feed_strategy', '推荐策略')}>
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`feed-strategy-btn${strategy === s ? ' is-active' : ''}`}
                  aria-pressed={strategy === s}
                  onClick={() => setStrategy(s)}
                >
                  {strategyLabel(s)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn-fluent btn-secondary feed-shuffle-btn"
              onClick={handleShuffle}
              title={t('home.feed_shuffle_hint', '换一批推荐')}
            >
              <Shuffle size={13} />
              <span>{t('home.feed_shuffle', '换一批')}</span>
            </button>
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
                  : t('home.feed_end', `到底了 · 共 ${feedPool.length} 个推荐`)}
              </div>
            )
          )}
        </>
      )}
    </ViewShell>
  );
};
