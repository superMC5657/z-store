import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSummary } from '../../types';
import * as apiModule from '../../services/api';
import { rankFeed, resolveHero, sliceFeed, type FeedStrategy } from '../../services/feed';
import { getAppDisplayName, getAppDescription, getCategoryLabel } from '../../utils/appHelper';

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
    hasMore?: unknown;
  };
  const items = Array.isArray(raw?.items) ? (raw.items as AppSummary[]) : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  const more = (raw?.has_more ?? raw?.hasMore) as unknown;
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
    let shouldReset = true;
    if (
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
  }, [apps, searchQuery]);

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

  const loadMoreRef = useRef<() => void>(() => {});
  const handleLoadMore = useCallback(() => {
    if (loadingRef.current) return;
    if (isLoadingOnlineMore) return;
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
    if (isSearching && isOnlineResults && onlineHasMore && onOnlineLoadMore) {
      onOnlineLoadMore();
    }
  }, [backendActive, backendHasMore, isSearching, isOnlineResults, onlineHasMore, onOnlineLoadMore, isLoadingOnlineMore]);
  loadMoreRef.current = handleLoadMore;

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
