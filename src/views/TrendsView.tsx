import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { TrendingUp, Star } from 'lucide-react';
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
  /**
   * 由 App 维护的全局设备平台重置回调（恢复全量设备集合）。
   * 当未传入时，重置按钮会清理持久化存储并在 window 上广播
   * `zstore:reset-platform-filter`（兜底方案与 HomeView 一致；保持字面量以避免 view 与 App 循环引用）。
   */
  onResetPlatformFilter?: () => void;
}

/** 当 App 尚未接入 `onResetPlatformFilter` 时的兜底重置路径。 */
function broadcastPlatformReset(): void {
  try {
    window.localStorage.removeItem('zstore:platform-filter:v1');
  } catch {
    // 忽略：存储抛错时保持内存中的选择
  }
  window.dispatchEvent(new CustomEvent('zstore:reset-platform-filter'));
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
  onResetPlatformFilter,
}) => {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<TimeRange>('week');

  // 任务 6（设备平台全局过滤）：`apps` 传入时已由 App.platformFilteredApps 预过滤。
  // 在接收到的集合内部纯粹进行排序并重新计算名次 #1..N（名次实时重算，不予保留），
  // 本视图内绝不重复做任何平台过滤。
  // 静态快照排序：`apps` 源自静态 catalog.json 快照（仅有 stars/forks 字段，无时间戳或增量）。
  // 'day' / 'week' / 'month' / 'all' 仅为历史遗留的排序预设名称，不代表实际时间窗口或增长趋势。
  const sortedApps = useMemo(() => {
    const list = [...apps];
    switch (timeRange) {
      case 'day':
        // 静态快照排序 A（Fork 加权）：基于 catalog.json 的 stars/forks 快照
        return list.sort((a, b) => (b.forks * 3 + b.stars % 500) - (a.forks * 3 + a.stars % 500));
      case 'week':
        // 静态快照排序 B（综合加权）：基于 catalog.json 的 stars/forks 快照
        return list.sort((a, b) => (b.stars * 0.7 + b.forks * 4) - (a.stars * 0.7 + a.forks * 4));
      case 'month':
        // 静态快照排序 C（Star 侧重）：基于 catalog.json 的 stars/forks 快照
        return list.sort((a, b) => (b.stars + b.forks * 2) - (a.stars + a.forks * 2));
      case 'all':
      default:
        // 静态快照排序 D（按 Star 总数）：基于 catalog.json 的 stars 快照
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
        <h3 className="section-title">
          <TrendingUp size={18} />
          <span>{t('trends.title')}</span>
        </h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['day', 'week', 'month', 'all'] as TimeRange[]).map((tab) => {
            const labels: Record<TimeRange, string> = {
              day: t('trends.tab_day'),
              week: t('trends.tab_week'),
              month: t('trends.tab_month'),
              all: t('trends.tab_all'),
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
        {sortedApps.length === 0 ? (
          <div
            className="trends-empty"
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              color: 'var(--text-tertiary)',
              border: '1px dashed var(--border-control)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              {t('trends.empty_title')}
            </div>
            <div style={{ fontSize: '12px', marginBottom: '16px' }}>
              {t('trends.empty_desc')}
            </div>
            <button
              type="button"
              className="btn-fluent btn-primary filter-empty-reset"
              onClick={() => {
                if (onResetPlatformFilter) {
                  onResetPlatformFilter();
                } else {
                  broadcastPlatformReset();
                }
              }}
            >
              {t('trends.reset_device_filter')}
            </button>
          </div>
        ) : (
        sortedApps.map((app, index) => (
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
                  <span className="verified-badge" title={t('app.verified_badge')}>
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
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Star size={12} fill="currentColor" />
                <span>{(app.stars / 1000).toFixed(1)}k</span>
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
                    padding: '2px',
                    display: 'flex',
                    alignItems: 'center',
                    color: favoriteIds?.has(app.id) ? '#eab308' : 'var(--text-tertiary)',
                  }}
                  title={favoriteIds?.has(app.id) ? t('app.fav_active') : t('app.fav_inactive')}
                >
                  <Star
                    size={16}
                    fill={favoriteIds?.has(app.id) ? '#eab308' : 'none'}
                    color={favoriteIds?.has(app.id) ? '#eab308' : 'currentColor'}
                  />
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
                  title={t('app.installed_details', { name: app.name })}
                  aria-label={t('app.installed_details', { name: app.name })}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{t('app.installed')}</span>
                </button>
              ) : installingIds?.has(app.id) ? (
                <button
                  className="btn-install"
                  disabled
                  style={{ padding: '6px 14px', opacity: 0.8, cursor: 'not-allowed' }}
                  title={t('app.installing_app', { name: app.name })}
                >
                  <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px', marginRight: '4px' }} />
                  <span>{t('app.installing')}</span>
                </button>
              ) : (
                <button
                  className="btn-install"
                  style={{ padding: '6px 14px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickInstall(app.id);
                  }}
                  title={t('app.get_app', { name: app.name })}
                  aria-label={t('app.get_app', { name: app.name })}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>{t('app.get')}</span>
                </button>
              )}
            </div>
          </div>
        ))
        )}
      </div>
    </div>
  );
};
