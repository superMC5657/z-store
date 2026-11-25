import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Sparkles, Calendar } from 'lucide-react';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { AppCard } from '../components/AppCard';
import { SegmentedControl } from '../components/SegmentedControl';
import { CountBadge } from '../components/CountBadge';
import {
  EMPTY_IDS,
  FilterEmptyState,
  ViewAppActions,
  ViewShell,
  noopAction,
  resolvePlatformReset,
} from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import { isPlatformLoading } from '../lib/platformFilter';
import {
  LATEST_APPS_PER_PAGE,
  LatestAppsWindow,
  getLatestCatalogApps,
} from '../services/api/catalog';
import type { AppSummary } from '../types';
import type { PlatformId } from '../lib/platformFilter';
import {
  isInstalled as selectIsInstalled,
  selectManagedState,
  selectPlatformCounts,
} from '../app/selectors';
import { queueAssembledRowIcons } from '../services/iconStore';
import { normalizeId } from '../services/normalizeId';

type LatestTimeWindow = '7d' | '30d' | '90d';

interface LatestViewProps extends ViewAppActions {
  onNavigateCategories?: () => void;
  /** 未按平台裁剪的全量合并目录，用于计算时间窗内的全平台分布；缺省回退 `apps`。 */
  allApps?: readonly AppSummary[];
  /** 向侧栏上报当前时间窗的平台分布；卸载时上报 `null`。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
}

export const LatestView: React.FC<LatestViewProps> = (props) => {
  const {
    apps,
    platformResolvedOtherIds = EMPTY_IDS,
    installedIds = EMPTY_IDS,
    installingIds,
    favoriteIds = EMPTY_IDS,
    managedIds = null,
    watchedIds,
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onToggleFavorite = noopAction,
    onToggleWatch,
    onResetPlatformFilter,
    onNavigateCategories,
    allApps,
    onDisplayPlatformCounts,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  const [activeWindow, setActiveWindow] = useState<LatestTimeWindow>('30d');

  const [fetchedApps, setFetchedApps] = useState<AppSummary[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // 回包 `matched_ids`：该时间窗平台过滤前的全部 ID；旧接口不回传时为 null。
  const [matchedIds, setMatchedIds] = useState<string[] | null>(null);

  // 平台过滤后的可见目录 ID（小写、排序），交给后端在分页前过滤；`allowedKey` 作为稳定依赖签名。
  const allowedIds = useMemo(() => apps.map((a) => a.id.toLowerCase()).sort(), [apps]);
  const allowedKey = allowedIds.join('\n');

  const nextPageRef = useRef(2);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const genRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(() => {});

  const windowRange = (win: LatestTimeWindow): LatestAppsWindow => {
    switch (win) {
      case '7d':
        return { minDays: 0, maxDays: 7 };
      case '30d':
        return { minDays: 7, maxDays: 30 };
      case '90d':
      default:
        return { minDays: 30, maxDays: 90 };
    }
  };

  const requestPage = (win: LatestTimeWindow, page: number, gen: number) => {
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    const range = windowRange(win);
    getLatestCatalogApps(range, page, LATEST_APPS_PER_PAGE, allowedIds).then(
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

        if (typeof res.total === 'number') {
          setTotalCount(res.total);
        }
        if (res.matched_ids) setMatchedIds(res.matched_ids);
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

  // 切换时间窗口或平台筛选：重置分页并取第 1 页
  useEffect(() => {
    const gen = genRef.current + 1;
    genRef.current = gen;
    setFetchedApps([]);
    setTotalCount(null);
    setMatchedIds(null);
    nextPageRef.current = 2;
    hasMoreRef.current = false;
    setHasMore(false);
    requestPage(activeWindow, 1, gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow, allowedKey]);

  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMoreRef.current) return;
    requestPage(activeWindow, nextPageRef.current, genRef.current);
  };

  const handleRetry = () => {
    if (loadingRef.current) return;
    const page = fetchedApps.length === 0 ? 1 : nextPageRef.current;
    requestPage(activeWindow, page, genRef.current);
  };

  // 触底续页哨兵（与类别页同口径 rootMargin 320px）；root 绑定 `.content-area` 独立滚动容器，
  // 否则 rootMargin 只作用于视口。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!hasMore || error) return;
    const root = el.closest('.content-area');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { root: root instanceof Element ? root : null, rootMargin: '320px 0px' },
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

  // 可见行：BE 已按 allowedIds 过滤（回包带 `matched_ids` 时信任之）；行数据优先取 `apps` 属性以跟进图标 patch。
  // 未回传 `matched_ids` 的旧接口回退为与平台预过滤 apps 取交集。
  const visibleApps = useMemo(() => {
    const rows = matchedIds
      ? fetchedApps
      : fetchedApps.filter((a) => appsById.has(a.id.toLowerCase()));
    return rows.map((a) => appsById.get(a.id.toLowerCase()) ?? a);
  }, [appsById, fetchedApps, matchedIds]);

  // 侧栏平台分布：该时间窗全平台命中条目（对照未裁剪目录）。
  const platformSource = allApps ?? apps;
  const windowPlatformCounts = useMemo(() => {
    if (!matchedIds) return null;
    const matched = new Set(matchedIds.map((id) => id.toLowerCase()));
    const rows = platformSource.filter((a) => matched.has(a.id.toLowerCase()));
    return selectPlatformCounts(rows, platformResolvedOtherIds);
  }, [matchedIds, platformSource, platformResolvedOtherIds]);

  useReportPlatformCounts(windowPlatformCounts, onDisplayPlatformCounts, { view: 'latest' });

  const settled = !loading && !error;
  // 该时间窗在全平台本身无新收录 → 时间窗切换引导；有新收录但被平台筛选排除 → FilterEmptyState。
  const windowEmpty =
    settled && (matchedIds ? matchedIds.length === 0 : apps.length > 0 && fetchedApps.length === 0);
  const filterEmpty = !windowEmpty && (apps.length === 0 || (settled && visibleApps.length === 0));

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
            {!loading && !error && totalCount !== null && (
              <CountBadge value={totalCount} />
            )}
          </h3>
          {t('latest.subtitle') ? (
            <p className="trends-subtitle" style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
              {t('latest.subtitle')}
            </p>
          ) : null}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <SegmentedControl<LatestTimeWindow>
          value={activeWindow}
          onChange={(next) => setActiveWindow(next)}
          options={windowOptions}
          ariaLabel={t('latest.title')}
        />
      </div>

      {filterEmpty ? (
        <FilterEmptyState
          title={t('categories.no_apps_device_filter')}
          description={t('categories.no_apps_device_filter_desc')}
          resetLabel={t('categories.reset_device_filter')}
          onReset={resolvePlatformReset(onResetPlatformFilter)}
        />
      ) : windowEmpty ? (
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
                type="button"
                className="btn-fluent btn-compact btn-secondary"
                onClick={() => setActiveWindow('30d')}
              >
                {t('latest.switch_to_30d')}
              </button>
            )}
            {activeWindow !== '90d' && (
              <button
                type="button"
                className="btn-fluent btn-compact btn-primary"
                onClick={() => setActiveWindow('90d')}
              >
                {t('latest.switch_to_90d')}
              </button>
            )}
            {activeWindow === '90d' && onNavigateCategories && (
              <button
                type="button"
                className="btn-fluent btn-compact btn-secondary"
                onClick={onNavigateCategories}
              >
                {t('latest.explore_categories')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="app-grid">
          {visibleApps.map((app, index) => {
            const appKey = normalizeId(app.id);
            return (
              <AppCard
                key={app.id}
                app={app}
                eager={index < 6}
                platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
                isInstalled={selectIsInstalled(app.id, installedIds)}
                isManaged={selectManagedState(app.id, managedIds)}
                isInstalling={installingIds?.has(appKey)}
                isFavorite={favoriteIds.has(appKey)}
                isWatched={watchedIds?.has(appKey)}
                showAddedAtBadge={true}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            );
          })}

          {loading && (
            <div style={{ width: '100%', padding: '16px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
              {t('latest.list_loading')}
            </div>
          )}

          {error && !loading && (
            <div style={{ width: '100%', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', padding: '16px 0' }}>
              <span>{t('latest.list_error')}</span>
              <button type="button" className="btn-fluent btn-compact btn-secondary" onClick={handleRetry}>
                {t('latest.retry')}
              </button>
            </div>
          )}

          {hasMore && !error && (
            <div ref={sentinelRef} style={{ width: '100%', height: '1px' }} />
          )}
        </div>
      )}

      {!filterEmpty && !windowEmpty && hasMore && settled && (
        <div className="feed-more-row">
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={() => loadMoreRef.current()}
          >
            {t('latest.load_more')}
          </button>
        </div>
      )}
    </ViewShell>
  );
};
