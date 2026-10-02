import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { TrendingUp } from 'lucide-react';
import { AppSummary } from '../types';
import { AppCard } from '../components/AppCard';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';

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

  return (
    <div className="trends-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">
          <TrendingUp size={18} />
          <span>{t('trends.title')}</span>
        </h3>
        <SegmentedControl
          value={timeRange}
          onChange={setTimeRange}
          options={([
            { value: 'day' as TimeRange, label: t('trends.tab_day') },
            { value: 'week' as TimeRange, label: t('trends.tab_week') },
            { value: 'month' as TimeRange, label: t('trends.tab_month') },
            { value: 'all' as TimeRange, label: t('trends.tab_all') },
          ])}
        />
      </div>

      <div className="fluent-list-container">
        {sortedApps.length === 0 ? (
          <EmptyState
            className="trends-empty"
            icon={<TrendingUp size={40} strokeWidth={1.5} />}
            title={t('trends.empty_title')}
            description={t('trends.empty_desc')}
            action={(
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
            )}
          />
        ) : (
        sortedApps.map((app, index) => (
          <AppCard
            key={app.id}
            app={app}
            rank={index + 1}
            className="fluent-list-row"
            isInstalled={installedIds?.has(app.id) ?? false}
            isInstalling={installingIds?.has(app.id) ?? false}
            isFavorite={favoriteIds?.has(app.id) ?? false}
            onOpenDetail={onOpenDetail}
            onQuickInstall={onQuickInstall}
            onToggleFavorite={onToggleFavorite}
          />
        ))
        )}
      </div>
    </div>
  );
};
