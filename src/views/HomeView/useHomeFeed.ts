import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSummary } from '../../types';
import * as apiModule from '../../services/api';
import { rankFeed, resolveHero, sliceFeed, type FeedStrategy } from '../../services/feed';
import { getAppDescription, getCategoryLabel } from '../../utils/appHelper';
import { isPlaceholderDescription } from '../../services/trends/enrich';

export type HomeFeedPage = {
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

export function canUseHomeFeedBackend(): boolean {
  const flag = readIsTauriFlag();
  if (flag === true) return true;
  if (flag === false) return false;
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
}

export async function fetchHomeFeedPage(limit: number, offset: number, seed: number, strategy?: string): Promise<HomeFeedPage> {
  const fn = readHomeFeedFn();
  if (typeof fn !== 'function') throw new Error('home feed backend unavailable');
  const raw = (await fn(limit, offset, seed, strategy)) as unknown as {
    items?: unknown;
    total?: unknown;
    has_more?: unknown;
  };
  const items = Array.isArray(raw?.items) ? (raw.items as AppSummary[]) : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  const more = raw?.has_more as unknown;
  return { items, total, has_more: more === true };
}

export const HOME_FEED_PAGE = 20;
const FIRST_PAGE_LIMIT = HOME_FEED_PAGE + 5;
const FIXED_FEED_STRATEGY: FeedStrategy = 'balanced';
const FIXED_FEED_SEED = 7;

export interface UseHomeFeedParams {
  apps: AppSummary[];
  searchQuery?: string;
  isOnlineResults?: boolean;
  onlineHasMore?: boolean;
  isLoadingOnlineMore?: boolean;
  onOnlineLoadMore?: () => void;
}

export function useHomeFeed({
  apps,
  searchQuery = '',
  isOnlineResults = false,
  onlineHasMore = false,
  isLoadingOnlineMore = false,
  onOnlineLoadMore,
}: UseHomeFeedParams) {
  const { t, i18n } = useTranslation();
  const isSearching = Boolean(searchQuery && searchQuery.trim().length > 0);

  const strategy = FIXED_FEED_STRATEGY;
  const seed = FIXED_FEED_SEED;
  const [visibleCount, setVisibleCount] = useState(HOME_FEED_PAGE);

  const [backendItems, setBackendItems] = useState<AppSummary[]>([]);
  const [backendHasMore, setBackendHasMore] = useState(false);
  const [backendTotal, setBackendTotal] = useState<number | null>(null);
  const [backendActive, setBackendActive] = useState(false);
  const [backendLoading, setBackendLoading] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  loadingRef.current = backendLoading || isLoadingOnlineMore;
  const backendItemsRef = useRef(backendItems);
  backendItemsRef.current = backendItems;

  const prevAppsRef = useRef<AppSummary[]>([]);
  const prevQueryRef = useRef<string>(searchQuery);
  useEffect(() => {
    const prevApps = prevAppsRef.current;
    const queryChanged = prevQueryRef.current !== searchQuery;
    let shouldReset = false;
    if (queryChanged) {
      // 换词搜索仍重置为首屏（期望行为保持）
      shouldReset = true;
    } else if (prevApps.length === 0 && apps.length === 0) {
      shouldReset = false;
    } else {
      // 按 id 序列判定：同 id 序列仅字段 patch（如详情回填/图标回填）永不重置
      const prevIds = prevApps.map((a) => a.id).join(',');
      const nextIds = apps.map((a) => a.id).join(',');
      if (prevIds === nextIds) {
        shouldReset = false;
      } else if (
        prevApps.length > 0 &&
        apps.length > prevApps.length &&
        prevApps.every((a, i) => apps[i]?.id === a.id)
      ) {
        // 纯追加豁免（后端分页/在线加载更多）
        shouldReset = false;
      } else if (prevApps.length === 0) {
        // 首刷：已是 HOME_FEED_PAGE，不确定时宁可不重置
        shouldReset = false;
      } else {
        // id 集合/顺序真变化（过滤/排序/换源）才重置
        shouldReset = true;
      }
    }
    if (shouldReset) setVisibleCount(HOME_FEED_PAGE);
    prevAppsRef.current = apps;
    prevQueryRef.current = searchQuery;
  }, [apps, searchQuery]);

  const heroApp = useMemo(
    () => (isSearching ? undefined : resolveHero(apps)),
    [apps, isSearching],
  );
  const heroDisplayName = heroApp ? heroApp.name : '';
  // 空或占位显示 trends.no_desc，中英任一有效即显示。
  const heroDisplayDesc = (() => {
    if (!heroApp) return '';
    const langDesc = getAppDescription(heroApp, i18n.language);
    const isValid = (v: unknown): v is string =>
      typeof v === 'string' && v.trim() !== '' && !isPlaceholderDescription(v);
    if (isValid(langDesc)) return langDesc;
    if (isValid(heroApp.description_en)) return heroApp.description_en;
    if (isValid(heroApp.description)) return heroApp.description;
    return t('trends.no_desc');
  })();
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
      if (isSearching) return apps;
      return rankFeed(nonHeroApps, seed, strategy);
    },
    [nonHeroApps, seed, strategy, isSearching, apps],
  );

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

  const visibleLocal = useMemo(() => sliceFeed(feedPool, 0, visibleCount), [feedPool, visibleCount]);

  // 发现页后端分页：挂载即拉首屏（本地切片兜底，见 displayedFeed）。
  // 后端分页仅在显式 Load more 点击时跟进（handleLocalLoadMore/handleLoadMore）。
  useEffect(() => {
    if (!canUseHomeFeedBackend()) return;
    let cancelled = false;
    setBackendLoading(true);
    setBackendHasMore(false);
    fetchHomeFeedPage(FIRST_PAGE_LIMIT, 0, seed, strategy)
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
        setBackendActive(false);
        setBackendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const useBackendList = !isSearching && backendActive && backendFeed.length > 0;
  const displayedFeed = useBackendList ? sliceFeed(backendFeed, 0, visibleCount) : visibleLocal;
  const localHasMore = useBackendList ? backendHasMore : visibleLocal.length < feedPool.length;
  const onlineActive = isSearching && isOnlineResults && onlineHasMore;
  const hasMore = localHasMore || onlineActive;

  // 本地/发现 feed 续刷（手动 Load more 点击或哨兵越界）：可见数 +20，后端分页跟进。
  // 在线搜索段永不经此自动续拉——哨兵只续本地段；在线下一页须经 armed 边界条的
  // 越界手势或按钮显式触发（`useOnlinePullToLoadMore`），避免到底被提前 320px 预取吞掉边界感。
  const loadLocalRef = useRef<() => void>(() => {});
  const handleLocalLoadMore = useCallback(() => {
    if (loadingRef.current) return;
    setVisibleCount((c) => c + HOME_FEED_PAGE);
    if (!isSearching && canUseHomeFeedBackend() && backendActive && backendHasMore) {
      const offset = backendItemsRef.current.length;
      setBackendLoading(true);
      loadingRef.current = true;
      fetchHomeFeedPage(HOME_FEED_PAGE, offset, seed, strategy)
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
  }, [backendActive, backendHasMore, isSearching]);
  loadLocalRef.current = handleLocalLoadMore;

  // 显式续拉（按钮点击 / 在线段越界手势）：本地 +20 叠加在线下一页。
  // `onOnlineLoadMore` 即 `handleOnlineLoadMore`，去重追加/缓存键/has_more 语义在其内部保持不变。
  const handleLoadMore = useCallback(() => {
    if (loadingRef.current) return;
    if (isLoadingOnlineMore) return;
    handleLocalLoadMore();
    if (isSearching && isOnlineResults && onlineHasMore && onOnlineLoadMore) {
      onOnlineLoadMore();
    }
  }, [handleLocalLoadMore, isSearching, isOnlineResults, onlineHasMore, onOnlineLoadMore, isLoadingOnlineMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadLocalRef.current();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, useBackendList, displayedFeed.length]);

  return {
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
    backendActive,
    useBackendList,
    feedPoolLength: feedPool.length,
    handleLoadMore,
    sentinelRef,
    isSearching,
    setVisibleCount,
  };
}
