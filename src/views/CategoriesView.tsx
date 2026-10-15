import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { queueAssembledRowIcons } from '../services/iconStore';
import {
  Code2,
  Music,
  FileText,
  ShieldCheck,
  Palette,
  Network,
  Cpu,
  BookOpen,
  Terminal,
  Gamepad2,
  Tag,
  ArrowLeft,
} from 'lucide-react';
import { AppCard } from '../components/AppCard';
import {
  FilterEmptyState,
  RequiredPlatformReset,
  ViewAppActions,
  ViewShell,
} from './ViewShell';
import { isPlatformPending } from '../lib/platformFilter';
import { CATEGORY_APPS_PER_PAGE, getCategoryApps } from '../services/api/catalog';
import type { AppSummary } from '../types';
import { isInstalledUnion as selectIsInstalledUnion, selectIsDetectedOnlyOpt, selectIsManagedOpt } from '../app/selectors';

interface CategoriesViewProps extends ViewAppActions, RequiredPlatformReset {
  platformResolvedOtherIds?: ReadonlySet<string>;
}

/** 分类匹配与 BE `get_category_apps` 同口径（`category`/`category_name` 大小写不敏感）；
 * 详情行由 BE 过滤，此处仅大厅计数用，不对已取回的行做二次分类过滤。 */
function matchCategory(app: AppSummary, category: string): boolean {
  const c = category.toLowerCase();
  return app.category.toLowerCase() === c || (app.category_name ?? '').toLowerCase() === c;
}

const CATEGORY_DEFINITIONS = [
  { id: 'dev', Icon: Code2, nameKey: 'categories.cat_dev_name' as const, descKey: 'categories.cat_dev_desc' as const, color: '#5865f2' },
  { id: 'media', Icon: Music, nameKey: 'categories.cat_media_name' as const, descKey: 'categories.cat_media_desc' as const, color: '#ec4899' },
  { id: 'office', Icon: FileText, nameKey: 'categories.cat_office_name' as const, descKey: 'categories.cat_office_desc' as const, color: '#8b5cf6' },
  { id: 'security', Icon: ShieldCheck, nameKey: 'categories.cat_security_name' as const, descKey: 'categories.cat_security_desc' as const, color: '#10b981' },
  { id: 'graphics', Icon: Palette, nameKey: 'categories.cat_graphics_name' as const, descKey: 'categories.cat_graphics_desc' as const, color: '#f59e0b' },
  { id: 'network', Icon: Network, nameKey: 'categories.cat_network_name' as const, descKey: 'categories.cat_network_desc' as const, color: '#3b82f6' },
  { id: 'system', Icon: Cpu, nameKey: 'categories.cat_system_name' as const, descKey: 'categories.cat_system_desc' as const, color: '#6366f1' },
  { id: 'reading', Icon: BookOpen, nameKey: 'categories.cat_reading_name' as const, descKey: 'categories.cat_reading_desc' as const, color: '#14b8a6' },
  { id: 'ops', Icon: Terminal, nameKey: 'categories.cat_ops_name' as const, descKey: 'categories.cat_ops_desc' as const, color: '#f97316' },
  { id: 'games', Icon: Gamepad2, nameKey: 'categories.cat_games_name' as const, descKey: 'categories.cat_games_desc' as const, color: '#a855f7' },
];

export const CategoriesView: React.FC<CategoriesViewProps> = ({
  apps,
  platformResolvedOtherIds = new Set<string>(),
  installedIds,
  installingIds,
  favoriteIds,
  managedIds = null,
  watchedIds,
  onOpenDetail,
  onQuickInstall,
  onManageApp,
  onToggleFavorite,
  onToggleWatch,
  onResetPlatformFilter,
}) => {
  const { t } = useTranslation();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // 分类详情分页（BE `get_category_apps` page/per_page，首屏 20）：
  // - `pagedIds` 为 BE 顺序去重 id 序列（小写归一），行数据一律从 `apps` 属性按序取出——
  //   平台预过滤仍在 App 侧单次完成，此处只做 id 交集，不做二次平台/分类过滤；
  // - 图标回填等 patch 经 `apps` 属性流入，可见行自动跟进；
  // - 切分类即重置并取第 1 页；哨兵触底续页；失败页置 error 由重试按钮重发。
  const [pagedIds, setPagedIds] = useState<string[]>([]);
  const [catHasMore, setCatHasMore] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState(false);
  const pagedIdsRef = React.useRef<string[]>([]);
  const nextPageRef = React.useRef(2);
  const catHasMoreRef = React.useRef(false);
  const loadingRef = React.useRef(false);
  const genRef = React.useRef(0);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const loadMoreRef = React.useRef(() => {});

  const appendPageIds = (rows: AppSummary[]) => {
    const seen = new Set(pagedIdsRef.current);
    const next = [...pagedIdsRef.current];
    for (const r of rows) {
      const key = r.id.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        next.push(key);
      }
    }
    pagedIdsRef.current = next;
    setPagedIds(next);
  };

  const requestPage = (category: string, page: number, gen: number) => {
    loadingRef.current = true;
    setCatLoading(true);
    setCatError(false);
    getCategoryApps(category, page, CATEGORY_APPS_PER_PAGE).then(
      (res) => {
        if (genRef.current !== gen) return;
        appendPageIds(res.items);
        if (page >= nextPageRef.current) nextPageRef.current = page + 1;
        catHasMoreRef.current = res.has_more;
        setCatHasMore(res.has_more);
        loadingRef.current = false;
        setCatLoading(false);
      },
      () => {
        if (genRef.current !== gen) return;
        loadingRef.current = false;
        setCatLoading(false);
        setCatError(true);
      },
    );
  };

  // 切分类：重置分页并取第 1 页（`apps` 属性变化只重组可见行，不重置取页）。
  React.useEffect(() => {
    if (!selectedCategory) return;
    const gen = genRef.current + 1;
    genRef.current = gen;
    pagedIdsRef.current = [];
    setPagedIds([]);
    nextPageRef.current = 2;
    catHasMoreRef.current = false;
    setCatHasMore(false);
    requestPage(selectedCategory, 1, gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory]);

  loadMoreRef.current = () => {
    if (!selectedCategory || loadingRef.current || !catHasMoreRef.current) return;
    requestPage(selectedCategory, nextPageRef.current, genRef.current);
  };

  const handleRetry = () => {
    if (!selectedCategory || loadingRef.current) return;
    const page = pagedIdsRef.current.length === 0 ? 1 : nextPageRef.current;
    requestPage(selectedCategory, page, genRef.current);
  };

  // 触底续页哨兵（与发现页同口径 rootMargin 320px；失败页由重试按钮重发，不自动追）。
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!catHasMore || catError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [catHasMore, catError, pagedIds.length, selectedCategory]);

  // 可见行：BE 取页 id 序列 ∩ 平台预过滤 `apps` 属性（BE 顺序；图标 patch 随属性流入）。
  const visibleApps = React.useMemo(() => {
    const order = new Map<string, number>();
    pagedIds.forEach((id, i) => order.set(id, i));
    return apps
      .filter((a) => order.has(a.id.toLowerCase()))
      .sort(
        (x, y) =>
          (order.get(x.id.toLowerCase()) ?? 0) - (order.get(y.id.toLowerCase()) ?? 0),
      );
  }, [apps, pagedIds]);

  // 组装落盘补齐：分类列表 http 远端图标入队进盘（前 30 上限，`data:`/空跳过）。
  useEffect(() => {
    queueAssembledRowIcons(visibleApps);
  }, [visibleApps]);

  const currentCategoryMeta = CATEGORY_DEFINITIONS.find((c) => c.id === selectedCategory);

  const handleResetFilter = () => {
    onResetPlatformFilter();
    setSelectedCategory(null);
  };

  return (
    <ViewShell viewClass="categories-view">
      {/* 顶部标题与返回控制 */}
      <div className="section-header">
        <h3 className="section-title">
          {selectedCategory && currentCategoryMeta ? (
            <>
              <currentCategoryMeta.Icon size={18} style={{ color: currentCategoryMeta.color }} />
              <span>{t(currentCategoryMeta.nameKey)} ({visibleApps.length})</span>
            </>
          ) : (
            <>
              <Tag size={18} />
              <span>{t('categories.title')}</span>
            </>
          )}
        </h3>
        {selectedCategory && (
          <button
            className="btn-fluent btn-sm btn-secondary"
            onClick={() => setSelectedCategory(null)}
            style={{ gap: '6px' }}
          >
            <ArrowLeft size={13} />
            <span>{t('categories.back_to_hall')}</span>
          </button>
        )}
      </div>

      {!selectedCategory ? (
        <>
          {apps.length === 0 && (
            <FilterEmptyState
              style={{ marginBottom: '16px' }}
              title={t('categories.no_apps_device_filter')}
              description={t('categories.no_apps_device_filter_desc')}
              resetLabel={t('categories.reset_device_filter')}
              onReset={handleResetFilter}
            />
          )}
          <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {CATEGORY_DEFINITIONS.map((cat) => {
            // 大厅计数仅来源于传入的预过滤 `apps` 属性（匹配口径与 BE 同源，绝不自行二次平台过滤）。
            const count = apps.filter((a) => matchCategory(a, cat.id)).length;
            return (
              <div
                key={cat.id}
                className="app-card"
                style={{
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '20px 16px',
                  cursor: 'pointer',
                  opacity: count === 0 ? 0.6 : 1,
                }}
                onClick={() => setSelectedCategory(cat.id)}
              >
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: 'var(--radius-sm)',
                    background: `color-mix(in srgb, ${cat.color} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${cat.color} 25%, transparent)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '10px',
                  }}
                >
                  <cat.Icon size={20} color={cat.color} strokeWidth={1.5} />
                </div>
                <div style={{ fontWeight: 590, fontSize: 'calc(15px * var(--font-scale))', color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>{t(cat.nameKey)}</div>
                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', marginTop: '4px', lineHeight: '1.4' }}>{t(cat.descKey)}</div>
                <div
                  style={{
                    fontSize: 'var(--font-xs)',
                    marginTop: '10px',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-xs)',
                    background: `color-mix(in srgb, ${cat.color} 10%, transparent)`,
                    color: cat.color,
                    fontWeight: 510,
                    border: `1px solid color-mix(in srgb, ${cat.color} 20%, transparent)`,
                  }}
                >
                  {count > 0 ? t('categories.apps_available', { count }) : t('categories.no_apps_for_platform')}
                </div>
              </div>
            );
          })}
          </div>
        </>
      ) : (
        <div className="app-grid">
          {visibleApps.map((app, index) => (
            <AppCard
              key={app.id}
              app={app}
              eager={index < 6}
              platformPending={isPlatformPending(app, platformResolvedOtherIds)}
              isInstalled={selectIsInstalledUnion(app.id, installedIds)}
              isManaged={selectIsManagedOpt(app.id, managedIds)}
              isDetectedOnly={selectIsDetectedOnlyOpt(app.id, installedIds, managedIds)}
              isInstalling={installingIds?.has(app.id)}
              isFavorite={favoriteIds.has(app.id)}
              isWatched={watchedIds?.has(app.id)}
              onOpenDetail={onOpenDetail}
              onQuickInstall={onQuickInstall}
              onManageApp={onManageApp}
              onToggleFavorite={onToggleFavorite}
              onToggleWatch={onToggleWatch}
            />
          ))}
          {catLoading && (
            <div style={{ width: '100%' }}>{t('categories.list_loading')}</div>
          )}
          {catError && !catLoading && (
            <div style={{ width: '100%', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span>{t('categories.list_error')}</span>
              <button className="btn-fluent btn-sm btn-secondary" onClick={handleRetry}>
                {t('categories.retry')}
              </button>
            </div>
          )}
          {catHasMore && !catError && (
            <div ref={sentinelRef} style={{ width: '100%', height: '1px' }} />
          )}
          {!catLoading && !catError && !catHasMore && visibleApps.length === 0 && (
            <FilterEmptyState
              style={{ width: '100%' }}
              title={t('categories.category_empty_for_platform')}
              resetLabel={t('categories.reset_device_filter')}
              variant="secondary"
              onReset={handleResetFilter}
            />
          )}
        </div>
      )}
    </ViewShell>
  );
};
