import React from 'react';
import { AppCard } from '../components/AppCard';
import { AppIcon } from '../components/AppIcon';
import { AppSummary } from '../types';

interface HomeViewProps {
  apps: AppSummary[];
  installedIds: Set<string>;
  favoriteIds: Set<string>;
  recentlyViewedApps?: AppSummary[];
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onNavigateTrends: () => void;
  onClearRecentViews?: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  apps,
  installedIds,
  favoriteIds,
  recentlyViewedApps = [],
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onNavigateTrends,
  onClearRecentViews,
}) => {
  if (apps.length === 0) {
    return (
      <div className="home-view">
        <div className="empty-state-card" style={{ marginTop: '40px' }}>
          <div style={{ fontSize: '48px', marginBottom: '14px' }}>🔍</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 600 }}>未在精选收录库中找到匹配软件</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '540px', lineHeight: '1.6', margin: '0 auto 16px auto' }}>
            Z-Store 支持强大的<strong>全网开源生态直连</strong>。您可以直接在顶部搜索栏输入 GitHub 仓库全名（例如 <code>owner/repo</code>），系统将实时穿透解析其最新 Releases 产物供您一键安装！
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <span className="modal-tag">示例: obsproject/obs-studio</span>
            <span className="modal-tag">示例: localsend/localsend</span>
          </div>
        </div>
      </div>
    );
  }

  const heroApp = apps.find((a) => a.id === 'rustdesk') || apps[0];
  // 排除已在官方置顶推荐（Hero Banner）中展示的应用，避免在下方精选列表中重复推荐
  const nonHeroApps = heroApp ? apps.filter((a) => a.id !== heroApp.id) : apps;
  const featuredApps = nonHeroApps.slice(0, 4);
  const remainingApps = nonHeroApps.slice(4);

  return (
    <div className="home-view view-entrance">
      {/* Hero Acrylic Banner (PRD 5.1 & Section 3) */}
      {heroApp && (
        <div
          className="hero-banner"
          onClick={() => onOpenDetail(heroApp.id)}
          role="banner"
          tabIndex={0}
        >
          <div className="hero-content">
            <div className="hero-tag">
              <span>🌟 本周编辑精选推荐</span>
              <span>·</span>
              <span>跨平台开源精选</span>
            </div>

            <h2 className="hero-title">
              {heroApp.name} · 安全流畅的开源远程桌面
            </h2>

            <p className="hero-desc">
              {heroApp.description}
            </p>

            {/* Meta Tags */}
            <div className="hero-tags">
              <span className="app-tag app-tag-star">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>{(heroApp.stars / 1000).toFixed(1)}k Stars</span>
              </span>
              <span className="app-tag app-tag-license">{heroApp.license} 协议</span>
              <span className="app-tag">{heroApp.category_name}</span>
              <span className="app-tag">自建中继 · 端到端加密</span>
            </div>

            {/* Actions */}
            <div className="hero-actions">
              <button
                className={`btn-fluent ${installedIds.has(heroApp.id) ? 'btn-secondary' : 'btn-primary'}`}
                style={{ padding: '9px 22px', fontSize: '13.5px', fontWeight: 600 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickInstall(heroApp.id);
                }}
              >
                {installedIds.has(heroApp.id) ? '🚀 已就绪 · 打开' : '⚡ 一键获取安装'}
              </button>
              <button
                className="btn-fluent btn-secondary"
                style={{ padding: '9px 18px', fontSize: '13.5px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigateTrends();
                }}
              >
                探索飙升热榜 ➔
              </button>
            </div>
          </div>

          <div className="hero-visual">
            <div className="hero-icon-card">
              <AppIcon
                icon={heroApp.icon}
                name={heroApp.name}
                appId={heroApp.id}
                owner={heroApp.owner}
                repo={heroApp.repo}
                iconBg={heroApp.icon_bg}
                style={{ width: '100%', height: '100%', borderRadius: 'inherit' }}
              />
            </div>
            <div className="hero-verified-badge" title="该开源项目已通过官方仓库认证">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <polyline points="9 12 11 14 15 10" />
              </svg>
              <span>官方认证 · Verified</span>
            </div>
          </div>
        </div>
      )}

      {/* Recently Viewed Apps (Feature D) */}
      {recentlyViewedApps && recentlyViewedApps.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="section-title">🕒 最近浏览</h3>
            {onClearRecentViews && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px' }}
                onClick={onClearRecentViews}
              >
                清空记录
              </button>
            )}
          </div>
          <div className="app-grid">
            {recentlyViewedApps.slice(0, 4).map((app) => (
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
        </div>
      )}

      {/* Featured Grid */}
      {featuredApps.length > 0 && (
        <>
          <div className="section-header">
            <h3 className="section-title">✨ 经典精选开源软件</h3>
          </div>
          <div className="app-grid">
            {featuredApps.map((app) => (
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
        </>
      )}

      {/* Discover All Grid */}
      {remainingApps.length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: '28px' }}>
            <h3 className="section-title">📦 全部精选开源收录</h3>
          </div>
          <div className="app-grid">
            {remainingApps.map((app) => (
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
        </>
      )}
    </div>
  );
};
