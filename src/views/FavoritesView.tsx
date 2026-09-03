import React from 'react';
import { AppCard } from '../components/AppCard';
import { AppSummary } from '../types';

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
  const favoriteApps = apps.filter((a) => favoriteIds.has(a.id));

  return (
    <div className="favorites-view">
      <div className="section-header">
        <h3 className="section-title">⭐️ 我的收藏夹 ({favoriteApps.length})</h3>
      </div>

      {favoriteApps.length === 0 ? (
        <div className="empty-state-card">
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>⭐️</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>收藏夹还是空的</h4>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
            在应用卡片或详情页中点击星标收藏，常用利器一键集中收纳。
          </p>
        </div>
      ) : (
        <div className="app-grid">
          {favoriteApps.map((app) => (
            <div key={app.id} style={{ position: 'relative' }}>
              <AppCard
                app={app}
                isInstalled={installedIds.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
              />
              <button
                className="btn-fav"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(app.id);
                }}
                style={{
                  position: 'absolute',
                  top: '12px',
                  right: '12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  zIndex: 2,
                }}
                title="取消收藏"
              >
                ⭐
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
