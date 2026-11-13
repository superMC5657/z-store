import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import * as apiModule from '../../services/api';
import { buildFrontendAffinityScorer, rankFeed } from '../../services/feed';

type HomeFeedPage = { items: AppSummary[]; total: number; has_more: boolean };

const apiMod = apiModule as unknown as {
  tauriApi?: {
    getHomeFeed?: (limit: number, offset: number, seed?: number, strategy?: string) => Promise<HomeFeedPage>;
  };
  isTauri?: boolean;
};

function canUseBackend(): boolean {
  try {
    if (apiMod.isTauri === true) return true;
    if (apiMod.isTauri === false) return false;
  } catch {
    return false;
  }
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
}

async function fetchPage(limit: number, offset: number, seed: number): Promise<HomeFeedPage> {
  const fn = apiMod.tauriApi?.getHomeFeed;
  if (typeof fn !== 'function') throw new Error('home feed backend unavailable');
  const raw = (await fn.call(apiMod.tauriApi, limit, offset, seed, 'balanced')) as Partial<HomeFeedPage> | null;
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  return { items, total, has_more: raw?.has_more === true };
}

export const MAIN_FEED_PAGE = 20;

interface UseMainFeedParams {
  /** App 层平台筛选后的合并目录：主流只展示其中的应用，并以其字段为准。 */
  apps: AppSummary[];
  /** 页面上方已出现的应用 id（小写），主流中滤除。 */
  excludeIds: ReadonlySet<string>;
  daySeed: number;
  /** 无后端时（演示站 / 测试）前端回退排序使用的收藏与关注。 */
  favoriteIds?: ReadonlySet<string>;
  watchedIds?: ReadonlySet<string>;
  personalized: boolean;
}

/**
 * 「全部精选」主流：后端 `get_home_feed` 分页（日期种子，进入页面时拉取一次），
 * 无后端时回退前端 `rankFeed`。首屏 20，按钮或哨兵 +20。
 */
export function useMainFeed({ apps, excludeIds, daySeed, favoriteIds, watchedIds, personalized }: UseMainFeedParams) {
  const [visibleCount, setVisibleCount] = useState(MAIN_FEED_PAGE);
  const [backendItems, setBackendItems] = useState<AppSummary[]>([]);
  const [backendHasMore, setBackendHasMore] = useState(false);
  const [backendActive, setBackendActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  const backendLenRef = useRef(0);
  backendLenRef.current = backendItems.length;

  useEffect(() => {
    if (!canUseBackend()) return;
    let cancelled = false;
    setLoading(true);
    fetchPage(MAIN_FEED_PAGE + 5, 0, daySeed)
      .then((res) => {
        if (cancelled) return;
        setBackendItems(res.items);
        setBackendHasMore(res.has_more);
        setBackendActive(true);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBackendActive(false);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daySeed]);

  const appById = useMemo(() => {
    const m = new Map<string, AppSummary>();
    for (const a of apps) {
      const k = a.id.toLowerCase();
      if (!m.has(k)) m.set(k, a);
    }
    return m;
  }, [apps]);

  const backendPool = useMemo(
    () =>
      backendItems
        .map((s) => appById.get(s.id.toLowerCase()))
        .filter((a): a is AppSummary => Boolean(a) && !excludeIds.has(a!.id.toLowerCase())),
    [backendItems, appById, excludeIds],
  );
  const useBackend = backendActive && backendPool.length > 0;

  const localScorer = useMemo(
    () =>
      useBackend || !personalized
        ? undefined
        : buildFrontendAffinityScorer({ catalog: apps, favoriteIds, watchedIds, enabled: true }),
    [useBackend, personalized, apps, favoriteIds, watchedIds],
  );
  const localPool = useMemo(
    () =>
      useBackend
        ? []
        : rankFeed(
            apps.filter((a) => !excludeIds.has(a.id.toLowerCase())),
            daySeed,
            'balanced',
            localScorer,
          ),
    [useBackend, apps, excludeIds, daySeed, localScorer],
  );

  const pool = useBackend ? backendPool : localPool;
  const displayed = useMemo(() => pool.slice(0, visibleCount), [pool, visibleCount]);
  const hasMore = useBackend ? visibleCount < pool.length || backendHasMore : visibleCount < pool.length;

  const loadMore = useCallback(() => {
    if (loadingRef.current) return;
    setVisibleCount((c) => c + MAIN_FEED_PAGE);
    if (!useBackend || !backendHasMore) return;
    setLoading(true);
    loadingRef.current = true;
    fetchPage(MAIN_FEED_PAGE, backendLenRef.current, daySeed)
      .then((res) => {
        setBackendItems((prev) => [...prev, ...res.items]);
        setBackendHasMore(res.has_more);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [useBackend, backendHasMore, daySeed]);

  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, displayed.length]);

  return {
    displayed,
    hasMore,
    loading,
    loadMore,
    sentinelRef,
  };
}
