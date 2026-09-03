import React, { useState } from 'react';
import { AppCard } from '../components/AppCard';
import { AppSummary, StarredSyncResult } from '../types';
import { api } from '../services/api';

interface FavoritesViewProps {
  apps: AppSummary[];
  favoriteIds: Set<string>;
  installedIds: Set<string>;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  apps,
  favoriteIds,
  installedIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
}) => {
  const [activeTab, setActiveTab] = useState<'local' | 'starred'>('local');
  const [githubUser, setGithubUser] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<StarredSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const favoriteApps = apps.filter((a) => favoriteIds.has(a.id));

  const handleSyncStarred = async () => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      const res = await api.syncGithubStarred(githubUser.trim() || undefined);
      setSyncResult(res);
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAddAllToFavorites = () => {
    if (!syncResult) return;
    for (const app of syncResult.catalog_matches) {
      if (!favoriteIds.has(app.id)) {
        onToggleFavorite(app.id);
      }
    }
  };

  return (
    <div className="favorites-view view-entrance">
      {/* Tab Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className={`btn-fluent ${activeTab === 'local' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
            onClick={() => setActiveTab('local')}
          >
            ⭐️ 本地收藏 ({favoriteApps.length})
          </button>
          <button
            className={`btn-fluent ${activeTab === 'starred' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '7px 16px', fontSize: '13px', fontWeight: 600 }}
            onClick={() => setActiveTab('starred')}
          >
            🌟 GitHub Starred 仓库同步
          </button>
        </div>
      </div>

      {activeTab === 'local' ? (
        favoriteApps.length === 0 ? (
          <div className="empty-state-card">
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>⭐️</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>收藏夹还是空的</h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              在应用卡片或详情页中点击星标收藏，常用利器一键集中收纳；或切换至「GitHub Starred 仓库同步」一键批量导入！
            </p>
          </div>
        ) : (
          <div className="app-grid">
            {favoriteApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isFavorite={true}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
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
                <h4 style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 600 }}>
                  同步 GitHub Starred 开源项目
                </h4>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                  直接输入 GitHub 用户名，或在设置中配置 PAT，自动扫描您已 Star 的开源软件并与 Z-Store 匹配接管安装。
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
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.2)',
                }}
              >
                <span style={{ fontSize: '13px', color: '#38bdf8', fontWeight: 500 }}>
                  ✓ 共发现 {syncResult.total_starred} 个 Starred 仓库，其中 {syncResult.catalog_matches.length} 个已收录于 Z-Store
                </span>

                {syncResult.catalog_matches.length > 0 && (
                  <button
                    className="btn-fluent btn-secondary"
                    style={{ fontSize: '12px', padding: '4px 12px' }}
                    onClick={handleAddAllToFavorites}
                  >
                    📥 全部纳入收藏
                  </button>
                )}
              </div>

              {syncResult.catalog_matches.length > 0 ? (
                <div className="app-grid">
                  {syncResult.catalog_matches.map((app) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      isInstalled={installedIds.has(app.id)}
                      isFavorite={favoriteIds.has(app.id)}
                      onOpenDetail={onOpenDetail}
                      onQuickInstall={onQuickInstall}
                      onToggleFavorite={onToggleFavorite}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state-card" style={{ marginTop: '20px' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    您 Star 的开源项目中暂未匹配到已收录应用，您可在主页搜索栏直接输入 <code>owner/repo</code> 实时检索并一键安装。
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
