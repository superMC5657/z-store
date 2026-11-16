import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronsDown, RotateCcw, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppCard } from '../../components/AppCard';
import { EmptyState } from '../../components/EmptyState';
import type { AppSummary, OAuthUser } from '../../types';
import { tauriApi } from '../../services/api';
import {
  readSearchListCacheEntry,
  subscribeSearchListCachePatches,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { appendUniqueOnlineRows, assembleOnlineRowsWithIcons } from '../../services/search/onlineRows';
import { normalizeId, normalizeIdLowerSet } from '../../services/normalizeId';
import { patchAppIconList, subscribeIconWrites } from '../../services/iconStore';
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
import {
  isPlatformLoading,
  matchPlatformSetWithLoading,
  type PlatformId,
} from '../../lib/platformFilter';
import { useListPlatformBackfill } from '../../app/hooks/usePlatformBackfill';
import { useMoveInToDraft } from '../../app/hooks/useMoveInToDraft';
import { isAppCataloged } from '../../utils/appHelper';
import {
  annotateLocalSource,
  annotateOnlineCataloged,
  hasIdAliasMatch,
  isInstalled as selectIsInstalled,
  selectManagedState,
  selectPlatformCounts,
} from '../../app/selectors';
import { useOnlinePullToLoadMore } from '../SearchResultsView/useOnlinePullToLoadMore';
import { FilterEmptyState, resolvePlatformReset, type ViewAppActions } from '../ViewShell';

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

/**
 * 从分页缓存恢复某目标的第 1..pages 页；任一非空页缺失（过期/被挤出）即不恢复。
 * 没有查询记录但第 1 页仍在缓存时只恢复第 1 页（满页即视为还有下一页）。
 */
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

interface StarredFeedProps
  extends Pick<
    ViewAppActions,
    | 'favoriteIds'
    | 'watchedIds'
    | 'installedIds'
    | 'installingIds'
    | 'managedIds'
    | 'onOpenDetail'
    | 'onQuickInstall'
    | 'onToggleFavorite'
    | 'onToggleWatch'
  > {
  oauthUser?: OAuthUser | null;
  selectedPlatforms?: ReadonlySet<string>;
  platformResolvedOtherIds: ReadonlySet<string>;
  onConfirmPlatformOtherIds?: (ids: readonly string[]) => void;
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
  onResetPlatformFilter?: () => void;
  /** 合并后目录全量（远端 + 本地收录），供显式标注 is_cataloged 与叠加本地橘黄角标。 */
  catalogApps?: readonly AppSummary[];
  /** custom 草稿已存在 id 集（归一小写），命中时隐藏“移入收录”入口。 */
  customIds?: ReadonlySet<string>;
  /** 本地收录全量（仅 collected/submitted 未归档），叠加橘黄角标。 */
  localApps?: readonly AppSummary[];
}

/**
 * 收藏页「Star 同步」：查询任意 GitHub 用户（或登录账号）的 Star 列表，按 Star 时间倒序逐页展示应用卡片。
 * 每页 20 个，到底后继续下拉或点按钮加载下一页（同搜索页）。
 * - 进入视图：先从分页缓存恢复最近一次查询；没有则读 SQLite 快照（`starred_feed_cache`）零网络直展，
 *   不自动联网（收藏页手动同步）；
 * - 切换目标：分页缓存 5min 内直出，5–30min 先展示再后台同步第 1 页；否则读快照（12h 内直出，更旧先展示再同步）；
 * - 对当前目标点「同步」：旧卡片保留在屏，第 1 页经后端 ETag 条件请求更新（未变 304 零配额）；
 * - 快照只存前 3 页有序 id：与 GitHub 同步第 1 页或续拉成功时直接写一次，卡片平台/图标变更不重写；
 *   快照恢复经 `hydrateCardsByIds` 一次水合（目录 + `repo_card_cache` + 确认图标）；登出即清 `@me:` 私有缓存。
 */
export const StarredFeed: React.FC<StarredFeedProps> = ({
  oauthUser,
  selectedPlatforms,
  platformResolvedOtherIds,
  onConfirmPlatformOtherIds,
  onDisplayPlatformCounts,
  onResetPlatformFilter,
  catalogApps,
  customIds,
  localApps,
  favoriteIds,
  watchedIds,
  installedIds,
  installingIds,
  managedIds = null,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
}) => {
  const { t } = useTranslation();
  const login = oauthUser?.login || undefined;
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

  /**
   * 快照首绘：按页 id 一次批量水合（目录 → 共享富卡池 → `repo_card_cache` + 确认图标），
   * 已确认 Other 上报平台落定；新鲜快照同时铺进分页缓存。查询已切换或账号已变即丢弃。
   * 返回是否已上屏。
   */
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

  // 登录名变化：登出/换账号即清内存里的 `@me:` 私有缓存；显示中的「自己的 Star」若不属于新账号即清空；
  // 未查询时补默认用户名，并尝试恢复该账号上次的结果（挂载时登录信息可能尚未到达），
  // 分页缓存没有就读 SQLite 快照零网络直展。
  useEffect(() => {
    // 只认本次挂载内观察到的变化：挂载时登录信息可能尚未到达，不算登出（App 级另有全局清理）。
    const prevLogin = prevLoginRef.current;
    prevLoginRef.current = login;
    if (prevLogin && prevLogin !== login) forgetPrivateStarredQueries();
    const current = targetRef.current;
    if (current && !belongsToLogin(current, login)) {
      queryGenRef.current++;
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

  // 与在线搜索走同一套后处理流水线：
  // 1) 订阅后台流式图标写透 + 详情/缓存行写透；
  // 2) 轻量平台回填（forceRefresh=false 优先命中 TTL 缓存，miss 再探 releases/latest）+ 15s settle 落定为 Other。
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
    rowsRef,
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
    // 同一目标沿用屏上旧行做图标粘性合并（同步第 1 页时不闪空图标）。
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

  /**
   * 同步第 1 页并替换屏上结果；新第 1 页与屏上前缀一致时保留已加载的后续页。
   * 失败抛给调用方（屏上旧卡片不动）。
   */
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

  const armedRef = useOnlinePullToLoadMore({
    enabled: hasMore,
    loading: loading || loadingMore,
    onLoadMore: () => void handleLoadMore(),
  });

  const { isMovingIn, handleMoveIn } = useMoveInToDraft();

  // 与在线搜索 / 趋势榜对齐：显式标注 is_cataloged（命中目录或本地收录即隐藏移入入口），
  // 并对本地收录行叠加橘黄 local 角标（蓝标优先，独立单测未传目录时保留行自身标注）。
  const annotatedRows = useMemo(
    () =>
      catalogApps !== undefined
        ? annotateOnlineCataloged(rows, catalogApps, localApps)
        : localApps !== undefined
          ? rows.map((r) => annotateLocalSource(r, localApps))
          : rows,
    [rows, catalogApps, localApps],
  );

  // 全局设备平台过滤：加载中行恒可见，落定后再按 selectedPlatforms 过滤。
  const filteredRows = useMemo(() => {
    if (!selectedPlatforms) return annotatedRows;
    return annotatedRows.filter((app) =>
      matchPlatformSetWithLoading(app, selectedPlatforms, resolvedOtherIds),
    );
  }, [annotatedRows, selectedPlatforms, resolvedOtherIds]);

  // 上报已加载 Star 列表的平台分布（加载中行暂不计数，未拉取/空列表上报 null 回落收录库）。
  const displayPlatformCounts = useMemo<Record<PlatformId, number> | null>(() => {
    if (queryKey === null || annotatedRows.length === 0) return null;
    return selectPlatformCounts(annotatedRows, resolvedOtherIds);
  }, [queryKey, annotatedRows, resolvedOtherIds]);

  useLayoutEffect(() => {
    onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  useLayoutEffect(() => {
    return () => {
      onDisplayPlatformCounts?.(null);
    };
  }, [onDisplayPlatformCounts]);

  const favoriteIdsLower = normalizeIdLowerSet(favoriteIds);
  const watchedIdsLower = normalizeIdLowerSet(watchedIds || new Set<string>());
  const unfavoritedCataloged = filteredRows.filter(
    (app) => isAppCataloged(app) && !favoriteIdsLower.has(normalizeId(app.id)),
  );
  const handleFavoriteLoadedCataloged = () => {
    for (const app of unfavoritedCataloged) onToggleFavorite(app.id);
  };

  return (
    <div>
      <div className="starred-banner">
        <div className="starred-banner-row">
          <div>
            <div className="starred-banner-title">
              <h4>{t('favorites.sync_starred_title')}</h4>
              {login && <span className="starred-login-chip">{t('favorites.logged_in_as', { user: login })}</span>}
            </div>
            <p className="starred-banner-desc">{t('favorites.sync_starred_desc')}</p>
          </div>
          <div className="starred-banner-actions">
            <input
              type="text"
              placeholder={t('favorites.username_placeholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleQuery()}
              className="settings-input"
            />
            <button
              type="button"
              className="btn-fluent btn-primary btn-compact"
              disabled={loading}
              onClick={() => void handleQuery()}
            >
              <RotateCcw size={13} strokeWidth={1.5} className={loading ? 'icon-spin' : ''} />
              <span>{loading ? t('favorites.syncing') : t('favorites.sync_now')}</span>
            </button>
          </div>
        </div>
        {error && <div className="starred-error">{t('favorites.sync_error', { error })}</div>}
      </div>

      {queryKey === null ? (
        <EmptyState
          icon={<Star size={40} strokeWidth={1.5} />}
          title={t('favorites.not_synced_title')}
          description={t('favorites.not_synced_desc')}
        />
      ) : loading && rows.length === 0 ? (
        <div className="starred-loading">{t('favorites.syncing')}</div>
      ) : rows.length === 0 ? (
        !error && <EmptyState style={{ marginTop: '20px' }} description={t('favorites.starred_zero_desc')} />
      ) : (
        <>
          <div className="starred-toolbar">
            <span>{t('favorites.starred_order_hint')}</span>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact"
              disabled={unfavoritedCataloged.length === 0}
              onClick={handleFavoriteLoadedCataloged}
            >
              <BookmarkPlus size={13} />
              <span>{t('favorites.favorite_loaded_cataloged')}</span>
            </button>
          </div>
          {filteredRows.length === 0 ? (
            <FilterEmptyState
              icon={<Star size={40} strokeWidth={1.5} />}
              title={t('favorites.starred_filter_empty_title')}
              description={t('favorites.starred_filter_empty_desc')}
              resetLabel={t('favorites.reset_device_filter')}
              onReset={resolvePlatformReset(onResetPlatformFilter)}
            />
          ) : (
            <div className="app-grid" data-testid="starred-grid">
              {filteredRows.map((app, index) => (
                <AppCard
                  key={app.id}
                  app={app}
                  eager={index < 6}
                  platformLoading={isPlatformLoading(app, resolvedOtherIds)}
                  isInstalled={selectIsInstalled(app.id, installedIds)}
                  isManaged={selectManagedState(app.id, managedIds)}
                  isInstalling={installingIds?.has(app.id)}
                  isFavorite={favoriteIdsLower.has(normalizeId(app.id))}
                  isWatched={watchedIdsLower.has(normalizeId(app.id))}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                  onToggleWatch={onToggleWatch}
                  onMoveInApp={handleMoveIn}
                  isMovingIn={isMovingIn(app.id)}
                  isCustomExisting={hasIdAliasMatch(app, customIds)}
                />
              ))}
            </div>
          )}
          {hasMore ? (
            <div
              ref={armedRef}
              data-testid="starred-armed-boundary"
              className="online-armed"
              data-loading={loadingMore ? 'true' : 'false'}
            >
              <div className="online-armed-line">
                <ChevronsDown size={15} aria-hidden="true" />
                <span>{loadingMore ? t('search.online_loading_more') : t('search.online_armed_more')}</span>
                <ChevronsDown size={15} aria-hidden="true" />
              </div>
              <div className="online-armed-sub">{t('search.online_armed_hint', { count: filteredRows.length })}</div>
              <div className="feed-more-row online-armed-btn">
                <button
                  type="button"
                  data-testid="starred-load-more"
                  className="btn-fluent btn-secondary"
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? t('featured.feed_loading') : t('favorites.starred_load_more')}
                </button>
              </div>
            </div>
          ) : filteredRows.length > 0 ? (
            <div data-testid="starred-end" className="feed-end">
              {t('favorites.starred_end', { count: filteredRows.length })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
