import React, { useMemo, useState } from 'react';
import { AppSummary } from '../types';
import { AppIcon } from '../components/AppIcon';

interface TrendsViewProps {
  apps: AppSummary[];
  favoriteIds?: Set<string>;
  installedIds?: Set<string>;
  installingIds?: Set<string>;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
}

type TimeRange = 'day' | 'week' | 'month' | 'all';

export const TrendsView: React.FC<TrendsViewProps> = ({
  apps,
  favoriteIds,
  installedIds,
  installingIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('week');

  const sortedApps = useMemo(() => {
    const list = [...apps];
    switch (timeRange) {
      case 'day':
        // 日飙升：基于 Star 与活跃加权
        return list.sort((a, b) => (b.forks * 3 + b.stars % 500) - (a.forks * 3 + a.stars % 500));
      case 'week':
        // 周飙升：基于活跃增长加权
        return list.sort((a, b) => (b.stars * 0.7 + b.forks * 4) - (a.stars * 0.7 + a.forks * 4));
      case 'month':
        // 月榜：按综合综合活跃度
        return list.sort((a, b) => (b.stars + b.forks * 2) - (a.stars + a.forks * 2));
      case 'all':
      default:
        // 历史总榜：纯 Star 排序
        return list.sort((a, b) => b.stars - a.stars);
    }
  }, [apps, timeRange]);

  const getRankBadgeColor = (index: number) => {
    if (index === 0) return '#eab308'; // 冠军金
    if (index === 1) return '#94a3b8'; // 亚军银
    if (index === 2) return '#d97706'; // 季军铜
    return 'var(--text-tertiary)';
  };

  return (
    <div className="trends-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">🚀 GitHub 开源应用飙升热榜</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['day', 'week', 'month', 'all'] as TimeRange[]).map((tab) => {
            const labels: Record<TimeRange, string> = {
              day: '今日飙升',
              week: '本周热榜',
              month: '本月焦点',
              all: '历史总榜',
            };
            return (
              <button
                key={tab}
                className={`btn-fluent ${timeRange === tab ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '5px 14px', fontSize: '12px', fontWeight: timeRange === tab ? 600 : 400 }}
                onClick={() => setTimeRange(tab)}
              >
                {labels[tab]}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {sortedApps.map((app, index) => (
          <div
            key={app.id}
            className="app-card"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: '14px 20px',
              cursor: 'pointer',
            }}
            onClick={() => onOpenDetail(app.id)}
          >
            <div
              style={{
                fontSize: '18px',
                fontWeight: 800,
                width: '36px',
                color: getRankBadgeColor(index),
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              #{index + 1}
            </div>

            <AppIcon
              icon={app.icon}
              name={app.name}
              appId={app.id}
              owner={app.owner}
              repo={app.repo}
              iconBg={app.icon_bg}
              className="app-icon"
              style={{
                width: '42px',
                height: '42px',
                fontSize: '18px',
                marginRight: '14px',
              }}
            />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '15px' }}>{app.name}</span>
                {app.is_verified && (
                  <span className="verified-badge" title="GitHub 官方所有权认证">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="var(--brand-primary)" />
                      <path d="m9 12 2 2 4-4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
                <span className="app-tag" style={{ fontSize: '11px' }}>
                  {app.category_name}
                </span>
              </div>
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text-tertiary)',
                  marginTop: '3px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {app.owner} · {app.description}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginLeft: '12px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                ★ {(app.stars / 1000).toFixed(1)}k
              </span>
              {onToggleFavorite && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(app.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '16px',
                    color: favoriteIds?.has(app.id) ? '#eab308' : 'var(--text-tertiary)',
                  }}
                  title={favoriteIds?.has(app.id) ? '取消收藏' : '添加至我的收藏'}
                >
                  {favoriteIds?.has(app.id) ? '★' : '☆'}
                </button>
              )}
              {installedIds?.has(app.id) ? (
                <button
                  className="btn-install btn-installed"
                  style={{ padding: '6px 14px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDetail(app.id);
                  }}
                  title="已安装 · 点击查看详情"
                  aria-label={`${app.name} 已安装，点击查看详情`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已安装</span>
                </button>
              ) : installingIds?.has(app.id) ? (
                <button
                  className="btn-install"
                  disabled
                  style={{ padding: '6px 14px', opacity: 0.8, cursor: 'not-allowed' }}
                  title="正在安装中..."
                >
                  <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px', marginRight: '4px' }} />
                  <span>安装中</span>
                </button>
              ) : (
                <button
                  className="btn-install"
                  style={{ padding: '6px 14px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickInstall(app.id);
                  }}
                  title={`获取 ${app.name}`}
                  aria-label={`获取 ${app.name}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>获取</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
