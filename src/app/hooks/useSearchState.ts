import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, ViewType } from '../../types';
import { api, ONLINE_SEARCH_PER_PAGE } from '../../services/api';
import { getBufferedIcon, mergeStickyIcon } from '../../services/iconStore';
import { hydrateTrendEnrichCache } from '../../services/trends/enrich';
import {
  readSearchListCache,
  sweepExpiredSearchListCache,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { zlogWarn } from '../../lib/z-log';

export interface UseSearchStateParams {
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  lazyBackfillPlatforms: (summaries: AppSummary[], seq: number) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/** 在线段图标回填组装。
 * 搜缓存
 */
function assembleOnlineRowsWithIcons(prev: AppSummary[], incoming: AppSummary[]): AppSummary[] {
  const prevById = new Map<string, AppSummary>();
  for (const p of prev ?? []) {
    const pk = (p?.id || '').trim().toLowerCase();
    if (pk && !prevById.has(pk)) prevById.set(pk, p);
  }
  const seen = new Set<string>();
  const deduped: AppSummary[] = [];
  for (const m of incoming ?? []) {
    const k = (m.id || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    let item = mergeStickyIcon(prevById.get(k), m);
    if (typeof item.icon === 'string' && item.icon.trim() === '') {
      const coordKey =
        item.owner && item.repo
          ? `${item.owner.trim().toLowerCase()}/${item.repo.trim().toLowerCase()}`
          : '';
      const idKey = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
      const buffered =
        (coordKey ? getBufferedIcon(coordKey) : undefined) ??
        (idKey ? getBufferedIcon(idKey) : undefined);
      if (buffered && buffered.trim() !== '') {
        item = { ...item, icon: buffered };
      }
    }
    deduped.push(item);
  }
  return deduped;
}

/** enrich 单向共享：仅具平台进共享。 */
function shareConcreteToTrendEnrich(rows: AppSummary[]): void {
  const concrete: Record<string, AppSummary> = {};
  for (const s of rows ?? []) {
    if (!s || typeof s !== 'object') continue;
    if (!Array.isArray(s.platforms) || s.platforms.length === 0) continue;
    if (typeof s.id !== 'string' || s.id.trim() === '') continue;
    if (typeof s.owner !== 'string' || s.owner.trim() === '') continue;
    if (typeof s.repo !== 'string' || s.repo.trim() === '') continue;
    const key = s.id.trim().toLowerCase();
    if (!key || concrete[key]) continue;
    concrete[key] = s;
  }
  if (Object.keys(concrete).length > 0) {
    hydrateTrendEnrichCache(concrete);
  }
}

export function useSearchState({
  currentView,
  setCurrentView,
  setApps,
  lazyBackfillPlatforms,
  showToast,
  t,
}: UseSearchStateParams) {
  const [searchQuery, setSearchQuery] = useState('');
  const searchSeqRef = useRef(0);
  const currentSearchIdRef = useRef<string>('');
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const [onlineSearchPerformed, setOnlineSearchPerformed] = useState(false);
  // 在线搜索翻页状态：提交即在线调第 1 页，触底且满页/has_more 时 page+1 追加到在线段。
  // 上下分段：apps 永远是本地结果，在线结果单独存 onlineApps（HomeView 本地在上、在线在下两段展示）。
  const [isOnlineResultSet, setIsOnlineResultSet] = useState(false);
  const [onlineApps, setOnlineApps] = useState<AppSummary[]>([]);
  const [, setOnlinePage] = useState(1);
  const [onlineHasMore, setOnlineHasMore] = useState(false);
  const [isLoadingOnlineMore, setIsLoadingOnlineMore] = useState(false);
  const onlinePageRef = useRef(1);
  const onlineHasMoreRef = useRef(false);
  const isOnlineResultSetRef = useRef(false);
  const onlineQueryRef = useRef('');
  const isLoadingOnlineMoreRef = useRef(false);
  const onlineAppsRef = useRef<AppSummary[]>([]);
  onlineAppsRef.current = onlineApps;

  // 搜索 stale 守卫 + 错误回退合一：seq 过期返回 true（调用方直接 return）；
  // 否则若传入 err 则记录日志并执行 fallback，返回 false。日志内容与回退行为与原内联代码保持一致。
  const guardFreshSearch = (seq: number, err?: unknown, logPrefix?: string, fallback?: () => void): boolean => {
    if (seq !== searchSeqRef.current) return true;
    if (err !== undefined && logPrefix !== undefined) {
      zlogWarn(`${logPrefix}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      fallback?.();
    }
    return false;
  };

  // 搜索逻辑（本地内存搜索，防抖触发）
  const handleSearchChange = async (q: string) => {
    const trimmed = q.trim();
    // 同词且已是该词的在线结果集 → 保持在线结果，不回退本地。
    // （TitleBar 回车会连调 onSearchChange + onSearchSubmit；此处若清掉在线态，
    // 提交侧的同词去重守卫将失效，导致重复在线请求。）
    if (
      trimmed &&
      trimmed === searchQuery.trim() &&
      trimmed === onlineQueryRef.current &&
      isOnlineResultSetRef.current
    ) {
      return;
    }
    setSearchQuery(q);
    setOnlineSearchPerformed(false);
    // 新搜索词切回本地结果集：清掉上一轮在线翻页状态，搜索态回到首屏 20（HomeView 负责）。
    // SWR 语义：miss 保留旧列表。
    // 此处不清 onlineApps，保留旧在线列表直到新 hits>0 再替换，迟到 icon-ready patch
    // 落在非空 prev 上可落定，不再因重搜清空致空 prev 永久丢。
    setIsOnlineResultSet(false);
    isOnlineResultSetRef.current = false;
    setOnlineHasMore(false);
    onlineHasMoreRef.current = false;
    setOnlinePage(1);
    onlinePageRef.current = 1;
    onlineQueryRef.current = '';
    setIsLoadingOnlineMore(false);
    isLoadingOnlineMoreRef.current = false;
    const seq = ++searchSeqRef.current;
    try {
      const results = await api.searchApps(q);
      if (guardFreshSearch(seq)) return;
      setApps(results);
      if (q && currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
        setCurrentView('home');
      }
    } catch (err) {
      if (guardFreshSearch(seq, err, 'searchApps error')) return;
    }
  };

  // 在线搜索提交逻辑（按回车或点击“在线搜索”按钮：即使本地有结果也发起在线搜索）
  const handleSearchSubmit = async (queryToSubmit?: string) => {
    const q = (queryToSubmit !== undefined ? queryToSubmit : searchQuery).trim();
    if (!q) return;
    // 搜缓存 sweep 过期。
    sweepExpiredSearchListCache();

    // 同词且已是该词的在线结果集 → 直接返回，避免重复请求；
    // 本地结果集（isOnlineResultSet 为 false）则必须允许转在线。
    if (
      q === searchQuery.trim() &&
      q === onlineQueryRef.current &&
      isOnlineResultSetRef.current
    ) {
      return;
    }

    const seq = ++searchSeqRef.current;

    // 若本地搜索尚未完成或搜索词变更，先查一次本地并展示（异词先本地后在线）
    // SWR 语义：异词先本地阶段不清 onlineApps，
    // 旧在线列表直展到新 hits>0 再替换，迟到 patch 不再打在空 prev 上永久丢。
    if (q !== searchQuery.trim()) {
      setSearchQuery(q);
      setOnlineSearchPerformed(false);
      setIsOnlineResultSet(false);
      isOnlineResultSetRef.current = false;
      setOnlineHasMore(false);
      onlineHasMoreRef.current = false;
      setOnlinePage(1);
      onlinePageRef.current = 1;
      onlineQueryRef.current = '';
      try {
        const freshLocal = await api.searchApps(q);
        if (guardFreshSearch(seq)) return;
        setApps(freshLocal);
        if (currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
          setCurrentView('home');
        }
      } catch (err) {
        // 本地失败不阻塞：照常转在线（apps 保持原样，在线无结果/失败则提示）。
        if (guardFreshSearch(seq, err, 'searchApps error')) return;
      }
    }

    // 提交即在线：不再以本地零结果为 gate（第 1 页，per_page 与后端默认 12 对齐）；
    // 上下分段：本地结果保留在 apps，在线结果单独存 onlineApps（HomeView 本地在上、在线在下）。
    // 在线无结果/失败则保持本地结果 + 提示（内部分支处理）。
    // 搜缓存 SWR：提交前先读搜缓存，
    // 后台仍 searchAppsOnline revalidate（沿用 searchSeqRef/guardFreshSearch 防串）；
    // 换词冷启动的 pending 平台每次重查（lazyBackfill 照常跑，不跳过）。
    let hadCacheHit = false;
    const listCached = readSearchListCache(q, 1, ONLINE_SEARCH_PER_PAGE);
    if (listCached && listCached.length > 0) {
      const assembledCached = assembleOnlineRowsWithIcons(onlineAppsRef.current ?? [], listCached);
      if (assembledCached.length > 0) {
        hadCacheHit = true;
        setOnlineApps(assembledCached);
        setOnlineSearchPerformed(true);
        setIsOnlineResultSet(true);
        isOnlineResultSetRef.current = true;
        setOnlinePage(1);
        onlinePageRef.current = 1;
        onlineQueryRef.current = q;
        // 满页即视为还有下一页（与网络分支同口径；单条直查只回 1 条，天然到底）。
        const cachedHasMore = listCached.length >= ONLINE_SEARCH_PER_PAGE;
        setOnlineHasMore(cachedHasMore);
        onlineHasMoreRef.current = cachedHasMore;
        lazyBackfillPlatforms(listCached, seq);
      }
    }
    {
      setIsSearchingOnline(true);
      const searchId = `search-${seq}-${Date.now()}`;
      currentSearchIdRef.current = searchId;
      try {
        const onlineResults = await api.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE);
        if (guardFreshSearch(seq)) return;
        setOnlineSearchPerformed(true);
        if (onlineResults && onlineResults.length > 0) {
          // 同词在线集去重 + 图标回填。
          const deduped = assembleOnlineRowsWithIcons(onlineAppsRef.current ?? [], onlineResults);
          setOnlineApps(deduped);
          lazyBackfillPlatforms(onlineResults, seq);
          setIsOnlineResultSet(true);
          isOnlineResultSetRef.current = true;
          setOnlinePage(1);
          onlinePageRef.current = 1;
          onlineQueryRef.current = q;
          // 满页即视为还有下一页（后端仍回数组，无 has_more 字段）；单条直查只回 1 条，天然到底。
          const hasMore = onlineResults.length >= ONLINE_SEARCH_PER_PAGE;
          setOnlineHasMore(hasMore);
          onlineHasMoreRef.current = hasMore;
          // 搜缓存
          writeSearchListCache(q, 1, ONLINE_SEARCH_PER_PAGE, deduped);
          shareConcreteToTrendEnrich(deduped);
          showToast(t('search.online_success', '已找到在线应用'), 'success');
        } else {
          // SWR 保留：已直展时不清空。
          if (hadCacheHit) return;
          setOnlineApps([]);
          setIsOnlineResultSet(false);
          isOnlineResultSetRef.current = false;
          setOnlineHasMore(false);
          onlineHasMoreRef.current = false;
          // 调不到或无结果就保持本地结果+提示，不报错
          showToast(t('search.online_no_results', '未找到相关在线应用，已保持本地结果'), 'info');
        }
      } catch (err) {
        if (guardFreshSearch(seq, err, 'searchAppsOnline error', () => {
          // SWR 保留：后台失败不清空。
          if (hadCacheHit) return;
          setOnlineSearchPerformed(true);
          setOnlineApps([]);
          setIsOnlineResultSet(false);
          isOnlineResultSetRef.current = false;
          setOnlineHasMore(false);
          onlineHasMoreRef.current = false;
          showToast(t('search.online_failed', '在线搜索暂不可用，已保持本地结果'), 'info');
        })) return;
      } finally {
        if (seq === searchSeqRef.current) {
          setIsSearchingOnline(false);
        }
      }
    }
  };

  // 在线结果触底翻页：后端满页/has_more 时自动要下一页（page+1），追加到在线段；
  // 限流/失败 toast 与首屏保持原样（info 级，不抛错阻塞列表）。
  // 搜缓存翻页。
  const handleOnlineLoadMore = useCallback(async () => {
    if (isLoadingOnlineMoreRef.current || isSearchingOnline) return;
    if (!isOnlineResultSetRef.current || !onlineHasMoreRef.current) return;
    const q = (onlineQueryRef.current || searchQuery.trim()).trim();
    if (!q) return;
    // 搜缓存 sweep 过期。
    sweepExpiredSearchListCache();
    const seq = searchSeqRef.current;
    const nextPage = onlinePageRef.current + 1;
    const cachedMore = readSearchListCache(q, nextPage, ONLINE_SEARCH_PER_PAGE);
    if (cachedMore && cachedMore.length > 0) {
      // 命中组装同样走回填分支：与旧在线段 sticky 合并 + 缓冲回填，再去重追加。
      const fresh = assembleOnlineRowsWithIcons(onlineAppsRef.current ?? [], cachedMore).filter(
        (item) => {
          const k = (item.id || '').toLowerCase();
          return k && !(onlineAppsRef.current ?? []).some((a) => (a.id || '').toLowerCase() === k);
        },
      );
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
      lazyBackfillPlatforms(cachedMore, seq);
      const cachedHasMore = cachedMore.length >= ONLINE_SEARCH_PER_PAGE;
      setOnlinePage(nextPage);
      onlinePageRef.current = nextPage;
      setOnlineHasMore(cachedHasMore);
      onlineHasMoreRef.current = cachedHasMore;
      return;
    }
    setIsLoadingOnlineMore(true);
    isLoadingOnlineMoreRef.current = true;
    try {
      const more = await api.searchAppsOnline(
        q,
        currentSearchIdRef.current || undefined,
        nextPage,
        ONLINE_SEARCH_PER_PAGE,
      );
      if (seq !== searchSeqRef.current) return;
      if (more && more.length > 0) {
        // 按 id 去重后追加到在线段（跳过在线段已有项；本地段不动）。
        setOnlineApps((prev) => {
          const seen = new Set(prev.map((a) => (a.id || '').toLowerCase()));
          const fresh: AppSummary[] = [];
          for (const m of more) {
            const k = (m.id || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            fresh.push(m);
          }
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        lazyBackfillPlatforms(more, seq);
        const hasMore = more.length >= ONLINE_SEARCH_PER_PAGE;
        setOnlinePage(nextPage);
        onlinePageRef.current = nextPage;
        setOnlineHasMore(hasMore);
        onlineHasMoreRef.current = hasMore;
        // 搜缓存
        writeSearchListCache(q, nextPage, ONLINE_SEARCH_PER_PAGE, more);
        shareConcreteToTrendEnrich(more);
      } else {
        setOnlineHasMore(false);
        onlineHasMoreRef.current = false;
      }
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      zlogWarn(`searchAppsOnline more error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      showToast(t('search.online_failed', '在线搜索暂不可用，已保持本地结果'), 'info');
    } finally {
      if (seq === searchSeqRef.current) {
        setIsLoadingOnlineMore(false);
        isLoadingOnlineMoreRef.current = false;
      }
    }
  }, [isSearchingOnline, searchQuery, showToast, t, lazyBackfillPlatforms]);

  return {
    searchQuery,
    setSearchQuery,
    searchSeqRef,
    currentSearchIdRef,
    isSearchingOnline,
    onlineSearchPerformed,
    isOnlineResultSet,
    setIsOnlineResultSet,
    onlineApps,
    setOnlineApps,
    onlineHasMore,
    isLoadingOnlineMore,
    onlinePageRef,
    onlineHasMoreRef,
    isOnlineResultSetRef,
    onlineQueryRef,
    isLoadingOnlineMoreRef,
    onlineAppsRef,
    guardFreshSearch,
    handleSearchChange,
    handleSearchSubmit,
    handleOnlineLoadMore,
  };
}
