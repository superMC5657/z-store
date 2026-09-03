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
            <span className="app-name">{app.name}</span>
            {app.is_verified && (
              <span className="verified-badge" title="GitHub 官方认证所有权">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="var(--brand-primary)" />
                  <path d="m9 12 2 2 4-4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
          <div className="app-owner">
            {app.owner} · {app.category_name}
          </div>
        </div>

        {onToggleFavorite && (
          <button
            className={`btn-fav-card ${isFavorite ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(app.id);
            }}
            title={isFavorite ? '取消收藏' : '添加至收藏夹'}
            aria-label={isFavorite ? '取消收藏' : '添加至收藏夹'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        )}
      </div>

      <p className="app-desc" title={app.description}>{app.description}</p>

      <div className="app-card-footer">
        <div className="app-tags">
          <span className="app-tag app-tag-star">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{formatStars(app.stars)}</span>
          </span>
          <span className="app-tag app-tag-license">{app.license}</span>
        </div>

        <button
          className={`btn-install ${isInstalled ? 'btn-installed' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onQuickInstall(app.id);
          }}
          aria-label={isInstalled ? `${app.name} 已安装` : `获取 ${app.name}`}
        >
          {isInstalled ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>已安装</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>获取</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
