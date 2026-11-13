import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronsDown, RotateCcw, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppCard } from '../../components/AppCard';
import { EmptyState } from '../../components/EmptyState';
import type { AppSummary, OAuthUser } from '../../types';
import { tauriApi } from '../../services/api';
import {
  readSearchListCache,
  subscribeSearchListCachePatches,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { appendUniqueOnlineRows, assembleOnlineRowsWithIcons } from '../../services/search/onlineRows';
import { normalizeId, normalizeIdLowerSet } from '../../services/normalizeId';
import { patchAppIconList, subscribeIconWrites } from '../../services/iconStore';
import { isPlatformLoading, matchPlatformSetWithLoading, type PlatformId } from '../../lib/platformFilter';
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
const CACHE_NAMESPACE = 'starred';

/** 一次查询：`username` 缺省即查登录账号（`/user/starred`，含私有 Star）；`input` 为当时输入框原文。 */
interface StarredTarget {
  username?: string;
  key: string;
  input: string;
}

/** 最近一次查询的进度（模块级，切页回来据此从分页缓存恢复；只活在内存）。 */
interface StarredQueryMemory {
  target: StarredTarget;
  pages: number;
  hasMore: boolean;
  /** 空页不进分页缓存，恢复时据此跳过。 */
  emptyPages: number[];
}

let lastQuery: StarredQueryMemory | null = null;

/** 测试用：清掉最近一次查询记录。 */
export function resetStarredFeedMemory(): void {
  lastQuery = null;
}

/** 查自己的缓存键绑定登录名：换账号后不会读到上个账号的私有 Star。 */
function selfQueryKey(login: string): string {
  return `@me:${login.toLowerCase()}`;
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
  return { namespace: CACHE_NAMESPACE, query: key, page, perPage: STARRED_PER_PAGE };
}

/** 从分页缓存连续恢复最近一次查询的第 1..pages 页；任一非空页缺失（过期/被挤出）即不恢复。 */
function restoreLastQuery(login: string | undefined): { memory: StarredQueryMemory; rows: AppSummary[] } | null {
  const memory = lastQuery;
  if (!memory || !belongsToLogin(memory.target, login)) return null;
  let rows: AppSummary[] = [];
  for (let p = 1; p <= memory.pages; p++) {
    if (memory.emptyPages.includes(p)) continue;
    const hit = readSearchListCache(cacheKey(memory.target.key, p));
    if (!hit) return null;
    rows = appendUniqueOnlineRows(rows, hit);
  }
  return { memory, rows };
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
 * 每页 20 个，到底后继续下拉或点按钮加载下一页（同搜索页）；已加载页存前端分页缓存，切页回来直接恢复，不落库。
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
  const [input, setInput] = useState(() => initial?.memory.target.input ?? login ?? '');
  const [queryKey, setQueryKey] = useState<string | null>(() => initial?.memory.target.key ?? null);
  const [rows, setRows] = useState<AppSummary[]>(() => initial?.rows ?? []);
  const rowsRef = useRef<AppSummary[]>(rows);
  rowsRef.current = rows;
  const [pages, setPages] = useState(() => initial?.memory.pages ?? 0);
  const [hasMore, setHasMore] = useState(() => initial?.memory.hasMore ?? false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 当前结果对应的查询，续拉以它为准，不受之后改输入框影响。
  const targetRef = useRef<StarredTarget | null>(initial?.memory.target ?? null);
  const emptyPagesRef = useRef<number[]>(initial?.memory.emptyPages ?? []);
  // 每次新查询（或清空）+1：旧查询在途回包一律丢弃。
  const queryGenRef = useRef(0);

  // 登录名变化：显示中的「自己的 Star」若不属于新账号即清空；未查询时补默认用户名，
  // 并尝试恢复该账号上次的结果（挂载时登录信息可能尚未到达）。
  useEffect(() => {
    const current = targetRef.current;
    if (current && !belongsToLogin(current, login)) {
      queryGenRef.current++;
      targetRef.current = null;
      emptyPagesRef.current = [];
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
        targetRef.current = restored.memory.target;
        emptyPagesRef.current = restored.memory.emptyPages;
        setInput(restored.memory.target.input);
        setQueryKey(restored.memory.target.key);
        setRows(restored.rows);
        setPages(restored.memory.pages);
        setHasMore(restored.memory.hasMore);
        return;
      }
      if (login && !input) setInput(login);
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
    lastQuery = { target, pages: nextPages, hasMore: nextHasMore, emptyPages: [...emptyPagesRef.current] };
  };

  const fetchPage = async (target: StarredTarget, page: number) => {
    const res = await tauriApi.listGithubStarred(target.username, page, STARRED_PER_PAGE);
    const assembled = assembleOnlineRowsWithIcons(page === 1 ? [] : rowsRef.current, res.rows);
    if (assembled.length === 0) {
      if (!emptyPagesRef.current.includes(page)) emptyPagesRef.current = [...emptyPagesRef.current, page];
    } else {
      writeSearchListCache(cacheKey(target.key, page), assembled);
    }
    return { ...res, rows: assembled };
  };

  const handleQuery = async () => {
    const target = resolveTarget(input, login);
    if (!target) {
      setError(t('favorites.username_required'));
      return;
    }
    const gen = ++queryGenRef.current;
    targetRef.current = target;
    emptyPagesRef.current = [];
    setLoading(true);
    setError(null);
    setRows([]);
    setPages(0);
    setHasMore(false);
    setQueryKey(target.key);
    try {
      const res = await fetchPage(target, 1);
      if (gen !== queryGenRef.current) return;
      setRows(res.rows);
      setPages(1);
      setHasMore(res.has_more);
      remember(target, 1, res.has_more);
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
      remember(target, nextPage, res.has_more);
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

  useEffect(() => {
    onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  useEffect(() => {
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
              <div className="online-armed-sub">{t('search.online_armed_hint', { count: rows.length })}</div>
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
              {t('favorites.starred_end', { count: rows.length })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
