import React from 'react';
import { AppSummary } from '../types';

interface AppCardProps {
  app: AppSummary;
  isInstalled: boolean;
  isFavorite?: boolean;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
}

export const AppCard: React.FC<AppCardProps> = ({
  app,
  isInstalled,
  isFavorite = false,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
}) => {
  const formatStars = (count: number) => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  };

  return (
    <div
      className="app-card"
      onClick={() => onOpenDetail(app.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onOpenDetail(app.id);
        }
      }}
    >
      <div className="app-card-header">
        <div
          className="app-icon"
          style={{ background: app.icon_bg }}
        >
          {app.icon}
        </div>
        <div className="app-meta">
          <div className="app-title">
            <span>{app.name}</span>
            {app.is_verified && (
              <span className="verified-badge" title="GitHub 官方认证所有权">
                ✓
              </span>
            )}
          </div>
          <div className="app-owner">
            {app.owner} · {app.category_name}
          </div>
        </div>

        {onToggleFavorite && (
          <button
            className="btn-fav-card"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(app.id);
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '15px',
              padding: '4px',
              color: isFavorite ? '#eab308' : 'var(--text-tertiary)',
              marginLeft: 'auto',
            }}
            title={isFavorite ? '取消收藏' : '添加至收藏夹'}
          >
            {isFavorite ? '★' : '☆'}
          </button>
        )}
      </div>

      <p className="app-desc">{app.description}</p>

      <div className="app-card-footer">
        <div className="app-tags">
          <span className="app-tag">★ {formatStars(app.stars)}</span>
          <span className="app-tag">{app.license}</span>
        </div>

        <button
          className={`btn-install ${isInstalled ? 'btn-installed' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onQuickInstall(app.id);
          }}
          aria-label={isInstalled ? `${app.name} 已安装` : `获取 ${app.name}`}
        >
          {isInstalled ? '已安装' : '获取'}
        </button>
      </div>
    </div>
  );
};
