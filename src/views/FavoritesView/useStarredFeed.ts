/**
 * 收藏页「Star 同步」状态机：查询目标解析、L1 分页缓存 / SQLite L2 快照恢复与水合、
 * 查询世代门控、第 1 页 SWR 重验、续页与快照写回，以及列表平台回填。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import {
  readSearchListCacheEntry,
  subscribeSearchListCachePatches,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { appendUniqueOnlineRows, assembleOnlineRowsWithIcons } from '../../services/search/onlineRows';
import { normalizeId } from '../../services/normalizeId';
import { advanceStarredIconGateOnNewQuery, patchAppIconList, subscribeIconWrites } from '../../services/iconStore';
import {
  hydrateCardsByIds,
  recordSharedConfirmedOthers,
  recordSharedPrivateRepos,
} from '../../services/repoEnrichCache';
import {
  STARRED_L2_MAX_PERSISTED_PAGES,
  loadPersistedStarredOpts,
  persistStarredOpts,
  readDbStarredCache,
  saveDbStarredCache,
  type StarredL2Hit,
  type StarredPageIds,
} from '../../services/starred/starredCache';
import {
  STARRED_CACHE_NAMESPACE,
  forgetPrivateStarredQueries,
  getLastQueryMemory,
  getQueryMemory,
  isNetworkSynced,
  markNetworkSynced,
  rememberQuery,
  resetStarredMemory,
  selfQueryKey,
  type StarredQueryMemory,
  type StarredTarget,
} from '../../services/starred/starredMemory';
import { useListPlatformBackfill } from '../../app/hooks/usePlatformBackfill';

/** 每页条数，与搜索页在线续拉一致。 */
export const STARRED_PER_PAGE = 20;

/** 测试用：清掉 Star 同步会话内存。 */
export function resetStarredFeedMemory(): void {
  resetStarredMemory();
}

/** 输入框 → 查询：与登录名相同（不分大小写）或留空即查自己，可带出私有 Star。 */
function resolveTarget(input: string, login: string | undefined): StarredTarget | null {
  const trimmed = input.trim();
  if (!trimmed || (login && trimmed.toLowerCase() === login.toLowerCase())) {
    return login ? { key: selfQueryKey(login), input } : null;
  }
  return { username: trimmed, key: trimmed.toLowerCase(), input };
}

/** 查自己的结果只属于当时的登录账号。 */
function belongsToLogin(target: StarredTarget, login: string | undefined): boolean {
  return target.username !== undefined || (login !== undefined && target.key === selfQueryKey(login));
}

function cacheKey(key: string, page: number) {
  return { namespace: STARRED_CACHE_NAMESPACE, query: key, page, perPage: STARRED_PER_PAGE };
}

interface RestoredQuery {
  memory: StarredQueryMemory;
  rows: AppSummary[];
  /** 每页有序 id（写 L2 快照用）。 */
  pageIds: StarredPageIds[];
  /** 第 1 页仍在 5min 新鲜窗口内。 */
  isFresh: boolean;
}

/** 从 L1 分页缓存恢复某目标第 1..pages 页；任一非空页缺失即放弃恢复。 */
function restoreQuery(target: StarredTarget): RestoredQuery | null {
  const known = getQueryMemory(target.key);
  const memory: StarredQueryMemory = known ?? { target, pages: 1, hasMore: false, emptyPages: [] };
  let rows: AppSummary[] = [];
  const pageIds: StarredPageIds[] = [];
  let isFresh = true;
  for (let p = 1; p <= memory.pages; p++) {
    if (memory.emptyPages.includes(p)) {
      pageIds.push({ page: p, ids: [] });
      continue;
    }
    const hit = readSearchListCacheEntry(cacheKey(memory.target.key, p));
    if (!hit) return null;
    if (p === 1) {
      isFresh = hit.isFresh;
      if (!known) memory.hasMore = hit.hasMore;
    }
    pageIds.push({ page: p, ids: hit.ids });
    rows = appendUniqueOnlineRows(rows, hit.rows);
  }
  return { memory, rows, pageIds, isFresh };
}

/** 最近一次查询（且属于当前登录账号）从分页缓存恢复。 */
function restoreLastQuery(login: string | undefined): RestoredQuery | null {
  const memory = getLastQueryMemory();
  if (!memory || !belongsToLogin(memory.target, login)) return null;
  return restoreQuery(memory.target);
}

/** 冷启动默认目标：记忆的公开用户名优先，否则已登录即查自己。 */
function initialTarget(login: string | undefined): StarredTarget | null {
  const opts = loadPersistedStarredOpts();
  if (opts?.mode === 'user') {
    return { username: opts.username, key: opts.username.toLowerCase(), input: opts.username };
  }
  return login ? { key: selfQueryKey(login), input: login } : null;
}

/** 快照页号 → 查询进度（缺页记为空页）。 */
function memoryFromPages(target: StarredTarget, pageIds: readonly StarredPageIds[], hasMore: boolean): StarredQueryMemory {
  const pages = pageIds.reduce((max, p) => Math.max(max, p.page), 0);
  const filled = new Set(pageIds.filter((p) => p.ids.length > 0).map((p) => p.page));
  const emptyPages: number[] = [];
  for (let p = 1; p <= pages; p++) if (!filled.has(p)) emptyPages.push(p);
  return { target, pages: Math.max(1, pages), hasMore, emptyPages };
}

interface UseStarredFeedParams {
  login: string | undefined;
  /** 合并后目录全量与本地收录（快照水合时标注收录态）。 */
  catalogApps?: readonly AppSummary[];
  localApps?: readonly AppSummary[];
  platformResolvedOtherIds: ReadonlySet<string>;
  onConfirmPlatformOtherIds?: (ids: readonly string[]) => void;
}

export function useStarredFeed({
  login,
  catalogApps,
  localApps,
  platformResolvedOtherIds,
  onConfirmPlatformOtherIds,
}: UseStarredFeedParams) {
  const { t } = useTranslation();
  const [initial] = useState(() => restoreLastQuery(login));
  const [input, setInput] = useState(() => {
    if (initial) return initial.memory.target.input;
    const opts = loadPersistedStarredOpts();
    return opts?.mode === 'user' ? opts.username : (login ?? '');
  });
  const [queryKey, setQueryKey] = useState<string | null>(() => initial?.memory.target.key ?? null);
  const [rows, setRows] = useState<AppSummary[]>(() => initial?.rows ?? []);
  const rowsRef = useRef<AppSummary[]>(rows);
  rowsRef.current = rows;
  const [pages, setPages] = useState(() => initial?.memory.pages ?? 0);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [hasMore, setHasMore] = useState(() => initial?.memory.hasMore ?? false);
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 当前结果对应的查询，续拉以它为准，不受之后改输入框影响。
  const targetRef = useRef<StarredTarget | null>(initial?.memory.target ?? null);
  const emptyPagesRef = useRef<number[]>(initial?.memory.emptyPages ?? []);
  // 每次新查询（或清空）+1：旧查询在途回包一律丢弃。
  const queryGenRef = useRef(0);
  const prevLoginRef = useRef(login);
  const loginRef = useRef(login);
  loginRef.current = login;
  // 当前结果按页有序 id（L2 快照只存它）。
  const pageIdsRef = useRef<StarredPageIds[]>(initial?.pageIds ?? []);
  const catalogRef = useRef({ catalogApps, localApps });
  catalogRef.current = { catalogApps, localApps };

  /** 把一次查询的结果放到屏上并记住进度。 */
  const showQuery = (memory: StarredQueryMemory, nextRows: AppSummary[]) => {
    targetRef.current = memory.target;
    emptyPagesRef.current = [...memory.emptyPages];
    setQueryKey(memory.target.key);
    setRows(nextRows);
    setPages(memory.pages);
    setHasMore(memory.hasMore);
    rememberQuery({ ...memory, emptyPages: [...memory.emptyPages] });
  };

  /** 按页 id 批量水合快照首绘，命中新鲜快照时同步填充 L1 分页缓存；查询已变更则返回 false。 */
  const hydrateSnapshot = async (target: StarredTarget, hit: StarredL2Hit, gen: number): Promise<boolean> => {
    const env = hit.envelope;
    const allIds = env.pages.flatMap((p) => p.ids);
    const hydrated = await hydrateCardsByIds(allIds, catalogRef.current);
    if (gen !== queryGenRef.current || !belongsToLogin(target, loginRef.current)) return false;
    if (hydrated.confirmedOtherIds.length > 0) onConfirmPlatformOtherIds?.(hydrated.confirmedOtherIds);
    const memory = memoryFromPages(target, env.pages, env.hasMore);
    if (hit.isFresh) {
      for (const p of env.pages) {
        const slice = p.ids.map((id) => hydrated.byId.get(id)).filter((r): r is AppSummary => !!r);
        if (slice.length > 0) {
          writeSearchListCache(cacheKey(target.key, p.page), slice, {
            hasMore: p.page < memory.pages || env.hasMore,
          });
        }
      }
    }
    pageIdsRef.current = env.pages.map((p) => ({ page: p.page, ids: [...p.ids] }));
    showQuery(memory, assembleOnlineRowsWithIcons([], hydrated.rows));
    return true;
  };

  /** 与 GitHub 同步过的当前目标：把前 3 页有序 id 直接写快照（登出后的 `@me:` 永不写回）。 */
  const persistPageIds = (target: StarredTarget, nextHasMore: boolean) => {
    if (!belongsToLogin(target, loginRef.current) || !isNetworkSynced(target.key)) return;
    const pages = pageIdsRef.current.filter((p) => p.page <= STARRED_L2_MAX_PERSISTED_PAGES);
    if (!pages.some((p) => p.ids.length > 0)) return;
    const truncated = pageIdsRef.current.some((p) => p.page > STARRED_L2_MAX_PERSISTED_PAGES);
    void saveDbStarredCache(target.key, target.key, {
      v: 2,
      pages,
      hasMore: nextHasMore || truncated,
    });
  };

  const setPageIds = (page: number, ids: string[]) => {
    const rest = pageIdsRef.current.filter((p) => p.page !== page);
    pageIdsRef.current = [...rest, { page, ids }].sort((a, b) => a.page - b.page);
  };

  // 登录名切换时清理私密缓存与不属于新账号的结果，并尝试恢复新账号上次的缓存/快照
  useEffect(() => {
    // 只认本次挂载内观察到的变化：挂载时登录信息可能尚未到达，不算登出（App 级另有全局清理）。
    const prevLogin = prevLoginRef.current;
    prevLoginRef.current = login;
    if (prevLogin && prevLogin !== login) forgetPrivateStarredQueries();
    const current = targetRef.current;
    if (current && !belongsToLogin(current, login)) {
      queryGenRef.current++;
      advanceStarredIconGateOnNewQuery();
      targetRef.current = null;
      emptyPagesRef.current = [];
      pageIdsRef.current = [];
      setQueryKey(null);
      setRows([]);
      setPages(0);
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      setInput(login ?? '');
      return;
    }
    if (!current) {
      const restored = restoreLastQuery(login);
      if (restored) {
        setInput(restored.memory.target.input);
        pageIdsRef.current = restored.pageIds;
        showQuery(restored.memory, restored.rows);
        return;
      }
      if (login && !input) setInput(login);
      const target = initialTarget(login);
      if (target) {
        const gen = queryGenRef.current;
        void readDbStarredCache(target.key, { allowStale: true }).then((hit) => {
          if (!hit || gen !== queryGenRef.current || targetRef.current) return;
          setInput(target.input);
          void hydrateSnapshot(target, hit, gen);
        });
      }
    }
    // 只跟随登录名变化；用户已输入的内容不覆盖
  }, [login]);

  // 订阅后台图标/缓存补丁，并启用列表平台回填
  useEffect(() => {
    return subscribeIconWrites(({ targets, icon }) => {
      setRows((prev) => {
        let next = prev;
        for (const target of targets) {
          next = patchAppIconList(next, target, icon);
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return subscribeSearchListCachePatches((patcher) => {
      setRows(patcher);
    });
  }, []);

  const { resolvedOtherIds } = useListPlatformBackfill({
    rows,
    setRows,
    seqRef: queryGenRef,
    sharedResolvedOtherIds: platformResolvedOtherIds,
    onConfirmOtherIds: onConfirmPlatformOtherIds,
    forceRefresh: false,
  });

  const remember = (target: StarredTarget, nextPages: number, nextHasMore: boolean) => {
    rememberQuery({ target, pages: nextPages, hasMore: nextHasMore, emptyPages: [...emptyPagesRef.current] });
  };

  const fetchPage = async (target: StarredTarget, page: number, forceRefresh = false) => {
    const res = await tauriApi.listGithubStarred(target.username, page, STARRED_PER_PAGE, forceRefresh);
    if (res.private_ids && res.private_ids.length > 0) recordSharedPrivateRepos(res.private_ids);
    if (res.confirmed_other_ids && res.confirmed_other_ids.length > 0) {
      recordSharedConfirmedOthers(res.confirmed_other_ids);
      onConfirmPlatformOtherIds?.(res.confirmed_other_ids);
    }
    // 同一目标合并屏上旧行的已解析图标，避免同步第 1 页时图标闪烁
    const prev = targetRef.current?.key === target.key ? rowsRef.current : [];
    const assembled = assembleOnlineRowsWithIcons(prev, res.rows);
    if (assembled.length === 0) {
      if (!emptyPagesRef.current.includes(page)) emptyPagesRef.current = [...emptyPagesRef.current, page];
    } else {
      emptyPagesRef.current = emptyPagesRef.current.filter((p) => p !== page);
      writeSearchListCache(cacheKey(target.key, page), assembled, { hasMore: res.has_more });
    }
    return { ...res, rows: assembled };
  };

  /** 同步第 1 页并更新列表；前缀一致时保留已加载的后续页。 */
  const syncFirstPage = async (target: StarredTarget, gen: number, forceRefresh: boolean) => {
    const res = await fetchPage(target, 1, forceRefresh);
    if (gen !== queryGenRef.current) return;
    markNetworkSynced(target.key);
    const firstIds = res.rows.map((r) => normalizeId(r.id)).filter(Boolean);
    const current = rowsRef.current;
    const samePrefix =
      pagesRef.current > 1 &&
      res.rows.length > 0 &&
      current.length >= res.rows.length &&
      res.rows.every((r, i) => normalizeId(current[i]?.id) === normalizeId(r.id));
    if (samePrefix) {
      setRows((prev) => [...res.rows, ...prev.slice(res.rows.length)]);
      setPageIds(1, firstIds);
      remember(target, pagesRef.current, hasMoreRef.current);
      if (res.is_stale !== true) persistPageIds(target, hasMoreRef.current);
      return;
    }
    emptyPagesRef.current = res.rows.length === 0 ? [1] : [];
    pageIdsRef.current = [{ page: 1, ids: firstIds }];
    setRows(res.rows);
    setPages(1);
    setHasMore(res.has_more);
    remember(target, 1, res.has_more);
    if (res.is_stale !== true) persistPageIds(target, res.has_more);
  };

  const handleQuery = async () => {
    const target = resolveTarget(input, login);
    if (!target) {
      setError(t('favorites.username_required'));
      return;
    }
    persistStarredOpts(
      target.username !== undefined ? { mode: 'user', username: target.username } : { mode: 'self' },
    );
    const gen = ++queryGenRef.current;
    advanceStarredIconGateOnNewQuery();
    setError(null);

    const resync = target.key === queryKey && targetRef.current?.key === target.key;
    if (resync) {
      targetRef.current = target;
    } else {
      // 切换目标：先看分页缓存（5min 内直出，零网络）。
      const restored = restoreQuery(target);
      if (restored) {
        pageIdsRef.current = restored.pageIds;
        showQuery({ ...restored.memory, target }, restored.rows);
        if (restored.isFresh) {
          setLoading(false);
          return;
        }
      } else {
        targetRef.current = target;
        emptyPagesRef.current = [];
        pageIdsRef.current = [];
        setQueryKey(target.key);
        setRows([]);
        setPages(0);
        setHasMore(false);
        setLoading(true);
        // 再看快照：12h 内直出；更旧先展示再同步。
        const hit = await readDbStarredCache(target.key, { allowStale: true });
        if (gen !== queryGenRef.current) return;
        if (hit) {
          const shown = await hydrateSnapshot(target, hit, gen);
          if (gen !== queryGenRef.current) return;
          if (shown && hit.isFresh) {
            setLoading(false);
            return;
          }
        }
      }
    }

    // 网络同步第 1 页：显式「同步」当前目标带强刷位，其余为后台重验；旧卡片保留在屏。
    setLoading(true);
    try {
      await syncFirstPage(target, gen, resync);
    } catch (err) {
      if (gen !== queryGenRef.current) return;
      setError(String(err));
    } finally {
      if (gen === queryGenRef.current) setLoading(false);
    }
  };

  // 续拉总是请求 GitHub：是否还有下一页以回包 `has_more`（Link 头）为准，不按行数推测。
  const handleLoadMore = useCallback(async () => {
    const target = targetRef.current;
    if (!target || loading || loadingMore || !hasMore) return;
    const gen = queryGenRef.current;
    const nextPage = pages + 1;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetchPage(target, nextPage);
      if (gen !== queryGenRef.current) return;
      setRows((prev) => appendUniqueOnlineRows(prev, res.rows));
      setPages(nextPage);
      setHasMore(res.has_more);
      setPageIds(nextPage, res.rows.map((r) => normalizeId(r.id)).filter(Boolean));
      remember(target, nextPage, res.has_more);
      if (res.is_stale !== true) persistPageIds(target, res.has_more);
    } catch (err) {
      if (gen !== queryGenRef.current) return;
      setError(String(err));
    } finally {
      if (gen === queryGenRef.current) setLoadingMore(false);
    }
  }, [loading, loadingMore, hasMore, pages]);

  return {
    input,
    setInput,
    queryKey,
    rows,
    hasMore,
    loading,
    loadingMore,
    error,
    resolvedOtherIds,
    handleQuery,
    handleLoadMore,
  };
}
