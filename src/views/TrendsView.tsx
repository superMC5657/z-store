import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { TrendingUp } from 'lucide-react';
import { AppSummary } from '../types';
import { AppCard, getRankBadgeColor } from '../components/AppCard';
import { SegmentedControl } from '../components/SegmentedControl';
import { tauriApi } from '../services/api';
import {
  FilterEmptyState,
  PlatformResetOption,
  ViewAppActions,
  ViewShell,
  resolvePlatformReset,
} from './ViewShell';
import {
  fetchTrends,
  formatStars,
  matchCatalogApp,
  sortAppsLocally,
  TrendPeriod,
  TrendRepo,
} from '../services/trends';

interface TrendsViewProps
  extends
    Omit<ViewAppActions, 'favoriteIds' | 'installedIds' | 'installingIds' | 'onToggleFavorite'>,
    PlatformResetOption {
  favoriteIds?: Set<string>;
  installedIds?: Set<string>;
  installingIds?: Set<string>;
  onToggleFavorite?: (id: string) => void;
}

type TimeRange = TrendPeriod;

type DisplayTrendItem =
  | { type: 'catalog'; app: AppSummary; rank: number }
  | { type: 'uncataloged'; repo: TrendRepo; rank: number };

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
  const [remoteTrends, setRemoteTrends] = useState<TrendRepo[] | null>(null);

  // 离线/首屏秒开：基于本地快照的排序逻辑（降级兜底）
  const localSortedApps = useMemo(() => {
    return sortAppsLocally(apps, timeRange);
  }, [apps, timeRange]);

  // 异步获取真实趋势数据（优先 OSSInsight，失败降级 HN Algolia，全部失败保留本地降级）
  useEffect(() => {
    let isMounted = true;

    fetchTrends(timeRange)
      .then((data) => {
        if (!isMounted) return;
        if (data && data.length > 0) {
          setRemoteTrends(data);
        } else {
          setRemoteTrends(null);
        }
      })
      .catch(() => {
        if (!isMounted) return;
        setRemoteTrends(null);
      });

    return () => {
      isMounted = false;
    };
  }, [timeRange]);

  // 与本地 catalog.json 预过滤后的 apps 进行交叉匹配
  // 有则展示完整卡片，无则只展示名 + 星数
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (!remoteTrends || remoteTrends.length === 0) {
      return localSortedApps.map((app, index) => ({
        type: 'catalog',
        app,
        rank: index + 1,
      }));
    }

    const matchedAppIds = new Set<string>();
    return remoteTrends.map((trend, index) => {
      const matched = matchCatalogApp(trend, apps);
      if (matched && !matchedAppIds.has(matched.id)) {
        matchedAppIds.add(matched.id);
        return {
          type: 'catalog',
          app: matched,
          rank: index + 1,
        };
      }
      return {
        type: 'uncataloged',
        repo: trend,
        rank: index + 1,
      };
    });
  }, [remoteTrends, localSortedApps, apps]);

  return (
    <ViewShell viewClass="trends-view">
      <div className="section-header">
        <h3 className="section-title">
          <TrendingUp size={18} />
          <span>{t('trends.title')}</span>
        </h3>
        <SegmentedControl
          value={timeRange}
          onChange={setTimeRange}
          options={[
            { value: 'day' as TimeRange, label: t('trends.tab_day') },
            { value: 'week' as TimeRange, label: t('trends.tab_week') },
            { value: 'month' as TimeRange, label: t('trends.tab_month') },
            { value: 'all' as TimeRange, label: t('trends.tab_all') },
          ]}
        />
      </div>

      <div className="fluent-list-container">
        {apps.length === 0 || displayItems.length === 0 ? (
          <FilterEmptyState
            className="trends-empty"
            icon={<TrendingUp size={40} strokeWidth={1.5} />}
            title={t('trends.empty_title')}
            description={t('trends.empty_desc')}
            resetLabel={t('trends.reset_device_filter')}
            onReset={resolvePlatformReset(onResetPlatformFilter)}
          />
        ) : (
          displayItems.map((item, index) => {
            if (item.type === 'catalog') {
              return (
                <AppCard
                  key={item.app.id}
                  app={item.app}
                  rank={item.rank}
                  className="fluent-list-row"
                  eager={index < 6}
                  isInstalled={installedIds?.has(item.app.id) ?? false}
                  isInstalling={installingIds?.has(item.app.id) ?? false}
                  isFavorite={favoriteIds?.has(item.app.id) ?? false}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                />
              );
            }

            return (
              <div
                key={`uncataloged-${item.repo.id || item.repo.name}-${index}`}
                className="app-card fluent-list-row trend-uncataloged-row"
                role={item.repo.url ? 'button' : undefined}
                tabIndex={item.repo.url ? 0 : undefined}
                style={{ cursor: item.repo.url ? 'pointer' : 'default' }}
                onClick={() => {
                  if (item.repo.url) {
                    void tauriApi.openUrl(item.repo.url);
                  }
                }}
                onKeyDown={(e) => {
                  if (item.repo.url && (e.key === 'Enter' || e.key === ' ')) {
                    void tauriApi.openUrl(item.repo.url);
                  }
                }}
              >
                <div
                  className="app-rank"
                  style={{ color: getRankBadgeColor(index) }}
                  aria-label={`#${index + 1}`}
                >
                  #{index + 1}
                </div>
                <div className="app-card-header" style={{ flex: 1, minWidth: 0 }}>
                  <div className="app-meta" style={{ minWidth: 0 }}>
                    <div className="app-title">
                      <span className="app-name">{item.repo.name}</span>
                    </div>
                  </div>
                </div>
                <div className="app-card-footer" style={{ marginTop: 0, borderTop: 'none', marginLeft: 'auto' }}>
                  <div className="app-tags">
                    <span className="app-tag app-tag-star">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span>{formatStars(item.repo.stars)}</span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </ViewShell>
  );
};
