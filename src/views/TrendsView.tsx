import React, { useMemo, useRef } from 'react';
import { CountBadge } from '../components/CountBadge';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { RefreshCw, TrendingUp, WifiOff } from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { WatchEyeIcon } from '../components/icons/PlatformIcons';
import { SegmentedControl } from '../components/SegmentedControl';
import { useTrendBoard } from './TrendsView/useTrendBoard';
import { tauriApi } from '../services/api';
import {
  FilterEmptyState,
  ViewAppActions,
  ViewShell,
  noopAction,
  resolvePlatformReset,
} from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import {
  TREND_BOARD_IDS,
  formatStars,
  matchCatalogApp,
} from '../services/trends';
import { useMoveInToDraft } from '../app/hooks/useMoveInToDraft';
import { normalizeId } from '../services/normalizeId';
import type {
  AppSummary,
  TrendBoardId,
  TrendRepo,
  TrendsErrorKind,
} from '../types';
import {
  annotateEnrichMirrorCataloged,
  hasIdAliasMatch,
  resolveBareRowLocalBadgeVariant,
  isEnrichedRowLoading,
  isInstalled as selectIsInstalled,
  mergeLocalLookups,
  selectManagedState,
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
 * 抓取→L1→L2-hydrate→enrich-merge→落盘收口于 `services/trends` 会话控制器。
 */

interface TrendsViewProps extends ViewAppActions {
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
   * 草稿不是收录：本集合不参与黄标判定。
   */
  customIds?: ReadonlySet<string>;
  /**
   * 本地收录全量（App 侧 collectedSummaries：仅 collected 系未归档）：
   * 黄标唯一来源（草稿 `customIds` 不叠黄），缺席即回退目录自带 local 行。
   */
  localApps?: readonly AppSummary[];
}

/** 错误种类 → 描述文案键一处映射，避免渲染处散落四分支。 */
type TrendsErrorDescKey =
  | 'trends.error_network'
  | 'trends.error_timeout'
  | 'trends.error_rate_limited'
  | 'trends.error_unavailable';

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

export const TrendsView: React.FC<TrendsViewProps> = (props) => {
  const {
    apps,
    favoriteIds,
    installedIds,
    installingIds,
    managedIds = null,
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onToggleFavorite,
    onToggleWatch,
    watchedIds,
    onResetPlatformFilter,
    allApps,
    selectedPlatforms,
    platformResolvedOtherIds,
    onDisplayPlatformCounts,
    customIds,
    localApps,
  } = useAppContextProps(props);
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

  const matchingBase = allApps ?? apps;
  const trendLocalLookup = useMemo(() => {
    const inferred = (matchingBase ?? []).filter(
      (m) => (m as { source?: unknown }).source === 'local',
    );
    return mergeLocalLookups(inferred, localApps);
  }, [matchingBase, localApps]);

  const { isMovingIn: isTrendMovingIn, handleMoveIn: handleTrendMoveIn } = useMoveInToDraft();

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
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

  // 富卡生命周期与镜像编排（SWR/DB 图标回填/enrich/lite/settle/治愈/图标流/写透）收口单一控制器。
  const displayItemsRef = useRef<DisplayTrendItem[]>([]);
  const { enrichedApps, combinedConfirmed } = useTrendEnrichment({
    trendResult,
    rawItems: rawDisplayItems,
    getDisplayItems: () => displayItemsRef.current,
    activeBoard,
    trendFetchOpts,
    boardReady,
    refreshEnrichForceRef,
    globalConfirmed: platformResolvedOtherIds,
  });

  // enrich 合并处显式标注 is_cataloged（显式优先于 category 兜底；未命中=false 即显示按钮）。
  const annotatedEnrichedApps = useMemo(
    () => annotateEnrichMirrorCataloged(enrichedApps, matchingBase, localApps),
    [enrichedApps, matchingBase, localApps],
  );

  // 全局设备平台过滤接入榜单行（含未收录行）：加载中行恒可见，落定后再走 matchPlatformSet。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (!selectedPlatforms) return rawDisplayItems;
    return rawDisplayItems.filter((item) => {
      if (item.type === 'catalog') {
        return matchPlatformSetWithLoading(item.app, selectedPlatforms, platformResolvedOtherIds ?? new Set<string>());
      }
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      if (isEnrichedRowLoading(key, enriched, combinedConfirmed)) return true;
      return matchPlatformSet(enriched ?? { platforms: [] }, selectedPlatforms);
    });
  }, [rawDisplayItems, selectedPlatforms, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);
  displayItemsRef.current = displayItems;

  // 榜单平台分布：取平台过滤前的行，各平台计数不随当前勾选变化（加载中行暂不计数，落定后单次更新；榜单尚未返回前不上报假 0）。
  const displayPlatformCounts = useMemo<Record<PlatformId, number> | null>(() => {
    if (trendResult === null) return null;
    const counts = {} as Record<PlatformId, number>;
    for (const id of PLATFORM_IDS) counts[id] = 0;
    const platsOf = (item: DisplayTrendItem): string[] | undefined => {
      if (item.type === 'catalog') return item.app.platforms;
      return enrichedApps[item.repo.id.toLowerCase()]?.platforms;
    };
    const isLoadingItem = (item: DisplayTrendItem): boolean => {
      if (item.type === 'catalog') return isPlatformLoading(item.app, platformResolvedOtherIds ?? new Set<string>());
      const key = item.repo.id.toLowerCase();
      return isEnrichedRowLoading(key, enrichedApps[key], combinedConfirmed);
    };
    for (const id of PLATFORM_IDS) {
      const singleton = new Set<string>([id]);
      for (const item of rawDisplayItems) {
        if (isLoadingItem(item)) continue;
        if (matchPlatformSet({ platforms: platsOf(item) }, singleton)) counts[id] += 1;
      }
    }
    return counts;
  }, [trendResult, rawDisplayItems, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);

  useReportPlatformCounts(displayPlatformCounts, onDisplayPlatformCounts);

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
          {!isLoading && !errorKind && <CountBadge value={displayItems.length} />}
        </h3>
        {t('trends.subtitle') ? <p className="trends-subtitle">{t('trends.subtitle')}</p> : null}
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
          <button
            type="button"
            className="trends-refresh-btn"
            data-testid="trends-refresh"
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            aria-label={t('trends.refresh')}
            title={t('trends.refresh')}
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
                  isManaged={selectManagedState(item.app.id, managedIds)}
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
                  isManaged={selectManagedState(enriched.id, managedIds)}
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
                  isMovingIn={isTrendMovingIn(enriched.id)}
                  isCustomExisting={hasIdAliasMatch(enriched, customIds)}
                />
              );
            }

            const gainText = gainTextFor(item.gain);
            const owner = item.repo.owner?.trim();
            // 裸行迷你入口（复用 handleTrendMoveIn，isCustomExisting 同富卡隐藏逻辑）。
            // 裸行是唯一呈现（不走 AppCard），无它用户永远点不到；catalog 分支按设计不动。
            const bareKey = normalizeId(item.repo.id);
            const bareMoving = isTrendMovingIn(item.repo.id);
            const bareExisting = hasIdAliasMatch(item.repo, customIds);
            const bareWatched = watchedIds?.has(bareKey) ?? false;
            const bareFavorite = favoriteIds?.has(bareKey) ?? false;
            const bareMoveLabel = bareMoving
              ? t('custom.moving_in')
              : t('custom.move_in');
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
                        <WatchEyeIcon isWatched={bareWatched} />
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
                        className="btn-fluent btn-secondary btn-compact"
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
                        title={t('custom.move_in_hint')}
                        aria-label={bareMoveLabel}
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
