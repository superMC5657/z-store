import React, { useState, useEffect } from 'react';
import { AppCard } from '../components/AppCard';
import { AppSummary, OAuthUser, StarredSyncResult } from '../types';
import { api } from '../services/api';

interface FavoritesViewProps {
  apps: AppSummary[];
  favoriteIds: Set<string>;
  watchedIds?: Set<string>;
  installedIds: Set<string>;
  installingIds?: Set<string>;
  oauthUser?: OAuthUser | null;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleWatch?: (id: string) => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  apps,
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

  // FR-6.1: 收藏 / 关注搜索框（按名称 / 别名 / 仓库坐标过滤）
  const matchesSearch = (a: AppSummary) => {
    const q = searchText.trim().toLowerCase();
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      a.owner.toLowerCase().includes(q) ||
      a.repo.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.category_name.toLowerCase().includes(q)
    );
  };

  const favoriteApps = apps.filter((a) => favoriteIds.has(a.id) && matchesSearch(a));
  const watchedApps = apps.filter((a) => watchedSet.has(a.id) && matchesSearch(a));

  const handleSyncStarred = async () => {
    setIsSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const res = await api.syncGithubStarred(githubUser.trim() || undefined);
      setSyncResult(res);
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const [isBatchInstalling, setIsBatchInstalling] = useState(false);

  const handleAddAllToFavorites = () => {
    if (!syncResult) return;
    for (const app of syncResult.catalog_matches) {
      if (!favoriteIds.has(app.id)) {
        onToggleFavorite(app.id);
      }
    }
  };

  const handleBatchInstallAll = async () => {
    if (!syncResult) return;
    const toInstall = syncResult.catalog_matches.filter((app) => !installedIds.has(app.id));
    if (toInstall.length === 0) return;
    setIsBatchInstalling(true);
    for (const app of toInstall) {
      await onQuickInstall(app.id);
    }
    setIsBatchInstalling(false);
  };

  return (
    <div className="favorites-view view-entrance">
      {/* Tab Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            className={`btn-fluent ${activeTab === 'local' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
            onClick={() => setActiveTab('local')}
          >
            🔖 本地收藏 ({favoriteIds.size})
          </button>
          <button
            className={`btn-fluent ${activeTab === 'watched' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
            onClick={() => setActiveTab('watched')}
          >
            👁 关注更新 ({watchedSet.size})
          </button>
          <button
            className={`btn-fluent ${activeTab === 'starred' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
            onClick={() => setActiveTab('starred')}
          >
            🌟 GitHub Star 同步
          </button>
        </div>
        {activeTab !== 'starred' && (
          <input
            type="text"
            placeholder="搜索名称 / 别名 / owner/repo..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{
              padding: '7px 12px',
              fontSize: '13px',
              borderRadius: '6px',
              border: '1px solid var(--border-acrylic)',
              background: 'rgba(0, 0, 0, 0.2)',
              color: 'var(--text-primary)',
              outline: 'none',
              minWidth: '220px',
            }}
          />
        )}
      </div>

      {activeTab === 'local' ? (
        favoriteApps.length === 0 ? (
          <div className="empty-state-card">
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>⭐️</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>
              {searchText.trim() ? '没有匹配的收藏应用' : '收藏夹还是空的'}
            </h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              {searchText.trim()
                ? '换个关键词试试，或清空搜索框查看全部收藏。'
                : '在应用卡片或详情页中点击星标收藏，常用利器一键集中收纳；或切换至「GitHub Starred 仓库同步」一键批量导入！'}
            </p>
          </div>
        ) : (
          <div className="app-grid">
            {favoriteApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={true}
                isWatched={watchedSet.has(app.id)}
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
          <div className="empty-state-card">
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>👁</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>
              {searchText.trim() ? '没有匹配的关注应用' : watchedSet.size > 0 ? '关注的应用暂不在当前清单中' : '还没有关注任何应用'}
            </h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              {searchText.trim()
                ? '换个关键词试试，或清空搜索框查看全部关注。'
                : '在应用卡片或详情页点击眼睛图标关注，发布新版本时将在应用内第一时间提醒你。'}
            </p>
          </div>
        ) : (
          <div className="app-grid">
            {watchedApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIds.has(app.id)}
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
          {/* Starred Sync Controls Banner */}
          <div
            style={{
              padding: '20px 24px',
              borderRadius: 'var(--radius-lg, 10px)',
              background: 'var(--bg-acrylic-thin, rgba(255, 255, 255, 0.05))',
              border: '1px solid var(--border-acrylic, rgba(255, 255, 255, 0.1))',
              marginBottom: '24px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <h4 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                    同步 GitHub Starred 开源项目
                  </h4>
                  {oauthUser?.login && (
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: 'var(--brand-subtle)',
                        color: 'var(--brand-primary)',
                        border: '1px solid var(--border-nav-active)',
                      }}
                    >
                      已登录: @{oauthUser.login}
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                  直接输入 GitHub 用户名，或使用已登录账号，自动扫描您已 Star 的开源软件并与 Z-Store 匹配接管安装。
                </p>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="GitHub 用户名（如 torvalds）"
                  value={githubUser}
                  onChange={(e) => setGithubUser(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSyncStarred()}
                  style={{
                    padding: '7px 12px',
                    fontSize: '13px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-acrylic)',
                    background: 'rgba(0, 0, 0, 0.2)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    minWidth: '220px',
                  }}
                />
                <button
                  className="btn-fluent btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
                  disabled={isSyncing}
                  onClick={handleSyncStarred}
                >
                  {isSyncing ? '正在拉取...' : '🔄 立即同步'}
                </button>
              </div>
            </div>

            {syncError && (
              <div style={{ marginTop: '12px', fontSize: '12.5px', color: '#f87171' }}>
                同步异常: {syncError}
              </div>
            )}
          </div>

          {/* Sync Results */}
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
                <span style={{ fontSize: '13px', color: 'var(--brand-primary)', fontWeight: 500 }}>
                  {syncResult.total_starred === 0
                    ? '该 GitHub 账号当前星标 (Starred) 仓库数量为 0'
                    : `✓ 共扫描到 ${syncResult.total_starred} 个 Starred 仓库，其中 ${syncResult.catalog_matches.length} 个已收录于 Z-Store`}
                </span>

                {syncResult.catalog_matches.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      disabled={isBatchInstalling || syncResult.catalog_matches.every((a) => installedIds.has(a.id))}
                      onClick={handleBatchInstallAll}
                    >
                      {isBatchInstalling ? '⏳ 批量安装中...' : '⚡ 一键批量装机'}
                    </button>
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      onClick={handleAddAllToFavorites}
                    >
                      📥 全部纳入收藏
                    </button>
                  </div>
                )}
              </div>

              {syncResult.catalog_matches.length > 0 ? (
                <div className="app-grid">
                  {syncResult.catalog_matches.map((app) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      isInstalled={installedIds.has(app.id)}
                      isInstalling={installingIds?.has(app.id)}
                      isFavorite={favoriteIds.has(app.id)}
                      isWatched={watchedSet.has(app.id)}
                      onOpenDetail={onOpenDetail}
                      onQuickInstall={onQuickInstall}
                      onToggleFavorite={onToggleFavorite}
                      onToggleWatch={onToggleWatch}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state-card" style={{ marginTop: '20px' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    {syncResult.total_starred === 0
                      ? '该账号在 GitHub 上尚未星标（Star）任何公开仓库。'
                      : `您 Star 的 ${syncResult.total_starred} 个开源项目中暂未匹配到 Z-Store 已收录的应用。您可在主页搜索栏直接输入 owner/repo 实时检索并一键安装。`}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state-card">
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>🌟</div>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>尚未同步 Starred 仓库</h4>
              <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
                在上方输入 GitHub 用户名并点击「立即同步」，一站式接管您的 GitHub 开源装机清单。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
