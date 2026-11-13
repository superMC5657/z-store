import React, { useState, useEffect, useRef } from 'react';
import { CountLabel } from '../components/CountBadge';
import { Bookmark, Eye, Star, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { AppSummary, OAuthUser, WatchUpdatedPayload } from '../types';
import { ViewAppActions, ViewShell } from './ViewShell';
import { isPlatformLoading } from '../lib/platformFilter';
import { normalizeId, normalizeIdLowerSet } from '../services/normalizeId';
import { isFavoritePlaceholderRow } from '../app/favoritesUncataloged';
import { queueAssembledRowIcons } from '../services/iconStore';
import { isInstalled as selectIsInstalled, matchesAppText, selectManagedState } from '../app/selectors';
import { WatchReleasesPanel } from './FavoritesView/WatchReleasesPanel';
import { StarredFeed } from './FavoritesView/StarredFeed';

interface FavoritesViewProps extends ViewAppActions {
  platformResolvedOtherIds?: ReadonlySet<string>;
  oauthUser?: OAuthUser | null;
  /** 占位行手动加载（缓存缺失空壳行经行内按钮拉详情升级富卡；缺席即无按钮）。 */
  onLoadUncatalogedDetail?: (id: string) => void;
  /** 关注应用的待处理新版本提醒（经 zstore://watch-updated 聚合）；有提醒时默认落在「关注」签。 */
  watchNotifications?: WatchUpdatedPayload[];
  onDismissWatch?: (appId: string) => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  apps,
  platformResolvedOtherIds = new Set<string>(),
  favoriteIds,
  watchedIds,
  installedIds,
  installingIds,
  managedIds = null,
  oauthUser,
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
  // loading 徽标口径统一经选择器接口。

  // 收藏 / 关注搜索过滤（按名称 / 别名 / 仓库坐标匹配，见 app/selectors.matchesAppText）
  const matchesSearch = (a: AppSummary) => matchesAppText(a, searchText);

  // 收藏 left-join 消费侧：`apps` 已由 App 补齐未收录行（缓存命中为富卡行、
  // 未命中为占位行，同形 `AppSummary`），此处仅做归一大小写 inner 过滤
  // （双键：原值 + 小写均命中；键构造经前端唯一口 `normalizeId`）；计数仍用 `favoriteIds.size` 全集。
  const favoriteIdsLower = normalizeIdLowerSet(favoriteIds);
  // 关注同口径小写归一（与收藏分支一致）；计数仍用 `watchedSet.size` 全集。
  const watchedIdsLower = normalizeIdLowerSet(watchedSet);
  const favoriteApps = apps.filter((a) => favoriteIdsLower.has(normalizeId(a.id)) && matchesSearch(a));
  const watchedApps = apps.filter((a) => watchedIdsLower.has(normalizeId(a.id)) && matchesSearch(a));

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
                  count={favoriteIds.size}
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
                  count={watchedSet.size}
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
        favoriteApps.length === 0 ? (
          <EmptyState
            icon={<Bookmark size={40} strokeWidth={1.5} />}
            title={searchText.trim() ? t('favorites.no_match_fav') : t('favorites.empty_fav_title')}
            description={
              searchText.trim()
                ? t('favorites.no_match_fav_desc')
                : t('favorites.empty_fav_desc')
            }
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
            notifications={watchNotifications}
            apps={apps}
            onOpenDetail={onOpenDetail}
            onDismiss={onDismissWatch}
          />
          {watchedApps.length === 0 ? (
            <EmptyState
              icon={<Eye size={40} strokeWidth={1.5} />}
              title={
                searchText.trim()
                  ? t('favorites.no_match_watch')
                  : watchedSet.size > 0
                  ? t('favorites.watch_not_in_catalog')
                  : t('favorites.empty_watch_title')
              }
              description={
                searchText.trim()
                  ? t('favorites.no_match_watch_desc')
                  : t('favorites.empty_watch_desc')
              }
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
          platformResolvedOtherIds={platformResolvedOtherIds}
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
