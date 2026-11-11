import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, ViewType } from '../../types';
import { tauriApi, ONLINE_SEARCH_PER_PAGE } from '../../services/api';
import { getBufferedIcon, isEmptyIcon, preferNonEmptyIcon, queueAssembledRowIcons } from '../../services/iconStore';
import {
  readSearchListCache,
  sweepExpiredSearchListCache,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { zlogWarn } from '../../lib/z-log';
import type { Navigate } from '../navigation';

interface UseSearchStateParams {
  currentView: ViewType;
  /** 集中导航入口（App.createNavigate 产物；合法性校验收口于 navigation）。 */
  navigate: Navigate;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  lazyBackfillPlatforms: (summaries: AppSummary[], seq: number, forceRefresh?: boolean) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * 回声窗协议纯函数（可单测，`HomeView.search-icon.test.tsx` 三 CTS 锁定）：
 * 回声为唯一真源，永不回落请求串号。
 * - `settlePageEcho`：首刷落定；有效 `sid` 即立期望（回声真源）。
 * - `settleMoreEcho`：翻页落定；seq 失配（旧页/旧次迟到）直接丢不覆盖；
 *   seq 对上但无 sid 不覆盖（保持旧期望）；有 sid 落定后以最新为准。
 * - `adoptEchoInWindow`：窗内（期望空）首个搜索回声即立期望（与 `App.tsx` 同语义）；
 *   已立期望后异 sid 由店内门控判 stale，此处不覆盖（窗内只采首个）。
 */
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

/** 在线段图标回填组装（C1 读透适配，薄）。
 * M1内存回读：搜索列表缓存命中行经 `getBufferedIcon` 唯一口回读拼装，空壳不覆盖缓冲实图。
 * 空值经店内 SSOT（`isEmptyIcon`/`admitIconHit`），此处不自立规则；
 * 粘性合并经 `preferNonEmptyIcon`，此处只做组装。
 * 组装行中 http 远端图标经 `queueAssembledRowIcons` 补齐落盘（前 30 上限，`data:`/空跳过），
 * 30 名开外无 preload 覆盖的行靠此自愈进盘。
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
    let item = preferNonEmptyIcon(prevById.get(k), m);
    if (isEmptyIcon(item.icon)) {
      const coordKey =
        item.owner && item.repo
          ? `${item.owner.trim().toLowerCase()}/${item.repo.trim().toLowerCase()}`
          : '';
      const idKey = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
      // M1内存回读经 `getBufferedIcon` 唯一口。
      const buffered =
        (coordKey ? getBufferedIcon(coordKey) : undefined) ??
        (idKey ? getBufferedIcon(idKey) : undefined);
      if (buffered && buffered.trim() !== '') {
        item = { ...item, icon: buffered };
      }
    }
    deduped.push(item);
  }
  // 组装落盘补齐：展示即入队（同 tick 合并+单飞+退避复用店内机制，前 30 上限防 N+1）。
  queueAssembledRowIcons(deduped);
  return deduped;
}

export function useSearchState({
  currentView,
  navigate,
  setApps,
  lazyBackfillPlatforms,
  showToast,
  t,
}: UseSearchStateParams) {
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
  const [onlineApps, setOnlineApps] = useState<AppSummary[]>([]);
  const [onlineHasMore, setOnlineHasMore] = useState(false);
  const [isLoadingOnlineMore, setIsLoadingOnlineMore] = useState(false);
  const onlinePageRef = useRef(1);
  const onlineHasMoreRef = useRef(false);
  const isOnlineResultSetRef = useRef(false);
  const onlineQueryRef = useRef('');
  const isLoadingOnlineMoreRef = useRef(false);
  const onlineAppsRef = useRef<AppSummary[]>([]);
  onlineAppsRef.current = onlineApps;

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

  // 第一阶段：本地搜索（输入防抖、回车、历史点击或深链触发，搜索本地目录并清空当前在线结果与在途状态）
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
      if (currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
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
      if (trimmed && currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
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

  // 第二阶段：在线搜索（由用户在搜索结果页显式选择触发）
  const handleSearchSubmit = async (queryToSubmit?: string) => {
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
          if (currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
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

      // 搜索列表缓存：提交前先读当前搜索词的搜索列表缓存，
      // 后台仍 searchAppsOnline revalidate（沿用 searchSeqRef/guardFreshSearch 防串）；
      // 换词冷启动的 loading 平台每次重查（lazyBackfill 照常跑，不跳过）。
      let hadCacheHit = false;
      const listCached = readSearchListCache({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE });
      if (listCached && listCached.length > 0) {
        const assembledCached = assembleOnlineRowsWithIcons([], listCached);
        if (assembledCached.length > 0) {
          hadCacheHit = true;
          onlineAppsRef.current = assembledCached;
          setOnlineApps(assembledCached);
          setOnlineSearchPerformed(true);
          setIsOnlineResultSet(true);
          isOnlineResultSetRef.current = true;
          onlinePageRef.current = 1;
          onlineQueryRef.current = q;
          // 满页即视为还有下一页（与网络分支同口径；单条直查只回 1 条，天然到底）。
          const cachedHasMore = listCached.length >= ONLINE_SEARCH_PER_PAGE;
          setOnlineHasMore(cachedHasMore);
          onlineHasMoreRef.current = cachedHasMore;
          lazyBackfillPlatforms(listCached, seq, true);
        }
      }

      const searchId = `search-${seq}-${Date.now()}`;
      // 回声窗：先清空期望（门控任一空即放行），窗内直播按回声 sid 收，不以请求串号判 stale；
      // 首个回声到达即立期望（下行回声见下，直播首事件见 App 侧），之后异 sid 才丢。
      currentSearchIdRef.current = '';
      try {
        const pageRes = await tauriApi.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE, true);
        if (guardFreshSearch(seq)) return;
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
          lazyBackfillPlatforms(onlineResults, seq, true);
          setIsOnlineResultSet(true);
          isOnlineResultSetRef.current = true;
          onlinePageRef.current = 1;
          onlineQueryRef.current = q;
          // 满页即视为还有下一页（后端仍回数组，无 has_more 字段）；单条直查只回 1 条，天然到底。
          const hasMore = onlineResults.length >= ONLINE_SEARCH_PER_PAGE;
          setOnlineHasMore(hasMore);
          onlineHasMoreRef.current = hasMore;
          // 搜索列表缓存（薄：只存行，不掺排名/平台判定）
          writeSearchListCache({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE }, deduped);
          showToast(t('search.online_success'), 'success');
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

  // 在线结果触底翻页：后端满页/has_more 时自动要下一页（page+1），追加到在线段；
  // 限流/失败 toast 与首屏保持原样（info 级，不抛错阻塞列表）。
  // 搜索列表缓存翻页。
  const handleOnlineLoadMore = useCallback(async () => {
    if (isLoadingOnlineMoreRef.current || isSearchingOnlineRef.current || isSearchingOnline) return;
    if (!isOnlineResultSetRef.current || !onlineHasMoreRef.current) return;
    const q = (onlineQueryRef.current || searchQuery.trim()).trim();
    if (!q) return;
    // 搜索列表缓存 sweep 过期。
    sweepExpiredSearchListCache();
    const seq = searchSeqRef.current;
    const nextPage = onlinePageRef.current + 1;
    const cachedMore = readSearchListCache({ query: q, page: nextPage, perPage: ONLINE_SEARCH_PER_PAGE });
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
      lazyBackfillPlatforms(cachedMore, seq, true);
      const cachedHasMore = cachedMore.length >= ONLINE_SEARCH_PER_PAGE;
      onlinePageRef.current = nextPage;
      setOnlineHasMore(cachedHasMore);
      onlineHasMoreRef.current = cachedHasMore;
      return;
    }
    setIsLoadingOnlineMore(true);
    isLoadingOnlineMoreRef.current = true;
    try {
      const moreRes = await tauriApi.searchAppsOnline(
        q,
        currentSearchIdRef.current || undefined,
        nextPage,
        ONLINE_SEARCH_PER_PAGE,
        true,
      );
      if (!settleMoreEcho(currentSearchIdRef, seq, searchSeqRef.current, moreRes.sid || '')) return;
      const more = moreRes.rows;
      if (more && more.length > 0) {
        // 按 id 去重后追加到在线段（跳过在线段已有项；本地段不动）。
        // 图标回填与首屏同口径：经 `assembleOnlineRowsWithIcons` 粘性合并 + M1 缓冲回读，
        // 空壳不覆盖缓冲实图；卡有 http 实图首绘即对（跳过双 IPC 取图链，按批直展）。
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
        lazyBackfillPlatforms(more, seq, true);
        const hasMore = more.length >= ONLINE_SEARCH_PER_PAGE;
        onlinePageRef.current = nextPage;
        setOnlineHasMore(hasMore);
        onlineHasMoreRef.current = hasMore;
        // 搜索列表缓存（薄：只存行，不掺排名/平台判定；与首屏同口径存组装行，
        // 粘性合并 + M1 缓冲回填已落定，回访即新图不丢图）
        writeSearchListCache({ query: q, page: nextPage, perPage: ONLINE_SEARCH_PER_PAGE }, assembledMore);
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
  }, [isSearchingOnline, searchQuery, showToast, t, lazyBackfillPlatforms]);

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
