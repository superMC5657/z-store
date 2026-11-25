import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { ChevronsDown, Globe, Package } from 'lucide-react';
import { CountBadge } from '../components/CountBadge';
import { AppCard } from '../components/AppCard';
import { AppSummary } from '../types';
import { EMPTY_IDS, ViewAppActions, ViewShell, noopAction } from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import { useOnlinePullToLoadMore } from './SearchResultsView/useOnlinePullToLoadMore';
import { useRowAnnotator, useRowIconBackfill } from './shared/useRowAnnotations';
import { isPlatformLoading } from '../lib/platformFilter';
import {
  annotateOnlineCataloged,
  hasIdAliasMatch,
  isInstalled as selectIsInstalled,
  selectManagedState,
} from '../app/selectors';
import { useMoveInToDraft } from '../app/hooks/useMoveInToDraft';
import { normalizeId } from '../services/normalizeId';

/** 本地段每次展开的条数（与在线翻页 `per_page` 一致）。 */
const SEARCH_LOCAL_PAGE = 20;

/** 仅当查询词命中商业平替列表且未命中应用自身名称时，返回对应平替目标名。 */
function matchAlternativeHint(app: AppSummary, query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q || !app.alternatives || app.alternatives.length === 0) return undefined;
  if (app.name.toLowerCase().includes(q)) return undefined;
  return app.alternatives.find((alt) => alt.toLowerCase().includes(q));
}

interface SearchResultsViewProps extends ViewAppActions {
  /** 本地段结果（App 已做平台过滤，保序）。 */
  apps: AppSummary[];
  /** 全量合并目录（用于在线结果收录态比对，避免仅在本地搜索未命中时误降级 is_cataloged）。 */
  catalogApps?: readonly AppSummary[];
  searchQuery: string;
  /** 在线段有结果标记：true 表示当前查询的在线段有结果。 */
  isOnlineResults?: boolean;
  /** 在线段（App 已做平台过滤，保序）。 */
  onlineApps?: AppSummary[];
  /** 本地搜索进行中（防抖等待或 IPC 进行中）。 */
  isSearchingLocal?: boolean;
  /** 在线搜索进行中（首屏与翻页共用）。 */
  isSearchingOnline?: boolean;
  /** 已发起过在线搜索（在线段空时区分「还没搜」与「搜过无结果」）。 */
  onlineSearchPerformed?: boolean;
  /** 在线搜索是否还有下一页。 */
  onlineHasMore?: boolean;
  /** 在线下一页加载中。 */
  isLoadingOnlineMore?: boolean;
  /** 在线下一页：App 负责 page+1 并拼接，失败/限流由 App toast。 */
  onOnlineLoadMore?: () => void;
  /** 用户显式发起在线搜索：首次在线搜索传 `forceRefresh: false`（可命中列表缓存与 ETag）；已搜过再点「重试」传 `true`。 */
  onSearchOnline?: (opts?: { forceRefresh?: boolean }) => void;
}

export const SearchResultsView: React.FC<SearchResultsViewProps> = (props) => {
  const {
    apps,
    catalogApps,
    platformResolvedOtherIds = EMPTY_IDS,
    installedIds = EMPTY_IDS,
    installingIds,
    favoriteIds = EMPTY_IDS,
    managedIds = null,
    searchQuery,
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onToggleFavorite = noopAction,
    watchedIds,
    onToggleWatch,
    isOnlineResults = false,
    onlineApps = [],
    isSearchingLocal = false,
    isSearchingOnline = false,
    onlineSearchPerformed = false,
    onlineHasMore = false,
    isLoadingOnlineMore = false,
    onOnlineLoadMore,
    onSearchOnline,
    customIds,
    localApps,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  const { isMovingIn, handleMoveIn } = useMoveInToDraft();

  // 在线落定处按全量合并目录（缺省回落 apps）显式标注 is_cataloged，本地橘黄叠加同口径；
  // 未传入全量目录时，禁止把已由上层权威标定的 is_cataloged=true 降级回 false。
  const activeOnlineApps = isOnlineResults ? onlineApps : [];
  const annotatedOnlineApps = useMemo(() => {
    const annotated = annotateOnlineCataloged(activeOnlineApps, catalogApps ?? apps, localApps);
    if (catalogApps !== undefined) return annotated;
    return annotated.map((row, idx) => {
      const src = activeOnlineApps[idx];
      if (src?.is_cataloged === true && (src as { source?: unknown }).source !== 'local' && row.is_cataloged !== true) {
        return { ...row, is_cataloged: true };
      }
      return row;
    });
  }, [activeOnlineApps, catalogApps, apps, localApps]);
  const annotate = useRowAnnotator(apps, localApps);

  // ---- 本地段分页：首屏 20，按钮或哨兵 +20；换词或结果集真变化时回到首屏 ----
  const [visibleCount, setVisibleCount] = useState(SEARCH_LOCAL_PAGE);
  const prevQueryRef = useRef(searchQuery);
  const prevAppsRef = useRef<AppSummary[]>(apps);
  useEffect(() => {
    const prev = prevAppsRef.current;
    const queryChanged = prevQueryRef.current !== searchQuery;
    const appended = apps.length >= prev.length && prev.every((a, i) => apps[i]?.id === a.id);
    if (queryChanged || !appended) setVisibleCount(SEARCH_LOCAL_PAGE);
    prevQueryRef.current = searchQuery;
    prevAppsRef.current = apps;
  }, [apps, searchQuery]);

  const displayedLocal = useMemo(
    () => apps.slice(0, visibleCount).map(annotate),
    [apps, visibleCount, annotate],
  );
  const localHasMore = visibleCount < apps.length;
  const onlineActive = isOnlineResults && onlineHasMore;

  const loadLocalMore = useCallback(() => setVisibleCount((c) => c + SEARCH_LOCAL_PAGE), []);
  const loadingRef = useRef(false);
  loadingRef.current = isLoadingOnlineMore;
  // 显式续拉（按钮 / 在线段越界手势）：本地 +20 叠加在线下一页。
  const handleLoadMore = useCallback(() => {
    if (loadingRef.current) return;
    loadLocalMore();
    if (onlineActive && onOnlineLoadMore) onOnlineLoadMore();
  }, [loadLocalMore, onlineActive, onOnlineLoadMore]);

  // 哨兵只续本地段；在线下一页须经 armed 边界条的越界手势或按钮显式触发。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore = localHasMore || onlineActive;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadLocalMore();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadLocalMore, displayedLocal.length]);

  const onlineArmedRef = useOnlinePullToLoadMore({
    enabled: onlineActive,
    loading: isSearchingOnline || isLoadingOnlineMore,
    onLoadMore: handleLoadMore,
  });

  // 仅本地段走 useRowIconBackfill；在线段由后端 fetch_icons_stream(pool=5) + assembleOnlineRowsWithIcons 流式补图，
  // 避免首帧 20 路并发 restoreOrFetchIconCycle 重复探图风暴。
  useRowIconBackfill(displayedLocal);

  const card = (app: AppSummary, extra?: Partial<React.ComponentProps<typeof AppCard>>) => {
    const appKey = normalizeId(app.id);
    return (
      <AppCard
        key={app.id}
        app={app}
        platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
        isInstalled={selectIsInstalled(app.id, installedIds)}
        isManaged={selectManagedState(app.id, managedIds)}
        isInstalling={installingIds?.has(appKey)}
        isFavorite={favoriteIds.has(appKey)}
        isWatched={watchedIds?.has(appKey)}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onToggleWatch={onToggleWatch}
        {...extra}
      />
    );
  };

  return (
    <ViewShell viewClass="home-view search-results-view">
      <div className="section-header" data-testid="search-local-section">
        <h3 className="section-title">
          <Package size={16} />
          <span>{t('search.local_results')}</span>
          <CountBadge value={apps.length} />
        </h3>
      </div>
      {displayedLocal.length > 0 ? (
        <div className="app-grid" data-testid="search-local-grid">
          {displayedLocal.map((app) =>
            card(app, {
              alternativeHint: matchAlternativeHint(app, searchQuery),
            }),
          )}
        </div>
      ) : (
        <div className="feed-end" data-testid="search-local-empty">
          {t('search.local_empty')}
        </div>
      )}
      {localHasMore && (
        <div className="feed-more-row">
          <button
            type="button"
            data-testid="search-local-load-more"
            className="btn-fluent btn-secondary"
            onClick={loadLocalMore}
          >
            {t('search.local_load_more')}
          </button>
        </div>
      )}

      <div className="section-header" style={{ marginTop: '28px' }} data-testid="search-online-section">
        <h3 className="section-title">
          <Globe size={16} />
          <span>{t('search.online_results')}</span>
          <CountBadge value={annotatedOnlineApps.length} />
        </h3>
      </div>
      {annotatedOnlineApps.length > 0 ? (
        <div className="app-grid" data-testid="search-online-grid">
          {annotatedOnlineApps.map((app) =>
            card(app, {
              onMoveInApp: handleMoveIn,
              isMovingIn: isMovingIn(app.id),
              isCustomExisting: hasIdAliasMatch(app, customIds),
            }),
          )}
        </div>
      ) : (
        <div className="feed-end" data-testid="search-online-empty">
          <div>
            {isSearchingLocal
              ? t('search.local_searching')
              : isSearchingOnline
                ? t('search.online_searching')
                : onlineSearchPerformed
                  ? t('search.online_empty')
                  : t('search.online_prompt')}
          </div>
          {!isSearchingLocal && !isSearchingOnline && onSearchOnline && (
            <div className="feed-more-row" style={{ paddingTop: '10px', paddingBottom: 0 }}>
              <button
                type="button"
                data-testid="search-online-trigger"
                className={`btn-fluent ${onlineSearchPerformed ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => onSearchOnline({ forceRefresh: onlineSearchPerformed })}
              >
                <Globe size={14} />
                <span>{onlineSearchPerformed ? t('search.retry_online') : t('search.search_online_btn')}</span>
              </button>
            </div>
          )}
        </div>
      )}
      {(isSearchingOnline || isLoadingOnlineMore) && (
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
      <div ref={sentinelRef} data-testid="feed-sentinel" className="feed-sentinel" aria-hidden="true" />
      {onlineActive ? (
        <div
          ref={onlineArmedRef}
          data-testid="online-armed-boundary"
          className="online-armed"
          data-loading={isSearchingOnline || isLoadingOnlineMore ? 'true' : 'false'}
        >
          <div className="online-armed-line">
            <ChevronsDown size={15} aria-hidden="true" />
            <span>
              {isSearchingOnline || isLoadingOnlineMore
                ? t('search.online_loading_more')
                : t('search.online_armed_more')}
            </span>
            <ChevronsDown size={15} aria-hidden="true" />
          </div>
          <div className="online-armed-sub">
            {t('search.online_armed_hint', { count: annotatedOnlineApps.length })}
          </div>
          <div className="feed-more-row online-armed-btn">
            <button
              type="button"
              data-testid="feed-load-more"
              className="btn-fluent btn-secondary"
              onClick={handleLoadMore}
              disabled={isSearchingOnline || isLoadingOnlineMore}
            >
              {isSearchingOnline || isLoadingOnlineMore ? t('featured.feed_loading') : t('search.online_load_more')}
            </button>
          </div>
        </div>
      ) : (
        annotatedOnlineApps.length > 0 && !onlineHasMore && (
          <div data-testid="feed-end" className="feed-end">
            {t('search.online_end', { count: annotatedOnlineApps.length })}
          </div>
        )
      )}
    </ViewShell>
  );
};
