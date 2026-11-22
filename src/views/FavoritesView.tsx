import React, { useMemo, useState, useEffect, useRef } from 'react';
import { CountLabel } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { Bookmark, Eye, Star, Search, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { AppSummary, WatchUpdatedPayload } from '../types';
import { EMPTY_IDS, FilterEmptyState, ViewAppActions, ViewShell, noopAction, resolvePlatformReset } from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import { isPlatformLoading, type PlatformId } from '../lib/platformFilter';
import { normalizeId, normalizeIdLowerSet } from '../services/normalizeId';
import { isFavoritePlaceholderRow } from '../app/favoritesUncataloged';
import { queueAssembledRowIcons } from '../services/iconStore';
import {
  isInstalled as selectIsInstalled,
  matchesAppText,
  selectManagedState,
  selectPlatformCounts,
} from '../app/selectors';
import { WatchReleasesPanel } from './FavoritesView/WatchReleasesPanel';
import { StarredFeed } from './FavoritesView/StarredFeed';
import { lazyNamed } from '../lib/lazyNamed';

const CollectionShareModal = lazyNamed(() => import('../components/CollectionShareModal'), 'CollectionShareModal');

interface FavoritesViewProps extends ViewAppActions {
  /** 未按平台过滤的收藏/关注池（目录 ∪ 未收录行），供侧栏平台分布与提醒图标查表；缺省回退 pps。 */
  allApps?: readonly AppSummary[];
  onConfirmPlatformOtherIds?: (ids: readonly string[]) => void;
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
  /** 合并后目录全量，供 Star 页显式标注已收录与本地角标。 */
  catalogApps?: readonly AppSummary[];
  /** 占位行手动加载（缓存缺失空壳行经行内按钮拉详情升级富卡；缺席即无按钮）。 */
  onLoadUncatalogedDetail?: (id: string) => void;
  /** 关注应用的待处理新版本提醒（经 zstore://watch-updated 聚合）；有提醒时默认落在「关注」签。 */
  watchNotifications?: WatchUpdatedPayload[];
  onDismissWatch?: (appId: string) => void;
  /** 每次进入「关注」签时调用；是否真正检查关注应用新版本由上层节流（每会话一次）。 */
  onEnterWatchedTab?: () => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = (props) => {
  const {
    apps,
    allApps,
    selectedPlatforms,
    platformResolvedOtherIds = EMPTY_IDS,
    onConfirmPlatformOtherIds,
    onDisplayPlatformCounts,
    onResetPlatformFilter,
    favoriteIds = EMPTY_IDS,
    watchedIds,
    installedIds = EMPTY_IDS,
    installingIds,
    managedIds = null,
    oauthUser,
    catalogApps,
    customIds,
    localApps,
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onToggleFavorite = noopAction,
    onToggleWatch,
    onLoadUncatalogedDetail,
    watchNotifications = [],
    onDismissWatch,
    onEnterWatchedTab,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  type FavoritesTab = 'local' | 'watched' | 'starred';
  const [activeTab, setActiveTab] = useState<FavoritesTab>(() =>
    watchNotifications.length > 0 ? 'watched' : 'local',
  );
  // 有待处理提醒时自动切到「关注」签，除非用户已手动选择过标签页
  const userPickedTabRef = useRef(false);
  const handleTabChange = (tab: FavoritesTab) => {
    userPickedTabRef.current = true;
    setActiveTab(tab);
  };
  useEffect(() => {
    if (watchNotifications.length > 0 && !userPickedTabRef.current) setActiveTab('watched');
  }, [watchNotifications.length]);
  const watchedSet = watchedIds || new Set<string>();
  const hasWatched = watchedSet.size > 0;
  const onEnterWatchedTabRef = useRef(onEnterWatchedTab);
  onEnterWatchedTabRef.current = onEnterWatchedTab;
  useEffect(() => {
    if (activeTab === 'watched' && hasWatched) onEnterWatchedTabRef.current?.();
  }, [activeTab, hasWatched]);
  const [searchText, setSearchText] = useState('');
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const trimmedSearch = searchText.trim();

  // 收藏 / 关注搜索过滤（按名称 / 别名 / 仓库坐标匹配，见 app/selectors.matchesAppText）
  const matchesSearch = (a: AppSummary) => matchesAppText(a, searchText);

  // `apps` 已含未收录补位行并经过平台过滤，此处按小写 id 过滤并计算各签数量
  const favoriteIdsLower = useMemo(() => normalizeIdLowerSet(favoriteIds), [favoriteIds]);
  const watchedIdsLower = useMemo(() => normalizeIdLowerSet(watchedIds || new Set<string>()), [watchedIds]);
  const poolApps = allApps ?? apps;
  const allFavRows = useMemo(
    () => poolApps.filter((a) => favoriteIdsLower.has(normalizeId(a.id))),
    [poolApps, favoriteIdsLower],
  );
  const allWatchRows = useMemo(
    () => poolApps.filter((a) => watchedIdsLower.has(normalizeId(a.id))),
    [poolApps, watchedIdsLower],
  );
  const platformFavRows = apps.filter((a) => favoriteIdsLower.has(normalizeId(a.id)));
  const platformWatchRows = apps.filter((a) => watchedIdsLower.has(normalizeId(a.id)));
  const favoriteApps = platformFavRows.filter(matchesSearch);
  const watchedApps = platformWatchRows.filter(matchesSearch);
  const activeShareApps =
    activeTab === 'local' ? favoriteApps : activeTab === 'watched' ? watchedApps : [];

  // 侧栏平台分布：收藏/关注签上报各自全集（不过平台与页内搜索）；Star 签由 StarredFeed 自行上报。
  const tabPlatformCounts = useMemo(() => {
    if (activeTab === 'local') return selectPlatformCounts(allFavRows, platformResolvedOtherIds);
    if (activeTab === 'watched') return selectPlatformCounts(allWatchRows, platformResolvedOtherIds);
    return null;
  }, [activeTab, allFavRows, allWatchRows, platformResolvedOtherIds]);
  useReportPlatformCounts(tabPlatformCounts, onDisplayPlatformCounts, {
    view: 'favorites',
    resetOnUnmount: true,
  });

  // 「有新版本」面板与下方关注列表同一可见作用域：已在池内的应用须出现在当前关注网格，
  // 不在池内的提醒（无平台信息）仅按页内搜索词匹配名称 / ID。
  const poolIds = useMemo(() => new Set(poolApps.map((a) => normalizeId(a.id))), [poolApps]);
  const visibleWatchIds = new Set(watchedApps.map((a) => normalizeId(a.id)));
  const visibleNotifications = watchNotifications.filter((n) => {
    const key = normalizeId(n.app_id);
    if (poolIds.has(key)) return visibleWatchIds.has(key);
    if (!trimmedSearch) return true;
    const q = trimmedSearch.toLowerCase();
    return (n.app_name || '').toLowerCase().includes(q) || n.app_id.toLowerCase().includes(q);
  });
  const platformReset = resolvePlatformReset(onResetPlatformFilter);
  const clearSearchAction = (
    <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={() => setSearchText('')}>
      {t('favorites.clear_search')}
    </button>
  );

  // 组装落盘补齐：收藏/关注列表 http 远端图标入队（优先命中本地磁盘缓存，未命中/过期时后台拉取落盘，前 30 上限，`data:`/空跳过）。
  useEffect(() => {
    queueAssembledRowIcons(favoriteApps);
    queueAssembledRowIcons(watchedApps);
  }, [favoriteApps, watchedApps]);
  return (
    <ViewShell viewClass="favorites-view">
      {/* 标签导航栏（Linear Segmented Control） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <SegmentedControl
          value={activeTab}
          onChange={handleTabChange}
          size="compact"
          options={[
            {
              value: 'local',
              label: (
                <CountLabel
                  icon={<Bookmark size={13} strokeWidth={1.5} />}
                  label={t('favorites.tab_local')}
                  count={favoriteApps.length}
                  active={activeTab === 'local'}
                />
              ),
            },
            {
              value: 'watched',
              label: (
                <CountLabel
                  icon={<Eye size={13} strokeWidth={1.5} />}
                  label={t('favorites.tab_watched')}
                  count={watchedApps.length}
                  active={activeTab === 'watched'}
                />
              ),
            },
            {
              value: 'starred',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Star size={13} strokeWidth={1.5} />
                  <span>{t('favorites.tab_starred')}</span>
                </span>
              ),
            },
          ]}
        />
        {activeTab !== 'starred' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {activeShareApps.length > 0 && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={() => setIsShareModalOpen(true)}
                title={t('favorites.share_collection_tooltip')}
              >
                <Share2 size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('favorites.share_collection')}</span>
              </button>
            )}
            <div className="fluent-input-search" style={{ minWidth: '220px' }}>
              <Search size={14} />
              <input
                type="text"
                placeholder={t('favorites.search_placeholder')}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {activeTab === 'local' ? (
        favoriteIds.size === 0 ? (
          <EmptyState
            icon={<Bookmark size={40} strokeWidth={1.5} />}
            title={t('favorites.empty_fav_title')}
            description={t('favorites.empty_fav_desc')}
          />
        ) : platformFavRows.length === 0 ? (
          <FilterEmptyState
            icon={<Bookmark size={40} strokeWidth={1.5} />}
            title={t('favorites.fav_filter_empty_title')}
            description={t('favorites.filter_empty_desc')}
            resetLabel={t('favorites.reset_device_filter')}
            onReset={platformReset}
          />
        ) : favoriteApps.length === 0 ? (
          <EmptyState
            icon={<Search size={36} strokeWidth={1.5} />}
            title={t('favorites.no_match_fav')}
            description={t('favorites.no_match_fav_desc')}
            action={clearSearchAction}
          />
        ) : (
          <div className="app-grid">
            {favoriteApps.map((app, index) => (
              <AppCard
                key={app.id}
                app={app}
                eager={index < 6}
                platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                isInstalled={selectIsInstalled(app.id, installedIds)}
                isManaged={selectManagedState(app.id, managedIds)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={true}
                isWatched={watchedIdsLower.has(normalizeId(app.id))}
                showLoadDetail={onLoadUncatalogedDetail !== undefined && isFavoritePlaceholderRow(app)}
                onLoadDetail={onLoadUncatalogedDetail}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        )
      ) : activeTab === 'watched' ? (
        <>
          <WatchReleasesPanel
            notifications={visibleNotifications}
            apps={poolApps}
            onOpenDetail={onOpenDetail}
            onDismiss={onDismissWatch}
          />
          {watchedSet.size === 0 ? (
            <EmptyState
              icon={<Eye size={40} strokeWidth={1.5} />}
              title={t('favorites.empty_watch_title')}
              description={t('favorites.empty_watch_desc')}
            />
          ) : platformWatchRows.length === 0 ? (
            <FilterEmptyState
              icon={<Eye size={40} strokeWidth={1.5} />}
              title={t('favorites.watch_filter_empty_title')}
              description={t('favorites.filter_empty_desc')}
              resetLabel={t('favorites.reset_device_filter')}
              onReset={platformReset}
            />
          ) : watchedApps.length === 0 ? (
            <EmptyState
              icon={<Search size={36} strokeWidth={1.5} />}
              title={t('favorites.no_match_watch')}
              description={t('favorites.no_match_watch_desc')}
              action={clearSearchAction}
            />
          ) : (
            <div className="app-grid">
              {watchedApps.map((app, index) => (
                <AppCard
                  key={app.id}
                  app={app}
                  eager={index < 6}
                  platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                  isInstalled={selectIsInstalled(app.id, installedIds)}
                  isManaged={selectManagedState(app.id, managedIds)}
                  isInstalling={installingIds?.has(app.id)}
                  isFavorite={favoriteIdsLower.has(normalizeId(app.id))}
                  isWatched={true}
                  showLoadDetail={onLoadUncatalogedDetail !== undefined && isFavoritePlaceholderRow(app)}
                  onLoadDetail={onLoadUncatalogedDetail}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                  onToggleWatch={onToggleWatch}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <StarredFeed
          oauthUser={oauthUser}
          selectedPlatforms={selectedPlatforms}
          platformResolvedOtherIds={platformResolvedOtherIds}
          onConfirmPlatformOtherIds={onConfirmPlatformOtherIds}
          onDisplayPlatformCounts={onDisplayPlatformCounts}
          onResetPlatformFilter={onResetPlatformFilter}
          catalogApps={catalogApps}
          customIds={customIds}
          localApps={localApps}
          favoriteIds={favoriteIds}
          watchedIds={watchedIds}
          installedIds={installedIds}
          installingIds={installingIds}
          managedIds={managedIds}
          onOpenDetail={onOpenDetail}
          onQuickInstall={onQuickInstall}
          onToggleFavorite={onToggleFavorite}
          onToggleWatch={onToggleWatch}
        />
      )}

      {isShareModalOpen && activeTab !== 'starred' && (
        <React.Suspense fallback={null}>
          <CollectionShareModal
            apps={activeShareApps}
            defaultTitle={
              activeTab === 'watched'
                ? t('collection.share.default_watched_title')
                : t('collection.share.default_favorites_title')
            }
            onClose={() => setIsShareModalOpen(false)}
          />
        </React.Suspense>
      )}
    </ViewShell>
  );
};
