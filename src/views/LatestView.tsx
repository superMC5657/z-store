import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Sparkles, Calendar } from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { SegmentedControl } from '../components/SegmentedControl';
import {
  FilterEmptyState,
  RequiredPlatformReset,
  ViewAppActions,
  ViewShell,
} from './ViewShell';
import { isPlatformLoading } from '../lib/platformFilter';
import {
  LATEST_APPS_PER_PAGE,
  getLatestCatalogApps,
} from '../services/api/catalog';
import type { AppSummary } from '../types';
import { isInstalled as selectIsInstalled, selectManagedState } from '../app/selectors';
import { queueAssembledRowIcons } from '../services/iconStore';

type LatestTimeWindow = '7d' | '30d' | '90d';

interface LatestViewProps extends ViewAppActions, RequiredPlatformReset {
  platformResolvedOtherIds?: ReadonlySet<string>;
  onNavigateCategories?: () => void;
}

export const LatestView: React.FC<LatestViewProps> = ({
  apps,
  platformResolvedOtherIds = new Set<string>(),
  installedIds,
  installingIds,
  favoriteIds,
  managedIds = null,
  watchedIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
  onResetPlatformFilter,
  onNavigateCategories,
}) => {
  const { t } = useTranslation();
  const [activeWindow, setActiveWindow] = useState<LatestTimeWindow>('30d');

  const [fetchedApps, setFetchedApps] = useState<AppSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const nextPageRef = useRef(2);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const genRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(() => {});

  const windowDays = (win: LatestTimeWindow): number => {
    switch (win) {
      case '7d':
        return 7;
      case '30d':
        return 30;
      case '90d':
      default:
        return 90;
    }
  };

  const requestPage = (win: LatestTimeWindow, page: number, gen: number) => {
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    const sinceDays = windowDays(win);
    getLatestCatalogApps(sinceDays, page, LATEST_APPS_PER_PAGE).then(
      (res) => {
        if (genRef.current !== gen) return;
        setFetchedApps((prev) => {
          if (page === 1) return res.items;
          const seen = new Set(prev.map((a) => a.id.toLowerCase()));
          const next = [...prev];
          for (const item of res.items) {
            const key = item.id.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              next.push(item);
            }
          }
          return next;
        });

        if (page >= nextPageRef.current) nextPageRef.current = page + 1;
        hasMoreRef.current = res.has_more;
        setHasMore(res.has_more);
        loadingRef.current = false;
        setLoading(false);
      },
      () => {
        if (genRef.current !== gen) return;
        loadingRef.current = false;
        setLoading(false);
        setError(true);
      },
    );
  };

  // 切换时间窗口：重置分页并取第 1 页
  useEffect(() => {
    const gen = genRef.current + 1;
    genRef.current = gen;
    setFetchedApps([]);
    nextPageRef.current = 2;
    hasMoreRef.current = false;
    setHasMore(false);
    requestPage(activeWindow, 1, gen);
  }, [activeWindow]);

  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMoreRef.current) return;
    requestPage(activeWindow, nextPageRef.current, genRef.current);
  };

  const handleRetry = () => {
    if (loadingRef.current) return;
    const page = fetchedApps.length === 0 ? 1 : nextPageRef.current;
    requestPage(activeWindow, page, genRef.current);
  };

  // 触底续页哨兵（与类别页同口径 rootMargin 320px）
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!hasMore || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, error, fetchedApps.length, activeWindow]);

  // 平台预过滤映射
  const appsById = useMemo(() => {
    const map = new Map<string, AppSummary>();
    for (const a of apps) {
      map.set(a.id.toLowerCase(), a);
    }
    return map;
  }, [apps]);

  // 可见行：BE 取回的倒排列表 ∩ 平台预过滤 apps（保序，图标 patch 随 apps 属性更新）
  const visibleApps = useMemo(() => {
    return fetchedApps
      .filter((a) => appsById.has(a.id.toLowerCase()))
      .map((a) => appsById.get(a.id.toLowerCase()) ?? a);
  }, [appsById, fetchedApps]);

  // 组装落盘图标补齐
  useEffect(() => {
    queueAssembledRowIcons(visibleApps);
  }, [visibleApps]);

  const windowOptions = [
    { value: '7d' as const, label: t('latest.filter_7d') },
    { value: '30d' as const, label: t('latest.filter_30d') },
    { value: '90d' as const, label: t('latest.filter_90d') },
  ];

  return (
    <ViewShell viewClass="latest-view">
      <div className="section-header" style={{ marginBottom: '16px' }}>
        <div>
          <h3 className="section-title">
            <Sparkles size={18} />
            <span>{t('latest.title')}</span>
          </h3>
          <p className="trends-subtitle" style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
            {t('latest.subtitle')}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <SegmentedControl<LatestTimeWindow>
          value={activeWindow}
          onChange={(next) => setActiveWindow(next)}
          options={windowOptions}
          ariaLabel={t('latest.title')}
        />
        {!loading && visibleApps.length > 0 && (
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            {t('latest.apps_available', { count: visibleApps.length })}
          </span>
        )}
      </div>

      {apps.length === 0 ? (
        <FilterEmptyState
          title={t('categories.no_apps_device_filter')}
          description={t('categories.no_apps_device_filter_desc')}
          resetLabel={t('categories.reset_device_filter')}
          onReset={onResetPlatformFilter}
        />
      ) : !loading && !error && fetchedApps.length === 0 ? (
        <div
          className="empty-state-card"
          style={{
            padding: '36px 24px',
            textAlign: 'center',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <Calendar size={32} style={{ color: 'var(--text-tertiary)', marginBottom: '4px' }} />
          <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{t('latest.empty_title')}</h4>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '420px', lineHeight: 1.5 }}>
            {activeWindow === '90d' ? t('latest.empty_desc_90d') : t('latest.empty_desc')}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {activeWindow === '7d' && (
              <button
                className="btn-fluent btn-sm btn-secondary"
                onClick={() => setActiveWindow('30d')}
              >
                {t('latest.switch_to_30d')}
              </button>
            )}
            {activeWindow !== '90d' && (
              <button
                className="btn-fluent btn-sm btn-primary"
                onClick={() => setActiveWindow('90d')}
              >
                {t('latest.switch_to_90d')}
              </button>
            )}
            {activeWindow === '90d' && onNavigateCategories && (
              <button
                className="btn-fluent btn-sm btn-secondary"
                onClick={onNavigateCategories}
              >
                {t('latest.explore_categories')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="app-grid">
          {visibleApps.map((app, index) => (
            <AppCard
              key={app.id}
              app={app}
              eager={index < 6}
              platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
              isInstalled={selectIsInstalled(app.id, installedIds)}
              isManaged={selectManagedState(app.id, managedIds)}
              isInstalling={installingIds?.has(app.id)}
              isFavorite={favoriteIds.has(app.id)}
              isWatched={watchedIds?.has(app.id)}
              showAddedAtBadge={true}
              onOpenDetail={onOpenDetail}
              onQuickInstall={onQuickInstall}
              onToggleFavorite={onToggleFavorite}
              onToggleWatch={onToggleWatch}
            />
          ))}

          {loading && (
            <div style={{ width: '100%', padding: '16px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
              {t('latest.list_loading')}
            </div>
          )}

          {error && !loading && (
            <div style={{ width: '100%', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', padding: '16px 0' }}>
              <span>{t('latest.list_error')}</span>
              <button className="btn-fluent btn-sm btn-secondary" onClick={handleRetry}>
                {t('latest.retry')}
              </button>
            </div>
          )}

          {hasMore && !error && (
            <div ref={sentinelRef} style={{ width: '100%', height: '1px' }} />
          )}
        </div>
      )}
    </ViewShell>
  );
};
