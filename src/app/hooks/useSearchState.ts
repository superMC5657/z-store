import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, Navigate, ViewType } from '../../types';
import { tauriApi, ONLINE_SEARCH_PER_PAGE } from '../../services/api';
import { assembleOnlineRowsWithIcons } from '../../services/search/onlineRows';
import {
  readDbSearchListCache,
  readSearchListCacheEntry,
  saveDbSearchListCache,
  sweepExpiredSearchListCache,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import {
  hydrateCardsByIds,
  recordSharedConfirmedOthers,
  recordSharedPrivateRepos,
  recordSharedRepoPlatforms,
} from '../../services/repoEnrichCache';
import { normalizeId } from '../../services/normalizeId';
import { zlogWarn } from '../../lib/z-log';
import type { OnlineSearchPage } from '../../services/api/catalog';
import type { CatalogListsStore } from './useCatalogLists';

interface UseSearchStateParams {
  currentView: ViewType;
  /** 集中导航入口（App.createNavigate 产物；合法性校验收口于 types）。 */
  navigate: Navigate;
  catalogLists: Pick<
    CatalogListsStore,
    'setApps' | 'fullCatalogAppsRef' | 'onlineApps' | 'setOnlineApps' | 'onlineAppsRef'
  >;
  lazyBackfillPlatforms: (summaries: AppSummary[], seq: number, forceRefresh?: boolean) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

const EMPTY_CATALOG: readonly AppSummary[] = [];

/** 回包里的私有仓 / 已确认 Other 记入共享富卡池（已确认 Other 的行随后由平台回填零 IPC 落定）。 */
function recordPageSignals(page: OnlineSearchPage): boolean {
  const privateIds = page.private_ids ?? [];
  if (privateIds.length > 0) recordSharedPrivateRepos(privateIds);
  const confirmed = page.confirmed_other_ids ?? [];
  if (confirmed.length > 0) recordSharedConfirmedOthers(confirmed);
  return privateIds.length > 0;
}

/** 在线分页 L1 + L2 同步写：L1 存组装行（卡片进共享卡片表），L2 只存有序 id。 */
function persistOnlinePage(
  q: string,
  page: number,
  rows: AppSummary[],
  hasMore: boolean,
  hasPrivate: boolean,
): void {
  const key = { query: q, page, perPage: ONLINE_SEARCH_PER_PAGE };
  writeSearchListCache(key, rows, { hasMore, hasPrivate });
  void saveDbSearchListCache(
    key,
    rows.map((r) => normalizeId(r.id)),
    hasMore,
    hasPrivate,
  );
}

/** 回声窗协议纯函数：以服务端的真实 sid 回声作为期望真源，过滤迟到的旧轮事件。 */
// Empty sid never settles the expectation — callers pass a valid sid (guarded at the call site).
export function settlePageEcho(ref: { current: string }, sid: string): void {
  if (sid) ref.current = sid;
}

export function settleMoreEcho(
  ref: { current: string },
  seq: number,
  curSeq: number,
  sid: string,
): boolean {
  if (seq !== curSeq) return false;
  if (sid) ref.current = sid;
  return true;
}

export function adoptEchoInWindow(ref: { current: string }, kind: string, sid: string): boolean {
  const k = (kind || '').trim().toLowerCase();
  if ((k === '' || k === 'search') && sid !== '' && ref.current === '') {
    ref.current = sid;
    return true;
  }
  return false;
}

export function useSearchState({
  currentView,
  navigate,
  catalogLists,
  lazyBackfillPlatforms,
  showToast,
  t,
}: UseSearchStateParams) {
  const {
    setApps,
    fullCatalogAppsRef: catalogAppsRef,
    onlineApps,
    setOnlineApps,
    onlineAppsRef,
  } = catalogLists;
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  const localCompletedQueryRef = useRef<string | null>(null);
  const localInFlightQueryRef = useRef<string | null>(null);
  const [isSearchingLocal, setIsSearchingLocal] = useState(false);
  const searchSeqRef = useRef(0);
  const currentSearchIdRef = useRef<string>('');
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const isSearchingOnlineRef = useRef(false);
  const [onlineSearchPerformed, setOnlineSearchPerformed] = useState(false);
  // 在线搜索翻页状态：用户显式触发在线搜索后拉第 1 页，触底且满页/has_more 时 page+1 追加到在线段。
  // 上下分段：apps 永远是本地结果，在线结果单独存 onlineApps（HomeView 本地在上、在线在下两段展示）。
  const [isOnlineResultSet, setIsOnlineResultSet] = useState(false);
  const [onlineHasMore, setOnlineHasMore] = useState(false);
  const [isLoadingOnlineMore, setIsLoadingOnlineMore] = useState(false);
  const onlinePageRef = useRef(1);
  const onlineHasMoreRef = useRef(false);
  const isOnlineResultSetRef = useRef(false);
  const onlineQueryRef = useRef('');
  const isLoadingOnlineMoreRef = useRef(false);

  // 清空当前在线结果集与翻页游标（同步更新 state 与 ref，避免 stale 读）。
  const clearOnlineResults = () => {
    onlineAppsRef.current = [];
    setOnlineApps([]);
    isOnlineResultSetRef.current = false;
    setIsOnlineResultSet(false);
    onlineHasMoreRef.current = false;
    setOnlineHasMore(false);
    onlinePageRef.current = 1;
    onlineQueryRef.current = '';
  };

  // 重置全部在线搜索状态：换词或清空搜索时立即清理上一轮残留的在线列表、加载态与回声窗。
  const resetOnlineState = (seq: number) => {
    isSearchingOnlineRef.current = false;
    setIsSearchingOnline(false);
    setOnlineSearchPerformed(false);
    isLoadingOnlineMoreRef.current = false;
    setIsLoadingOnlineMore(false);
    clearOnlineResults();
    // 关闭上一轮在线搜索的回声窗，防止旧词迟到的 icon-ready 事件立期望。
    currentSearchIdRef.current = `local-${seq}`;
  };

  // 搜索 stale 守卫 + 错误回退合一：seq 过期返回 true（调用方直接 return）；
  // 否则若传入 err 则记录日志并执行 fallback，返回 false。
  const guardFreshSearch = (seq: number, err?: unknown, logPrefix?: string, fallback?: () => void): boolean => {
    if (seq !== searchSeqRef.current) return true;
    if (err !== undefined && logPrefix !== undefined) {
      zlogWarn(`${logPrefix}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      fallback?.();
    }
    return false;
  };

  // 输入防抖预备态：键入新词时立即同步 searchQuery、标记本地搜索中并清空上一词残留在线结果，
  // 避免 250ms 防抖窗口内继续展示旧在线列表或按钮误提交旧词。
  const handleSearchDraft = (q: string) => {
    const trimmed = q.trim();
    const prevTrimmed = searchQueryRef.current.trim();
    if (!trimmed) return;
    if (trimmed === prevTrimmed) {
      searchQueryRef.current = q;
      setSearchQuery(q);
      return;
    }
    searchQueryRef.current = q;
    localCompletedQueryRef.current = null;
    localInFlightQueryRef.current = null;
    setSearchQuery(q);
    setIsSearchingLocal(true);
    const seq = ++searchSeqRef.current;
    resetOnlineState(seq);
  };

      // 本地搜索（输入防抖、回车、历史点击或深链触发，同时清空上一轮在线状态）
  const handleSearchChange = async (q: string) => {
    const trimmed = q.trim();
    const prevTrimmed = searchQueryRef.current.trim();
    // 同词且本地已完成/进行中（或已处于该词在线结果集/请求中）：不重复发本地请求，也不冲掉当前词已主动触发的在线结果。
    if (
      trimmed &&
      trimmed === prevTrimmed &&
      (localCompletedQueryRef.current === trimmed ||
        localInFlightQueryRef.current === trimmed ||
        (trimmed === onlineQueryRef.current && (isOnlineResultSetRef.current || isSearchingOnlineRef.current)))
    ) {
      if (currentView !== 'home') {
        navigate('home');
      }
      return;
    }
    searchQueryRef.current = q;
    localCompletedQueryRef.current = null;
    localInFlightQueryRef.current = trimmed || null;
    setSearchQuery(q);
    setIsSearchingLocal(Boolean(trimmed));
    const seq = ++searchSeqRef.current;
    // 新搜索词或清空立即清空上一轮在线搜索残留结果与状态。
    resetOnlineState(seq);
    try {
      const results = await tauriApi.searchApps(q);
      if (guardFreshSearch(seq)) return;
      localCompletedQueryRef.current = trimmed;
      setApps(results);
      if (trimmed && currentView !== 'home') {
        navigate('home');
      }
    } catch (err) {
      if (guardFreshSearch(seq, err, 'searchApps error')) return;
    } finally {
      if (seq === searchSeqRef.current) {
        localInFlightQueryRef.current = null;
        setIsSearchingLocal(false);
      }
    }
  };

  // 在线搜索：`forceRefresh` 为 true 时跳过列表缓存直探远端。
  const handleSearchSubmit = async (queryToSubmit?: string, opts?: { forceRefresh?: boolean }) => {
    const forceRefresh = opts?.forceRefresh === true;
    const q = (queryToSubmit !== undefined ? queryToSubmit : searchQueryRef.current).trim();
    if (!q) return;
    // 搜索列表缓存 sweep 过期。
    sweepExpiredSearchListCache();

    // 同一词的在线搜索正在进行中 → 直接返回，避免连点造成并发重复请求。
    if (isSearchingOnlineRef.current && q === onlineQueryRef.current) {
      return;
    }

    const seq = ++searchSeqRef.current;
    const queryChanged = q !== searchQueryRef.current.trim();
    const needsLocalSearch = queryChanged || localCompletedQueryRef.current !== q;

    if (queryChanged) {
      searchQueryRef.current = q;
      localCompletedQueryRef.current = null;
      setSearchQuery(q);
      resetOnlineState(seq);
    } else if (onlineQueryRef.current !== q) {
      clearOnlineResults();
    }

    // 在首个 await 前锁定同词在途去重键，防止冷启动未命中缓存时连点穿透。
    onlineQueryRef.current = q;
    isSearchingOnlineRef.current = true;
    setIsSearchingOnline(true);

    try {
      // 若本地搜索尚未完成、失败或搜索词变更，先查一次本地并展示（先本地后在线）
      if (needsLocalSearch) {
        localInFlightQueryRef.current = q;
        setIsSearchingLocal(true);
        try {
          const freshLocal = await tauriApi.searchApps(q);
          if (guardFreshSearch(seq)) return;
          localCompletedQueryRef.current = q;
          setApps(freshLocal);
          if (currentView !== 'home') {
            navigate('home');
          }
        } catch (err) {
          // 本地失败不阻塞：照常转在线（apps 保持原样，在线无结果/失败则提示）。
          if (guardFreshSearch(seq, err, 'searchApps error')) return;
        } finally {
          if (seq === searchSeqRef.current) {
            localInFlightQueryRef.current = null;
            setIsSearchingLocal(false);
          }
        }
      }

      // 命中列表缓存时先直展；过期但尚在宽限期内的条目同时在后台 ETag 重验
      let hadCacheHit = false;
      const paintCached = (rows: AppSummary[], cachedHasMore: boolean): boolean => {
        const assembledCached = assembleOnlineRowsWithIcons([], rows);
        if (assembledCached.length === 0) return false;
        hadCacheHit = true;
        onlineAppsRef.current = assembledCached;
        setOnlineApps(assembledCached);
        setOnlineSearchPerformed(true);
        setIsOnlineResultSet(true);
        isOnlineResultSetRef.current = true;
        onlinePageRef.current = 1;
        onlineQueryRef.current = q;
        setOnlineHasMore(cachedHasMore);
        onlineHasMoreRef.current = cachedHasMore;
        lazyBackfillPlatforms(assembledCached, seq, false);
        return true;
      };
      const cacheHit = forceRefresh
        ? undefined
        : readSearchListCacheEntry({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE });
      if (cacheHit && cacheHit.rows.length > 0) {
        if (paintCached(cacheHit.rows, cacheHit.hasMore) && cacheHit.isFresh) return;
      } else if (!forceRefresh) {
        // L1 未命中（如冷启动）：读 SQLite 有序 id 快照，经目录 + `repo_card_cache` 批量水合首绘；
        // 5min 内且全部水合即零网络返回，否则先展示再后台 ETag 静默重验。
        const firstKey = { query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE };
        const l2Hit = await readDbSearchListCache(firstKey, { allowStale: true });
        if (guardFreshSearch(seq)) return;
        if (l2Hit) {
          const hydrated = await hydrateCardsByIds(l2Hit.ids, {
            catalogApps: catalogAppsRef?.current ?? EMPTY_CATALOG,
          });
          if (guardFreshSearch(seq)) return;
          if (hydrated.rows.length > 0) {
            const complete = hydrated.rows.length === l2Hit.ids.length;
            if (l2Hit.withinTtl && complete) {
              writeSearchListCache(firstKey, hydrated.rows, {
                hasMore: l2Hit.hasMore,
                hasPrivate: l2Hit.hasPrivate,
              });
            }
            if (paintCached(hydrated.rows, l2Hit.hasMore) && l2Hit.isFresh && complete) return;
          }
        }
      }

      const searchId = `search-${seq}-${Date.now()}`;
      // 回声窗：先清空期望（门控任一空即放行），窗内直播按回声 sid 收，不以请求串号判 stale；
      // 首个回声到达即立期望（下行回声见下，直播首事件见 App 侧），之后异 sid 才丢。
      currentSearchIdRef.current = '';
      try {
        const pageRes = await tauriApi.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE, forceRefresh);
        if (guardFreshSearch(seq)) return;
        const hasPrivate = recordPageSignals(pageRes);
        const onlineResults = pageRes.rows;
        // 以后端回声为唯一真源。
        if (pageRes.sid) settlePageEcho(currentSearchIdRef, pageRes.sid);
        setOnlineSearchPerformed(true);
        if (onlineResults && onlineResults.length > 0) {
          // 仅同词缓存命中时与当轮缓存行粘性合并，绝不混入旧词残留行。
          const prevForSameQuery = hadCacheHit ? (onlineAppsRef.current ?? []) : [];
          const deduped = assembleOnlineRowsWithIcons(prevForSameQuery, onlineResults);
          onlineAppsRef.current = deduped;
          setOnlineApps(deduped);
          // 收录投影或 `releases/latest` 回填已带平台的行回哺共享富卡池。
          recordSharedRepoPlatforms(deduped);
          lazyBackfillPlatforms(deduped, seq, forceRefresh);
          setIsOnlineResultSet(true);
          isOnlineResultSetRef.current = true;
          onlinePageRef.current = 1;
          onlineQueryRef.current = q;
          // 满页即视为还有下一页（后端仍回数组，无 has_more 字段）；单条直查只回 1 条，天然到底。
          const hasMore = onlineResults.length >= ONLINE_SEARCH_PER_PAGE;
          setOnlineHasMore(hasMore);
          onlineHasMoreRef.current = hasMore;
          // 搜索列表缓存 L1 + L2（只存有序 id；卡片在共享富卡池与 `repo_card_cache`）；
          // 联网失败回退的旧载荷不入缓存，下次仍联网重试。
          if (!pageRes.is_stale) {
            persistOnlinePage(q, 1, deduped, hasMore, hasPrivate);
          }
          // 后台重验静默完成，不重复提示。
          if (!hadCacheHit) showToast(t('search.online_success'), 'success');
        } else {
          // 同词缓存已直展时不清空。
          if (hadCacheHit) return;
          clearOnlineResults();
          // 调不到或无结果就保持本地结果+提示，不报错
          showToast(t('search.online_no_results'), 'info');
        }
      } catch (err) {
        if (guardFreshSearch(seq, err, 'searchAppsOnline error', () => {
          // 同词缓存已直展时后台失败不清空。
          if (hadCacheHit) return;
          setOnlineSearchPerformed(true);
          clearOnlineResults();
          showToast(t('search.online_failed'), 'info');
        })) return;
      }
    } finally {
      if (seq === searchSeqRef.current) {
        setIsSearchingOnline(false);
        isSearchingOnlineRef.current = false;
      }
    }
  };

  // 在线结果翻页：追加下一页到在线段
  const handleOnlineLoadMore = useCallback(async () => {
    if (isLoadingOnlineMoreRef.current || isSearchingOnlineRef.current || isSearchingOnline) return;
    if (!isOnlineResultSetRef.current || !onlineHasMoreRef.current) return;
    const q = (onlineQueryRef.current || searchQuery.trim()).trim();
    if (!q) return;
    // 搜索列表缓存 sweep 过期。
    sweepExpiredSearchListCache();
    const seq = searchSeqRef.current;
    const nextPage = onlinePageRef.current + 1;
    const pageKey = { query: q, page: nextPage, perPage: ONLINE_SEARCH_PER_PAGE };
    const appendCached = (rows: AppSummary[], cachedHasMore: boolean) => {
      // 命中组装同样走回填分支：与旧在线段 sticky 合并 + 缓冲回填，再去重追加。
      const fresh = assembleOnlineRowsWithIcons(onlineAppsRef.current ?? [], rows).filter((item) => {
        const k = (item.id || '').toLowerCase();
        return k && !(onlineAppsRef.current ?? []).some((a) => (a.id || '').toLowerCase() === k);
      });
      // 二次守卫：过滤基于 ref 快照，set 内再按最新 prev 去重一次，防并发追加串页。
      setOnlineApps((prev) => {
        const seen = new Set(prev.map((a) => (a.id || '').toLowerCase()));
        const toAppend: AppSummary[] = [];
        for (const m of fresh) {
          const k = (m.id || '').toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          toAppend.push(m);
        }
        return toAppend.length > 0 ? [...prev, ...toAppend] : prev;
      });
      lazyBackfillPlatforms(fresh, seq, false);
      onlinePageRef.current = nextPage;
      setOnlineHasMore(cachedHasMore);
      onlineHasMoreRef.current = cachedHasMore;
    };
    const cachedMore = readSearchListCacheEntry(pageKey);
    if (cachedMore && cachedMore.rows.length > 0) {
      appendCached(cachedMore.rows, cachedMore.hasMore);
      return;
    }
    setIsLoadingOnlineMore(true);
    isLoadingOnlineMoreRef.current = true;
    try {
      // L1 未命中：30min 内的 L2 快照且全部水合即零网络追加，否则走网络。
      const l2Hit = await readDbSearchListCache(pageKey);
      if (seq !== searchSeqRef.current) return;
      if (l2Hit) {
        const hydrated = await hydrateCardsByIds(l2Hit.ids, {
          catalogApps: catalogAppsRef?.current ?? EMPTY_CATALOG,
        });
        if (seq !== searchSeqRef.current) return;
        if (hydrated.rows.length > 0 && hydrated.rows.length === l2Hit.ids.length) {
          writeSearchListCache(pageKey, hydrated.rows, {
            hasMore: l2Hit.hasMore,
            hasPrivate: l2Hit.hasPrivate,
          });
          appendCached(hydrated.rows, l2Hit.hasMore);
          return;
        }
      }
      const moreRes = await tauriApi.searchAppsOnline(
        q,
        currentSearchIdRef.current || undefined,
        nextPage,
        ONLINE_SEARCH_PER_PAGE,
        false,
      );
      if (!settleMoreEcho(currentSearchIdRef, seq, searchSeqRef.current, moreRes.sid || '')) return;
      const morePrivate = recordPageSignals(moreRes);
      const more = moreRes.rows;
      if (more && more.length > 0) {
        // 按 id 去重后与缓冲图标粘性合并追加到在线段
        const assembledMore = assembleOnlineRowsWithIcons(onlineAppsRef.current ?? [], more);
        setOnlineApps((prev) => {
          const seen = new Set(prev.map((a) => (a.id || '').toLowerCase()));
          const fresh: AppSummary[] = [];
          for (const m of assembledMore) {
            const k = (m.id || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            fresh.push(m);
          }
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        recordSharedRepoPlatforms(assembledMore);
        lazyBackfillPlatforms(assembledMore, seq, false);
        const hasMore = more.length >= ONLINE_SEARCH_PER_PAGE;
        onlinePageRef.current = nextPage;
        setOnlineHasMore(hasMore);
        onlineHasMoreRef.current = hasMore;
        // 搜索列表缓存 L1 + L2（与首屏同口径）；联网失败回退的旧载荷不入缓存。
        if (!moreRes.is_stale) {
          persistOnlinePage(q, nextPage, assembledMore, hasMore, morePrivate);
        }
      } else {
        setOnlineHasMore(false);
        onlineHasMoreRef.current = false;
      }
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      zlogWarn(`searchAppsOnline more error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      showToast(t('search.online_failed'), 'info');
    } finally {
      if (seq === searchSeqRef.current) {
        setIsLoadingOnlineMore(false);
        isLoadingOnlineMoreRef.current = false;
      }
    }
  }, [isSearchingOnline, searchQuery, showToast, t, lazyBackfillPlatforms, catalogAppsRef]);

  return {
    searchQuery,
    searchSeqRef,
    currentSearchIdRef,
    isSearchingLocal,
    isSearchingOnline,
    onlineSearchPerformed,
    isOnlineResultSet,
    onlineApps,
    setOnlineApps,
    onlineHasMore,
    isLoadingOnlineMore,
    onlineQueryRef,
    onlineAppsRef,
    handleSearchDraft,
    handleSearchChange,
    handleSearchSubmit,
    handleOnlineLoadMore,
  };
}
