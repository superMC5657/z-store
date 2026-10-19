import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { RefreshCw, TrendingUp, WifiOff } from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { SegmentedControl } from '../components/SegmentedControl';
import { useTrendBoard } from './TrendsView/useTrendBoard';
import { tauriApi } from '../services/api';
import {
  FilterEmptyState,
  PlatformResetOption,
  ViewAppActions,
  ViewShell,
  resolvePlatformReset,
} from './ViewShell';
import {
  TREND_BOARD_IDS,
} from '../services/trends/boards';
import { formatStars, matchCatalogApp } from '../services/trends/enrich';
import { moveInToDraft } from '../services/custom/draft';
import { normalizeId } from '../services/normalizeId';
import { notifyToast } from '../utils/notify';
import type {
  AppSummary,
  TrendBoardId,
  TrendRepo,
  TrendsErrorKind,
} from '../types';
import {
  snapshotBoardEnrich,
  useTrendLoadingLifecycle,
} from '../services/trends/board';
import {
  LOADING_SETTLE_MS,
  annotateEnrichMirrorCataloged,
  resolveBareRowLocalBadgeVariant,
  isEnrichedRowLoading,
  isInstalled as selectIsInstalled,
  mergeLocalLookups,
  selectIsManagedOpt,
} from '../app/selectors';
import { VerifiedBadge } from '../components/VerifiedBadge';
import {
  PLATFORM_IDS,
  isPlatformLoading,
  matchPlatformSet,
  matchPlatformSetWithLoading,
  type PlatformId,
} from '../lib/platformFilter';
import { useTrendEnrichment, type DisplayTrendItem } from './TrendsView/useTrendEnrichment';

/**
 * 趋势榜单一榜一源：调 `fetchTrendsResult(board, { proxyPrefix })`，
 * 排序口径以后端 ranker 为准；
 * 代理前缀来自设置库 `active_mirror`（见下），service 内归一化（抓取忽略该字段）。
 * 远端为空一律走空状态，绝不回退本地加权假榜。
 *
 * 本 View 仅做 load/refresh + render/filter/count；
 * 抓取→L1→L2-hydrate→enrich-merge→落盘收口于 `services/trends/board`，
 * 持久化（hydrate/mark/unmark/saveBoardCacheMerged）一律经 board seam，
 * 此处仅持有 `enrichedApps` 镜像。
 */

interface TrendsViewProps
  extends
    Omit<ViewAppActions, 'favoriteIds' | 'installedIds' | 'installingIds' | 'onToggleFavorite'>,
    PlatformResetOption {
  favoriteIds?: Set<string>;
  installedIds?: Set<string>;
  installingIds?: Set<string>;
  onToggleFavorite?: (id: string) => void;
  watchedIds?: Set<string>;
  onToggleWatch?: (id: string) => void;
  /** 全量收录（身份匹配用；缺省回退 apps）。显示用 apps 仍为 App 预过滤后的集合。 */
  allApps?: AppSummary[];
  /** 全局设备平台选择：传入即按其过滤榜单行（含未收录行）；缺省不过滤。 */
  selectedPlatforms?: ReadonlySet<string>;
  /** 已确认 other 追踪（App 懒回填落定集合）：空集合即启用 loading 语义。 */
  platformResolvedOtherIds?: ReadonlySet<string>;
  /** 榜单平台分布上报（未过滤口径，供侧栏计数切到当前榜单；memo 稳定引用）。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number>) => void;
  /**
   * custom 草稿已存在 id 集（归一小写；App 侧以后端 customApps 全量 + 本地乐观移入合成，
   * 即 `selectMergedCatalogApps` 会命中 custom 行的 id 集合）：
   * 供未收录富卡内部移入入口抑制已存在项，缺席即不抑制。
   */
  customIds?: ReadonlySet<string>;
}

/** 错误种类 → 描述文案键一处映射，避免渲染处散落四分支。 */
type TrendsErrorDescKey =
  | 'trends.error_network'
  | 'trends.error_timeout'
  | 'trends.error_rate_limited'
  | 'trends.error_unavailable';

/**
 * 未收录行 loading 落定超时：enrich 空 + 一次 lite 仍未治愈（或 lite 不可用/stale）
 * 至多等待此后降级为已确认 Other（徽标 + 计数 + 可过滤），而非无限 shimmer。
 * 加载中期间行恒可见（不看 Other 勾选），落定后走正常 Other 过滤。
 * 导出供单测以假时钟推进（与主列表共用 `LOADING_SETTLE_MS` 同值）。
 */
export const TREND_LOADING_SETTLE_MS = LOADING_SETTLE_MS;

const ERROR_DESC_KEY: Record<TrendsErrorKind, TrendsErrorDescKey> = {
  network: 'trends.error_network',
  timeout: 'trends.error_timeout',
  'rate-limited': 'trends.error_rate_limited',
  unavailable: 'trends.error_unavailable',
};

/** 读取后端 `starsGained`：缺失或非正数返回 undefined（不渲染徽标）。 */
function getStarsGained(repo: TrendRepo): number | undefined {
  const n = repo.starsGained;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

export const TrendsView: React.FC<TrendsViewProps> = ({
  apps,
  favoriteIds,
  installedIds,
  installingIds,
  managedIds = null,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
  watchedIds,
  onResetPlatformFilter,
  allApps,
  selectedPlatforms,
  platformResolvedOtherIds,
  onDisplayPlatformCounts,
  customIds,
}) => {
  const { t } = useTranslation();
  const {
    setBoard,
    activeBoard,
    trendResult,
    gainKey,
    isLoading,
    boardReady,
    errorKind,
    handleRetry,
    isRefreshing,
    handleRefresh,
    trendFetchOpts,
    refreshEnrichForceRef,
  } = useTrendBoard('weekly');

  // 未收录行 enrichment 镜像（键为小写 owner/repo）：命中即完整 AppCard，
  // 缺席（加载中/失败）即旧小行占位，榜单永不因此变空。
  // View 仅持有此镜像；写透/hydrate/确认一律经 board seam。
  const [enrichedApps, setEnrichedApps] = useState<Record<string, AppSummary>>(() =>
    snapshotBoardEnrich(),
  );
  // 未收录行榜单内已确认 Other（lite 空非 stale 落定 + settle 超时兜底）：
  // App 级 lazyBackfill 只补 apps/recents，此处补 enrichedApps 覆盖不到的缺口；
  // 与全局 platformResolvedOtherIds 取并集判定 loading，详情治愈时同步移除。
  // 现状：初值置空由下 SWR 合并补齐；重启同 key 命中不回 loading；未就绪展裸行不拦榜。
  const [trendConfirmedOtherIds, setTrendConfirmedOtherIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const enrichedAppsRef = useRef(enrichedApps);
  enrichedAppsRef.current = enrichedApps;

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
  // catalog 匹配（matchCatalogApp）保留——下掉的只是分类榜单，不是收录对照展示。
  // 身份匹配用全量收录（未过滤口径，保证取消勾选后行直接消失而非降级为占位小行）。
  // 本地橘黄：matchingBase 为合并后全量（含本地 source，远端优先语义不动），
  // enrich 标注直接传数组本体以搬运 source/status（蓝优先）。
  const matchingBase = allApps ?? apps;
  // 本地显式 lookup（inferred + customIds 合成）：matchingBase 自带 local 行一般已够，
  // customIds（乐观移入/过滤后缺 local 时）显式补齐；引用变化即重标（缺席透传，就绪补黄）。
  const trendLocalLookup = useMemo(() => {
    const inferred = (matchingBase ?? []).filter(
      (m) => (m as { source?: unknown }).source === 'local',
    );
    return mergeLocalLookups(inferred, customIds);
  }, [matchingBase, customIds]);
  // enrich 合并处显式标注 is_cataloged（显式优先于 category 兜底；未命中=false 即显示按钮）。
  // 本地收录叠加经 customIds 显式口径补齐（matchingBase 缺 local 时 enrich 仍能黄）。
  const annotatedEnrichedApps = useMemo(
    () => annotateEnrichMirrorCataloged(enrichedApps, matchingBase, customIds),
    [enrichedApps, matchingBase, customIds],
  );

  // 移入收录（未收录富卡一键 save_custom_app 草稿，platforms [] loading）：
  // 经 tauriApi（视图禁直调 invoke，命令表驱动），复用 lite 确认链（缺席即 loading，编辑页可手改）。
  // 入口收进 AppCard 内部操作区（仅未收录 external 富卡渲染），小行无外挂按钮，
  // 小行 enrich 为富卡后同样走内部入口；此处只保留动作实现（useCallback 稳定引用）。
  const [trendMovingIds, setTrendMovingIds] = useState<Set<string>>(() => new Set<string>());
  const trendMovingRef = useRef<Set<string>>(new Set<string>());
  const handleTrendMoveIn = useCallback(async (app: AppSummary) => {
    const key = normalizeId(app.id);
    if (!key || trendMovingRef.current.has(key)) return;
    trendMovingRef.current.add(key);
    setTrendMovingIds((prev) => new Set(prev).add(key));
    try {
      const res = await moveInToDraft(app);
      if (!res.ok) {
        notifyToast(
          t('custom.move_in_failed', {
            defaultValue: `移入收录失败：${res.error ?? ''}`,
          }),
          'error',
        );
        return;
      }
      notifyToast(
        t('custom.moved_in', { defaultValue: `已移入收录草稿：${res.id}` }),
        'success',
      );
    } finally {
      trendMovingRef.current.delete(key);
      setTrendMovingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [t]);

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
  // catalog 匹配（matchCatalogApp）保留——下掉的只是分类榜单，不是收录对照展示。
  // 身份匹配用全量收录（未过滤口径，保证取消勾选后行直接消失而非降级为占位小行）。
  const rawDisplayItems = useMemo<DisplayTrendItem[]>(() => {
    if (trendResult === null || trendResult.status === 'error') return [];

    const repos = trendResult.repos;

    if (repos.length === 0) return [];

    const matchedAppIds = new Set<string>();
    const items: DisplayTrendItem[] = [];

    repos.forEach((trend) => {
      const matched = matchCatalogApp(trend, matchingBase);
      const gain = getStarsGained(trend);
      if (matched && !matchedAppIds.has(matched.id)) {
        matchedAppIds.add(matched.id);
        items.push({
          type: 'catalog',
          app: matched,
          gain,
        });
        return;
      }
      items.push({
        type: 'uncataloged',
        repo: trend,
        gain,
      });
    });

    return items;
  }, [trendResult, matchingBase]);

  // 双维 loading 生命周期编排（lite 补验 + settle 超时 + 确认集并集）：
  // View 不自持 inflight/seq/trusted/ref 镜像与两段 effect，经 board 唯一 hook 编排；
  // 返回的 `combinedConfirmed`（全局 ∪ 榜单内）为过滤/计数/徽标统一口径。
  const { combinedConfirmed } = useTrendLoadingLifecycle({
    trendResult,
    rawItems: rawDisplayItems,
    enrichedApps,
    activeBoard,
    trendFetchOpts,
    globalConfirmed: platformResolvedOtherIds,
    localConfirmed: trendConfirmedOtherIds,
    setEnrichedApps,
    setTrendConfirmedOtherIds,
    fetchLite: (liteId) => tauriApi.getPlatformsLite(liteId),
  });

  // 全局设备平台过滤接入榜单行（含未收录行）：catalog 命中按收录 platforms 判定，
  // 加载中行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet；
  // enrich 命中且具真实平台按其判定；enrich 空（`fallback_summary` 恒 `[]`）一律视为 loading：
  // 未确认前恒可见、不计入分布，详情治愈/lite 回填/确认为 other 后一次落定（VoiceStudio 类 bug 治愈）。
  // 裸 TrendRepo（enrich 尚未落定）视为 loading，恒可见，绝不视同 other；
  // settle 超时后降级为已确认 Other（可过滤、可计数、展示徽标），不再无限 shimmer。
  // 未传入 selectedPlatforms 时不过滤。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (!selectedPlatforms) return rawDisplayItems;
    // loading 语义（全局 ∪ 榜单内已确认；缺省集合即空追踪）。
    return rawDisplayItems.filter((item) => {
      if (item.type === 'catalog') {
        return matchPlatformSetWithLoading(item.app, selectedPlatforms, platformResolvedOtherIds ?? new Set<string>());
      }
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      // loading 语义：未落定恒可见（含裸行）；已确认 Other 后走正常 Other 过滤（统一接口判定）。
      if (isEnrichedRowLoading(key, enriched, combinedConfirmed)) return true;
      return matchPlatformSet(enriched ?? { platforms: [] }, selectedPlatforms);
    });
  }, [rawDisplayItems, selectedPlatforms, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);

  // 榜单平台分布（已过滤口径：计数跟随当前可见行，取消勾选即收缩；与过滤判定同语义）。
  // 加载中行暂不计数：裸 TrendRepo（enrich 未落定）、catalog loading 行、enrich 空 loading 行均排除在外，
  // 首绘不闪 Other=N，enrich/回填/详情治愈/settle 落定后单次更新。
  // memo 稳定引用：可见行/回填不变即不触发上报，避免侧栏数字闪烁。
  const displayPlatformCounts = useMemo<Record<PlatformId, number>>(() => {
    const counts = {} as Record<PlatformId, number>;
    for (const id of PLATFORM_IDS) counts[id] = 0;
    const platsOf = (item: DisplayTrendItem): string[] | undefined => {
      if (item.type === 'catalog') return item.app.platforms;
      return enrichedApps[item.repo.id.toLowerCase()]?.platforms;
    };
    const isLoadingItem = (item: DisplayTrendItem): boolean => {
      if (item.type === 'catalog') return isPlatformLoading(item.app, platformResolvedOtherIds ?? new Set<string>());
      // 未收录行 loading 口径与过滤判定同源（统一接口）。
      const key = item.repo.id.toLowerCase();
      return isEnrichedRowLoading(key, enrichedApps[key], combinedConfirmed);
    };
    for (const id of PLATFORM_IDS) {
      const singleton = new Set<string>([id]);
      for (const item of displayItems) {
        if (isLoadingItem(item)) continue;
        if (matchPlatformSet({ platforms: platsOf(item) }, singleton)) counts[id] += 1;
      }
    }
    return counts;
  }, [displayItems, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);

  useEffect(() => {
    onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  // 富卡编排（SWR/enrich/图标流/治愈/写透）收口单一 hook，View 只持镜像与渲染派生。
  useTrendEnrichment({
    mirror: {
      enrichedApps,
      setEnrichedApps,
      enrichedAppsRef,
      trendConfirmedOtherIds,
      setTrendConfirmedOtherIds,
    },
    trendResult,
    displayItems,
    activeBoard,
    trendFetchOpts,
    boardReady,
    refreshEnrichForceRef,
  });

  const gainTextFor = (gain?: number): string | undefined => {
    if (!gain || gain <= 0) return undefined;
    const count = formatStars(gain);
    if (gainKey === 'today') return t('trends.stars_gained_today', { count });
    if (gainKey === 'month') return t('trends.stars_gained_month', { count });
    return t('trends.stars_gained_week', { count });
  };

  // 首绘门（裸行先展不拦榜，仅升级受门控）：渲染本身不拦榜，升级路径见上门控。

  return (
    <ViewShell viewClass="trends-view">
      <div className="section-header trends-header">
        <h3 className="section-title">
          <TrendingUp size={18} />
          <span>{t('trends.title')}</span>
        </h3>
        <p className="trends-subtitle">{t('trends.subtitle')}</p>
      </div>

      <div className="trends-toolbar">
        <div className="trends-boards" role="tablist" aria-label={t('trends.title')}>
          <SegmentedControl<TrendBoardId>
            value={activeBoard}
            onChange={(next) => setBoard(next)}
            options={TREND_BOARD_IDS.map((id) => ({
              value: id,
              label: t(`trends.board_${id}`),
              title: t(`trends.board_${id}_desc`),
            }))}
          />
        </div>
      </div>

      <div className="trends-meta">
        <span className="trends-board-desc">{t(`trends.board_${activeBoard}_desc`)}</span>
        <span className="trends-meta-right">
          {displayItems.length > 0 && (
            <span className="trends-count">
              {t('trends.results_count', { count: displayItems.length })}
            </span>
          )}
          <button
            type="button"
            className="trends-refresh-btn"
            data-testid="trends-refresh"
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            aria-label={t('trends.refresh', { defaultValue: '刷新' })}
            title={t('trends.refresh', { defaultValue: '刷新' })}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={isRefreshing ? 'trends-refresh-spin' : ''}
            />
          </button>
        </span>
      </div>

      <div className="fluent-list-container">
        {isLoading ? null : errorKind ? (
          <FilterEmptyState
            className="trends-empty trends-error"
            icon={<WifiOff size={40} strokeWidth={1.5} />}
            title={t('trends.error_title')}
            description={t(ERROR_DESC_KEY[errorKind])}
            resetLabel={t('trends.retry')}
            onReset={handleRetry}
          />
        ) : apps.length === 0 || displayItems.length === 0 ? (
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
              // 加载中恒可见（统一接口）。
              const catalogLoading = isPlatformLoading(item.app, platformResolvedOtherIds ?? new Set<string>());
              return (
                <AppCard
                  key={item.app.id}
                  app={item.app}
                  platformLoading={catalogLoading}
                  className="fluent-list-row"
                  eager={index < 6}
                  trendGain={item.gain}
                  trendGainText={gainTextFor(item.gain)}
                  isInstalled={selectIsInstalled(item.app.id, installedIds)}
                  isManaged={selectIsManagedOpt(item.app.id, managedIds)}
                  isInstalling={installingIds?.has(item.app.id) ?? false}
                  isFavorite={favoriteIds?.has(normalizeId(item.app.id)) ?? false}
                  isWatched={watchedIds?.has(normalizeId(item.app.id)) ?? false}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                  onToggleWatch={onToggleWatch}
                />
              );
            }

            // 未收录行：enrich 命中即完整 AppCard（搜索式外观 + 涨星徽标），
            // 右按钮直开 GitHub（不调安装链）；缺席（加载中/失败）即旧小行占位。
            // enrich 空（fallback []）视为 loading：占位不闪 Other，Other 未勾选仍可见，
            // 详情治愈/lite 回填/settle 确认为 other 后一次落定。
            // 取标注后镜像（is_cataloged 显式=false，未命中 catalog），显式优先于 category 兜底。
            const enriched = annotatedEnrichedApps[item.repo.id.toLowerCase()];
            if (enriched) {
              const hasPlatforms = !!enriched.platforms && enriched.platforms.length > 0;
              const repoKey = item.repo.id.toLowerCase();
              // 未收录行 loading 口径与过滤判定同源（统一接口）。
              const enrichedLoading =
                !hasPlatforms && isEnrichedRowLoading(repoKey, enriched, combinedConfirmed);
              return (
                <AppCard
                  key={`uncataloged-${item.repo.id || item.repo.name}-${index}`}
                  app={enriched}
                  platformLoading={enrichedLoading}
                  className="fluent-list-row"
                  eager={index < 6}
                  trendGain={item.gain}
                  trendGainText={gainTextFor(item.gain)}
                  // 未收录 enrich 行安装态走真实已安装检查（归一 ID），禁止回退硬编码 false。
                  isInstalled={selectIsInstalled(enriched.id, installedIds)}
                  isManaged={selectIsManagedOpt(enriched.id, managedIds)}
                  isInstalling={false}
                  isFavorite={favoriteIds?.has(normalizeId(enriched.id)) ?? false}
                  isWatched={watchedIds?.has(normalizeId(enriched.id)) ?? false}
                  onOpenDetail={onOpenDetail}
                  onToggleFavorite={onToggleFavorite}
                  onToggleWatch={onToggleWatch}
                  onQuickInstall={() => {
                    if (item.repo.url) {
                      void tauriApi.openUrl(item.repo.url);
                    }
                  }}
                  onMoveInApp={handleTrendMoveIn}
                  isMovingIn={trendMovingIds.has(normalizeId(enriched.id))}
                  isCustomExisting={customIds?.has(normalizeId(enriched.id)) ?? false}
                />
              );
            }

            const gainText = gainTextFor(item.gain);
            const owner = item.repo.owner?.trim();
            // 裸行迷你入口（复用 handleTrendMoveIn，isCustomExisting 同富卡隐藏逻辑）。
            // 裸行是唯一呈现（不走 AppCard），无它用户永远点不到；catalog 分支按设计不动。
            const bareKey = normalizeId(item.repo.id);
            const bareMoving = trendMovingIds.has(bareKey);
            const bareExisting = customIds?.has(bareKey) ?? false;
            const bareWatched = watchedIds?.has(bareKey) ?? false;
            const bareFavorite = favoriteIds?.has(bareKey) ?? false;
            const bareMoveLabel = bareMoving
              ? t('custom.moving_in', { defaultValue: '移入中…' })
              : t('custom.move_in', { defaultValue: '移入收录' });
            // 裸行黄标：enrich 缺席占位小行命中本地也在标题旁黄标（复用 verified-badge-local，
            // 判定唯一口径在 selectors，蓝优先；身份归一沿用 rowAliasKeys）。
            const bareLocalVariant = trendLocalLookup
              ? resolveBareRowLocalBadgeVariant(item.repo, trendLocalLookup)
              : null;

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
                <div className="app-card-header trend-uncataloged-main">
                  <div className="app-meta" style={{ minWidth: 0 }}>
                    <div className="app-title">
                      <span className="app-name">{item.repo.name}</span>
                      {bareLocalVariant === 'local' && <VerifiedBadge size="sm" variant="local" />}
                    </div>
                    {owner && (
                      <div className="app-owner">
                        {t('trends.built_by', { owner })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="app-card-footer trend-uncataloged-side">
                  <div className="app-tags">
                    <span className="app-tag app-tag-star">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span>{formatStars(item.repo.stars)}</span>
                    </span>
                    {gainText && (
                      <span className="app-tag trend-gain" title={gainText}>
                        {gainText}
                      </span>
                    )}
                    {onToggleWatch && (
                      <button
                        type="button"
                        className={`btn-fav-card ${bareWatched ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleWatch(item.repo.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={bareWatched ? t('app.watch_active') : t('app.watch_inactive')}
                        aria-label={bareWatched ? t('app.watch_active') : t('app.watch_inactive')}
                        style={bareWatched ? { color: 'var(--brand-primary)' } : undefined}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={bareWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                    )}
                    {onToggleFavorite && (
                      <button
                        type="button"
                        className={`btn-fav-card ${bareFavorite ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(item.repo.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={bareFavorite ? t('app.fav_active') : t('app.fav_inactive')}
                        aria-label={bareFavorite ? t('app.fav_active') : t('app.fav_inactive')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={bareFavorite ? '#eab308' : 'none'} stroke={bareFavorite ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                        </svg>
                      </button>
                    )}
                    {!bareExisting && (
                      <button
                        type="button"
                        data-testid={`trend-move-in-${item.repo.id}`}
                        className="btn-fluent btn-secondary"
                        disabled={bareMoving}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleTrendMoveIn({
                            id: item.repo.id,
                            name: item.repo.name,
                            owner: item.repo.owner,
                            repo: item.repo.repo,
                            icon: '',
                            icon_bg: '',
                            description: item.repo.description ?? item.repo.name,
                            stars: item.repo.stars,
                            forks: item.repo.forks ?? 0,
                            license: '',
                            latest_version: 'latest',
                            category: 'external',
                            category_name: 'external',
                            is_verified: false,
                            forge: 'github',
                            forge_host: 'github.com',
                            homepage: item.repo.url ?? null,
                            platforms: [],
                            is_cataloged: false,
                          } as AppSummary);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('custom.move_in_hint', { defaultValue: '存为本地自维护草稿，编辑页可手改' })}
                        aria-label={bareMoveLabel}
                        style={{ padding: '2px 8px', fontSize: 'var(--font-xs)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <span>{bareMoveLabel}</span>
                      </button>
                    )}
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
