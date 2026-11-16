import React, { useMemo, useState, useEffect, useRef } from 'react';
import { CountLabel } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { Bookmark, Eye, Star, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { AppSummary, OAuthUser, WatchUpdatedPayload } from '../types';
import { FilterEmptyState, ViewAppActions, ViewShell, resolvePlatformReset } from './ViewShell';
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

interface FavoritesViewProps extends ViewAppActions {
  /** 未按平台过滤的收藏/关注池（目录 ∪ 未收录行），供侧栏平台分布与提醒图标查表；缺省回退 pps。 */
  allApps?: readonly AppSummary[];
  selectedPlatforms?: ReadonlySet<string>;
  platformResolvedOtherIds?: ReadonlySet<string>;
  onConfirmPlatformOtherIds?: (ids: readonly string[]) => void;
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
  onResetPlatformFilter?: () => void;
  oauthUser?: OAuthUser | null;
  /** 合并后目录全量，供 Star 页显式标注已收录与本地角标。 */
  catalogApps?: readonly AppSummary[];
  /** custom 草稿已存在 id 集（归一小写），供 Star 页隐藏已存在移入入口。 */
  customIds?: ReadonlySet<string>;
  /** 本地收录全量，供 Star 页叠加橘黄 local 角标。 */
  localApps?: readonly AppSummary[];
  /** 占位行手动加载（缓存缺失空壳行经行内按钮拉详情升级富卡；缺席即无按钮）。 */
  onLoadUncatalogedDetail?: (id: string) => void;
  /** 关注应用的待处理新版本提醒（经 zstore://watch-updated 聚合）；有提醒时默认落在「关注」签。 */
  watchNotifications?: WatchUpdatedPayload[];
  onDismissWatch?: (appId: string) => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  apps,
  allApps,
  selectedPlatforms,
  platformResolvedOtherIds = new Set<string>(),
  onConfirmPlatformOtherIds,
  onDisplayPlatformCounts,
  onResetPlatformFilter,
  favoriteIds,
  watchedIds,
  installedIds,
  installingIds,
  managedIds = null,
  oauthUser,
  catalogApps,
  customIds,
  localApps,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
  onLoadUncatalogedDetail,
  watchNotifications = [],
  onDismissWatch,
}) => {
  const { t } = useTranslation();
  type FavoritesTab = 'local' | 'watched' | 'starred';
  const [activeTab, setActiveTab] = useState<FavoritesTab>(() =>
    watchNotifications.length > 0 ? 'watched' : 'local',
  );
  // 有待处理提醒时落在「关注」签：页面打开后才到的提醒也切过去，但用户手动选过签就不再打扰
  const userPickedTabRef = useRef(false);
  const handleTabChange = (tab: FavoritesTab) => {
    userPickedTabRef.current = true;
    setActiveTab(tab);
  };
  useEffect(() => {
    if (watchNotifications.length > 0 && !userPickedTabRef.current) setActiveTab('watched');
  }, [watchNotifications.length]);
  const [searchText, setSearchText] = useState('');
  const watchedSet = watchedIds || new Set<string>();
  const trimmedSearch = searchText.trim();

  // 收藏 / 关注搜索过滤（按名称 / 别名 / 仓库坐标匹配，见 app/selectors.matchesAppText）
  const matchesSearch = (a: AppSummary) => matchesAppText(a, searchText);

  // 收藏 left-join 消费侧：`apps` 已由 App 补齐未收录行（缓存命中为富卡行、
  // 未命中为占位行，同形 `AppSummary`）并按平台过滤，此处仅做归一大小写 inner 过滤
  // （键构造经前端唯一口 `normalizeId`）。三层：未过平台全集 → 已过平台 → 已过平台 + 页内搜索；
  // Tab 角标取最后一层，恒等于网格卡片数。
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

  // 侧栏平台分布：收藏/关注签上报各自全集（不过平台与页内搜索）；Star 签由 StarredFeed 自行上报。
  const tabPlatformCounts = useMemo(() => {
    if (activeTab === 'local') return selectPlatformCounts(allFavRows, platformResolvedOtherIds);
    if (activeTab === 'watched') return selectPlatformCounts(allWatchRows, platformResolvedOtherIds);
    return null;
  }, [activeTab, allFavRows, allWatchRows, platformResolvedOtherIds]);
  useReportPlatformCounts(tabPlatformCounts, onDisplayPlatformCounts, {
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
          <div className="fluent-input-search" style={{ minWidth: '220px' }}>
            <Search size={14} />
            <input
              type="text"
              placeholder={t('favorites.search_placeholder')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
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
    </ViewShell>
  );
};
