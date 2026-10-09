import React, { useState, useEffect } from 'react';
import { Bookmark, Eye, Star, RotateCcw, Zap, BookmarkPlus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { AppSummary, OAuthUser, StarredSyncResult } from '../types';
import { tauriApi } from '../services/api';
import { ViewAppActions, ViewShell } from './ViewShell';
import { matchesAppText } from './useViewFilter';

interface FavoritesViewProps extends ViewAppActions {
  platformResolvedOtherIds?: ReadonlySet<string>;
  oauthUser?: OAuthUser | null;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  apps,
  platformResolvedOtherIds,
  favoriteIds,
  watchedIds,
  installedIds,
  installingIds,
  oauthUser,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'local' | 'watched' | 'starred'>('local');
  const [searchText, setSearchText] = useState('');
  const [githubUser, setGithubUser] = useState(oauthUser?.login || '');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<StarredSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (oauthUser?.login && !githubUser) {
      setGithubUser(oauthUser.login);
    }
  }, [oauthUser?.login]);

  const watchedSet = watchedIds || new Set<string>();
  const isPending = (a: AppSummary): boolean => {
    if (a.platforms && a.platforms.length > 0) return false;
    if (!platformResolvedOtherIds) return false;
    return !platformResolvedOtherIds.has(a.id.toLowerCase());
  };

  // FR-6.1: 收藏 / 关注搜索框（按名称 / 别名 / 仓库坐标过滤，见 useViewFilter.matchesAppText）
  const matchesSearch = (a: AppSummary) => matchesAppText(a, searchText);

  // 收藏 left-join 消费侧：`apps` 已由 App 补齐未收录占位行，此处仅做归一大小写 inner 过滤
  // （双键：原值 + 小写均命中，兼容后端/目录大小写不一致）；计数仍用 `favoriteIds.size` 全集。
  const favoriteIdsLower = new Set<string>();
  for (const id of favoriteIds) {
    const k = (id || '').toLowerCase();
    if (k) favoriteIdsLower.add(k);
  }
  const favoriteApps = apps.filter((a) => favoriteIdsLower.has((a.id || '').toLowerCase()) && matchesSearch(a));
  const watchedApps = apps.filter((a) => watchedSet.has(a.id) && matchesSearch(a));

  const handleSyncStarred = async () => {
    setIsSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const res = await tauriApi.syncGithubStarred(githubUser.trim() || undefined);
      setSyncResult(res);
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const [isBatchInstalling, setIsBatchInstalling] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const handleAddAllToFavorites = () => {
    if (!syncResult) return;
    for (const app of syncResult.catalog_matches) {
      if (!favoriteIdsLower.has((app.id || '').toLowerCase())) {
        onToggleFavorite(app.id);
      }
    }
  };

  const handleBatchInstallAll = async () => {
    if (!syncResult) return;
    const toInstall = syncResult.catalog_matches.filter((app) => !installedIds.has(app.id));
    if (toInstall.length === 0) return;
    setIsBatchInstalling(true);
    setBatchError(null);
    try {
      const failures: string[] = [];
      for (const app of toInstall) {
        try {
          await onQuickInstall(app.id);
        } catch (err) {
          failures.push(`${app.name || app.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        setBatchError(t('favorites.batch_error', { failed: failures.length, total: toInstall.length, errors: failures.join('；') }));
      }
    } finally {
      setIsBatchInstalling(false);
    }
  };

  return (
    <ViewShell viewClass="favorites-view">
      {/* 标签导航栏（Linear Segmented Control） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <SegmentedControl
          value={activeTab}
          onChange={setActiveTab}
          options={[
            {
              value: 'local',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Bookmark size={13} strokeWidth={1.5} />
                  <span>{t('favorites.tab_local', { count: favoriteIds.size })}</span>
                </span>
              ),
            },
            {
              value: 'watched',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Eye size={13} strokeWidth={1.5} />
                  <span>{t('favorites.tab_watched', { count: watchedSet.size })}</span>
                </span>
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
                platformPending={isPending(app)}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={true}
                isWatched={watchedSet.has(app.id)}
                showCatalogBadge={true}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        )
      ) : activeTab === 'watched' ? (
        watchedApps.length === 0 ? (
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
                platformPending={isPending(app)}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIdsLower.has((app.id || '').toLowerCase())}
                isWatched={true}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        )
      ) : (
        <div>
          {/* Starred 标星同步操作横幅 */}
          <div
            style={{
              padding: '20px 24px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-acrylic-card)',
              border: '1px solid var(--border-color)',
              marginBottom: '20px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <h4 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 590, letterSpacing: '-0.015em' }}>
                    {t('favorites.sync_starred_title')}
                  </h4>
                  {oauthUser?.login && (
                    <span
                      style={{
                        fontSize: 'var(--font-xs)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-xs)',
                        background: 'var(--brand-subtle)',
                        color: 'var(--brand-primary)',
                        border: '1px solid var(--border-nav-active)',
                        fontWeight: 510,
                      }}
                    >
                      {t('favorites.logged_in_as', { user: oauthUser.login })}
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 'var(--font-base)', color: 'var(--text-secondary)' }}>
                  {t('favorites.sync_starred_desc')}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder={t('favorites.username_placeholder')}
                  value={githubUser}
                  onChange={(e) => setGithubUser(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSyncStarred()}
                  className="settings-input"
                  style={{
                    height: '28px',
                    minWidth: '220px',
                  }}
                />
                <button
                  className="btn-fluent btn-primary"
                  style={{ height: '28px', padding: '0 14px', fontSize: 'calc(12.5px * var(--font-scale))', fontWeight: 510, display: 'flex', alignItems: 'center', gap: '6px' }}
                  disabled={isSyncing}
                  onClick={handleSyncStarred}
                >
                  <RotateCcw size={13} strokeWidth={1.5} className={isSyncing ? 'icon-spin' : ''} />
                  <span>{isSyncing ? t('favorites.syncing') : t('favorites.sync_now')}</span>
                </button>
              </div>
            </div>

            {syncError && (
              <div style={{ marginTop: '12px', fontSize: 'calc(12.5px * var(--font-scale))', color: '#f87171' }}>
                {t('favorites.sync_error', { error: syncError })}
              </div>
            )}
          </div>

          {/* 同步结果展示 */}
          {syncResult ? (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '16px',
                  padding: '10px 16px',
                  borderRadius: '6px',
                  background: 'var(--brand-subtle)',
                  border: '1px solid var(--border-nav-active)',
                }}
              >
                <span style={{ fontSize: 'var(--font-base)', color: 'var(--brand-primary)', fontWeight: 500 }}>
                  {syncResult.total_starred === 0
                    ? t('favorites.starred_zero')
                    : t('favorites.starred_summary', { total: syncResult.total_starred, matched: syncResult.catalog_matches.length })}
                </span>

                {syncResult.catalog_matches.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: 'var(--font-sm)', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                      disabled={isBatchInstalling || syncResult.catalog_matches.every((a) => installedIds.has(a.id))}
                      onClick={handleBatchInstallAll}
                    >
                      {isBatchInstalling ? <RotateCcw size={12} className="icon-spin" /> : <Zap size={12} />}
                      <span>{isBatchInstalling ? t('favorites.batch_installing') : t('favorites.batch_install_btn')}</span>
                    </button>
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: 'var(--font-sm)', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                      onClick={handleAddAllToFavorites}
                    >
                      <BookmarkPlus size={12} />
                      <span>{t('favorites.add_all_favorites')}</span>
                    </button>
                  </div>
                )}
              </div>
              {batchError && (
                <div style={{ marginTop: '8px', fontSize: 'calc(12.5px * var(--font-scale))', color: '#f87171' }}>
                  {batchError}
                </div>
              )}

              {syncResult.catalog_matches.length > 0 ? (
                <div className="app-grid">
                  {syncResult.catalog_matches.map((app, index) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      eager={index < 6}
                      platformPending={isPending(app)}
                      isInstalled={installedIds.has(app.id)}
                      isInstalling={installingIds?.has(app.id)}
                      isFavorite={favoriteIdsLower.has((app.id || '').toLowerCase())}
                      isWatched={watchedSet.has(app.id)}
                      onOpenDetail={onOpenDetail}
                      onQuickInstall={onQuickInstall}
                      onToggleFavorite={onToggleFavorite}
                      onToggleWatch={onToggleWatch}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  style={{ marginTop: '20px' }}
                  description={
                    syncResult.total_starred === 0
                      ? t('favorites.starred_zero_desc')
                      : t('favorites.starred_no_match_desc', { total: syncResult.total_starred })
                  }
                />
              )}
            </div>
          ) : (
            <EmptyState
              icon={<Star size={40} strokeWidth={1.5} />}
              title={t('favorites.not_synced_title')}
              description={t('favorites.not_synced_desc')}
            />
          )}
        </div>
      )}
    </ViewShell>
  );
};
