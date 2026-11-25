import React, { useEffect, useMemo, useState } from 'react';
import { CountBadge } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
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
  ArrowUpRight,
} from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { AppIcon } from '../components/AppIcon';
import {
  FilterEmptyState,
  EMPTY_IDS,
  ViewAppActions,
  noopAction,
  resolvePlatformReset,
  ViewShell,
} from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import { isPlatformLoading } from '../lib/platformFilter';
import { CATEGORY_APPS_PER_PAGE, getCategoryApps } from '../services/api/catalog';
import type { AppSummary } from '../types';
import type { PlatformId } from '../lib/platformFilter';
import {
  isInstalled as selectIsInstalled,
  selectManagedState,
  selectPlatformCounts,
} from '../app/selectors';
import { normalizeId } from '../services/normalizeId';

interface CategoriesViewProps extends ViewAppActions {
  /** 进入视图时直接打开的分类（精选页「进入分类」），缺席时停在分类大厅。 */
  initialCategory?: string | null;
  /** 未按平台裁剪的全量合并目录，用于计算分类子页的全平台分布；缺省回退 `apps`。 */
  allApps?: readonly AppSummary[];
  /** 分类子页向侧栏上报该分类平台分布；在大厅或卸载时上报 `null`。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
}

/** 分类匹配与 BE `get_category_apps` 同口径（`category`/`category_name` 大小写不敏感）；
 * 详情行由 BE 过滤，此处仅大厅计数与预览用，不对已取回的行做二次分类过滤。 */
function matchCategory(app: AppSummary, category: string): boolean {
  const c = category.toLowerCase();
  return app.category.toLowerCase() === c || (app.category_name ?? '').toLowerCase() === c;
}

/** 每分类预览代表作上限 3 款：10 个分类合计 ≤ 30，严格对齐 `ASSEMBLED_ROW_ICON_QUEUE_CAP = 30`。 */
const PREVIEW_APPS_PER_CATEGORY = 3;

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

export const CategoriesView: React.FC<CategoriesViewProps> = (props) => {
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
    initialCategory = null,
    allApps,
    onDisplayPlatformCounts,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(initialCategory);

  // 分类详情分页：按后端有序 id 序列从已过滤的 `apps` 中映射渲染
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

  // 平台过滤后的可见目录 ID（小写、排序），交给后端在分页前过滤；`allowedKey` 作为稳定依赖签名。
  const allowedIds = useMemo(() => apps.map((a) => a.id.toLowerCase()).sort(), [apps]);
  const allowedKey = allowedIds.join('\n');

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
    getCategoryApps(category, page, CATEGORY_APPS_PER_PAGE, allowedIds).then(
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

  // 切分类或平台筛选变化：重置分页并取第 1 页（`apps` 内容不变的属性刷新只重组可见行）。
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
  }, [selectedCategory, allowedKey]);

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
  // root 绑定 `.content-area` 独立滚动容器，否则 rootMargin 只作用于视口。
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (!catHasMore || catError) return;
    const root = el.closest('.content-area');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { root: root instanceof Element ? root : null, rootMargin: '320px 0px' },
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

  // 大厅各分类统计与代表作预览：计数仅来源于传入的预过滤 `apps` 属性（绝不二次平台过滤）。
  const categoryStats = useMemo(() => {
    let maxCount = 0;
    let totalCount = 0;
    const entries = CATEGORY_DEFINITIONS.map((cat, index) => {
      const isFeatured = index < 2;
      const matched = apps.filter((a) => matchCategory(a, cat.id));
      const count = matched.length;
      totalCount += count;
      if (count > maxCount) maxCount = count;
      const previewApps = [...matched]
        .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
        .slice(0, PREVIEW_APPS_PER_CATEGORY);
      return {
        cat,
        isFeatured,
        count,
        previewApps,
      };
    });
    return { entries, maxCount, totalCount };
  }, [apps]);

  // 组装落盘补齐：详情列表或大厅代表作预览图标（≤ 30）入队进盘。
  useEffect(() => {
    if (selectedCategory) {
      queueAssembledRowIcons(visibleApps);
    } else {
      const previewIcons = categoryStats.entries.flatMap((e) => e.previewApps);
      queueAssembledRowIcons(previewIcons);
    }
  }, [selectedCategory, visibleApps, categoryStats]);

  const currentCategoryMeta = CATEGORY_DEFINITIONS.find((c) => c.id === selectedCategory);

  // 子页标题总数与大厅卡片「N 款可用」同源（均来自平台预过滤 `apps`），首帧即稳定，不随翻页跳变。
  const selectedCategoryCount = useMemo(
    () =>
      categoryStats.entries.find((e) => e.cat.id === selectedCategory)?.count ?? visibleApps.length,
    [categoryStats, selectedCategory, visibleApps.length],
  );

  // 侧栏平台分布：子页报该分类在未裁剪目录中的全平台分布，大厅报 null 恢复全库分布。
  const platformSource = allApps ?? apps;
  const categoryPlatformCounts = useMemo(() => {
    if (!selectedCategory) return null;
    const rows = platformSource.filter((a) => matchCategory(a, selectedCategory));
    return selectPlatformCounts(rows, platformResolvedOtherIds);
  }, [selectedCategory, platformSource, platformResolvedOtherIds]);

  useReportPlatformCounts(categoryPlatformCounts, onDisplayPlatformCounts, {
    view: 'categories',
    reportNull: true,
    resetOnUnmount: true,
  });

  const handleResetFilter = () => {
    resolvePlatformReset(onResetPlatformFilter)();
    setSelectedCategory(null);
  };

  return (
    <ViewShell viewClass="categories-view">
      {/* 顶部标题与返回控制 */}
      <div className="section-header categories-hall-header">
        <h3 className="section-title">
          {selectedCategory && currentCategoryMeta ? (
            <>
              <currentCategoryMeta.Icon
                size={18}
                strokeWidth={1.5}
                style={{ color: currentCategoryMeta.color }}
              />
              <span>{t(currentCategoryMeta.nameKey)}</span>
              <CountBadge value={selectedCategoryCount} />
            </>
          ) : (
            <>
              <Tag size={18} strokeWidth={1.5} />
              <span>{t('categories.title')}</span>
              <CountBadge value={categoryStats.totalCount} />
            </>
          )}
        </h3>
        {selectedCategory ? (
          <button
            type="button"
            className="btn-fluent btn-compact btn-secondary"
            onClick={() => setSelectedCategory(null)}
          >
            <ArrowLeft size={13} strokeWidth={1.5} />
            <span>{t('categories.back_to_hall')}</span>
          </button>
        ) : (
          categoryStats.totalCount > 0 && (
            <div className="categories-spectrum-bar" aria-hidden="true">
              <div className="categories-spectrum-track">
                {categoryStats.entries
                  .filter((item) => item.count > 0)
                  .map(({ cat, count }) => (
                    <span
                      key={cat.id}
                      className="categories-spectrum-segment"
                      style={
                        {
                          '--seg-color': cat.color,
                          flexGrow: count,
                        } as React.CSSProperties
                      }
                    />
                  ))}
              </div>
            </div>
          )
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

          <div className="categories-bento-grid">
            {categoryStats.entries.map(({ cat, isFeatured, count, previewApps }) => {
              const sharePercent =
                categoryStats.maxCount > 0
                  ? Math.round((count / categoryStats.maxCount) * 100)
                  : 0;
              const featuredNames = previewApps
                .slice(0, isFeatured ? 3 : 2)
                .map((a) => a.name)
                .join(' · ');

              return (
                <div
                  key={cat.id}
                  className={`app-card category-bento-card${isFeatured ? ' is-featured' : ''}${count === 0 ? ' is-empty' : ''}`}
                  role="button"
                  tabIndex={0}
                  style={{ '--cat-accent': cat.color } as React.CSSProperties}
                  onClick={() => setSelectedCategory(cat.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedCategory(cat.id);
                    }
                  }}
                >
                  <div className="category-card-top">
                    <div className="category-card-identity">
                      <div className="category-icon-tile">
                        <cat.Icon size={isFeatured ? 20 : 18} strokeWidth={1.5} />
                      </div>
                      <div className="category-title-wrap">
                        <div className="category-card-title">{t(cat.nameKey)}</div>
                        <span className="category-card-code" aria-hidden="true">
                          /{cat.id}
                        </span>
                      </div>
                    </div>
                    <div className="category-card-meta-right">
                      <span className="category-card-count">
                        {count > 0
                          ? t('categories.apps_available', { count })
                          : t('categories.no_apps_for_platform')}
                      </span>
                      <ArrowUpRight
                        size={14}
                        strokeWidth={1.5}
                        className="category-arrow-icon"
                        aria-hidden="true"
                      />
                    </div>
                  </div>

                  <p className="category-card-desc">{t(cat.descKey)}</p>

                  <div className="category-card-footer" aria-hidden="true">
                    <div className="category-app-dock">
                      {previewApps.length > 0 ? (
                        <>
                          <div className="category-dock-avatars">
                            {previewApps.map((app) => (
                              <div key={app.id} className="category-dock-item">
                                <AppIcon
                                  icon={app.icon}
                                  name={app.name}
                                  appId={app.id}
                                  iconBg={app.icon_bg}
                                  loading="lazy"
                                  className="category-dock-item-icon"
                                />
                              </div>
                            ))}
                          </div>
                          {featuredNames && (
                            <span className="category-dock-names">{featuredNames}</span>
                          )}
                        </>
                      ) : (
                        <span className="category-dock-empty-dot" />
                      )}
                    </div>
                    <div className="category-density-meter">
                      <div className="category-density-track">
                        <div
                          className="category-density-fill"
                          style={{
                            inlineSize: `${count > 0 ? Math.max(14, sharePercent) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
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
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            );
          })}
          {catLoading && (
            <div style={{ width: '100%' }}>{t('categories.list_loading')}</div>
          )}
          {catError && !catLoading && (
            <div style={{ width: '100%', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span>{t('categories.list_error')}</span>
              <button type="button" className="btn-fluent btn-compact btn-secondary" onClick={handleRetry}>
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
          {catHasMore && !catLoading && !catError && (
            <div className="feed-more-row" style={{ width: '100%' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                onClick={() => loadMoreRef.current()}
              >
                {t('categories.load_more')}
              </button>
            </div>
          )}
        </div>
      )}
    </ViewShell>
  );
};
