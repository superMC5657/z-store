import React, { useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronsDown, RotateCcw, Star } from 'lucide-react';
import { useReportPlatformCounts } from '../../app/hooks/useReportPlatformCounts';
import { useTranslation } from 'react-i18next';
import { AppCard } from '../../components/AppCard';
import { EmptyState } from '../../components/EmptyState';
import { notifyToast } from '../../useToasts';
import type { AppSummary, OAuthUser } from '../../types';
import { normalizeId, normalizeIdLowerSet } from '../../services/normalizeId';
import {
  isPlatformLoading,
  matchPlatformSetWithLoading,
  type PlatformId,
} from '../../lib/platformFilter';
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
import { FilterEmptyState, resolvePlatformReset } from '../ViewShell';
import type { AppActions, AppContextProps, LibraryState } from '../../app/AppContext';
import { useStarredFeed } from './useStarredFeed';

export { STARRED_PER_PAGE, resetStarredFeedMemory } from './useStarredFeed';

interface StarredFeedProps
  extends Pick<LibraryState, 'favoriteIds' | 'installedIds'>,
    Pick<AppActions, 'onOpenDetail' | 'onQuickInstall' | 'onToggleFavorite'>,
    Pick<AppContextProps, 'watchedIds' | 'installingIds' | 'managedIds' | 'onToggleWatch'> {
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
 * 收藏页「Star 同步」标签页：按 Star 时间倒序分页展示指定账号的 GitHub Star 列表，
 * 支持 L1 分页缓存与 SQLite L2 快照恢复，以及 ETag 条件同步和上拉/点击续页。
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
  const {
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
  } = useStarredFeed({ login, catalogApps, localApps, platformResolvedOtherIds, onConfirmPlatformOtherIds });

  const armedRef = useOnlinePullToLoadMore({
    enabled: hasMore,
    loading: loading || loadingMore,
    onLoadMore: () => void handleLoadMore(),
  });

  const { isMovingIn, handleMoveIn } = useMoveInToDraft();

  // 显式标注收录态与本地收录角标（未传入目录时保留行自身标注）
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

  useReportPlatformCounts(displayPlatformCounts, onDisplayPlatformCounts, {
    view: 'favorites',
    reportNull: true,
    resetOnUnmount: true,
  });

  const favoriteIdsLower = normalizeIdLowerSet(favoriteIds);
  const watchedIdsLower = normalizeIdLowerSet(watchedIds || new Set<string>());
  const [isBatchFavoriting, setIsBatchFavoriting] = useState(false);
  const batchFavRef = useRef(false);
  const unfavoritedCataloged = filteredRows.filter(
    (app) => isAppCataloged(app) && !favoriteIdsLower.has(normalizeId(app.id)),
  );
  const handleFavoriteLoadedCataloged = async () => {
    if (batchFavRef.current || unfavoritedCataloged.length === 0) return;
    batchFavRef.current = true;
    setIsBatchFavoriting(true);
    const targets = [...unfavoritedCataloged];
    let added = 0;
    let failed = 0;
    try {
      for (const app of targets) {
        try {
          const ok = await onToggleFavorite(app.id, { silent: true });
          if (ok === false) failed += 1;
          else added += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      batchFavRef.current = false;
      setIsBatchFavoriting(false);
    }
    if (added > 0 && failed === 0) {
      notifyToast(t('collection.preview.favorite_all_done', { count: added }), 'success');
    } else if (added > 0 && failed > 0) {
      notifyToast(t('collection.preview.favorite_all_partial', { added, failed }), 'warning');
    } else if (failed > 0) {
      notifyToast(t('collection.preview.favorite_all_failed', { failed }), 'error');
    }
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
              disabled={isBatchFavoriting || unfavoritedCataloged.length === 0}
              onClick={() => void handleFavoriteLoadedCataloged()}
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
                  isInstalling={installingIds?.has(normalizeId(app.id))}
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
