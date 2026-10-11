import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { RefreshCw, TrendingUp, WifiOff } from 'lucide-react';
import { AppSummary } from '../types';
import { AppCard, getRankBadgeColor } from '../components/AppCard';
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
  enrichTrendRepos,
  formatStars,
  matchCatalogApp,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
  type TrendBoardId,
  type TrendRepo,
  type TrendsErrorKind,
} from '../services/trends';
import {
  applyPlatformsHealToMirror,
  applyIconChangedToMirror,
  applyRichcardHealToMirror,
  boardRepoKeys,
  buildSwrFill,
  cleanupPlatformsHealConfirmed,
  collectMissingEnrichRepos,
  flushBoardPersist,
  getBoardPersistKey,
  hydrateBoardEnrich,
  isEnrichUpgradeAllowed,
  isUpgradePending,
  mergeEnrichFoundMirror,
  mergeSwrConfirmedMirror,
  mergeSwrEnrichedMirror,
  noteBoardReposForPersist,
  persistBoardNow,
  persistRichcardHeal,
  removeConfirmedForConcrete,
  resolveBoardCacheKey,
  scheduleBoardPersist,
  snapshotBoardEnrich,
  subscribeBoardPersistOnConfirmedChange,
  subscribeTrendHealBus,
  swrSyncedResult,
  unmarkConcreteKeys,
  unmarkPlatformsHealKeys,
  useTrendPendingLifecycle,
} from '../services/trends/board';
import {
  PENDING_SETTLE_MS,
  isEnrichedRowPending,
  isPendingFor,
  matchSelectedWithPending,
} from '../app/selectors';
import {
  PLATFORM_IDS,
  matchPlatformSet,
  type PlatformId,
} from '../lib/platformFilter';
import { applyHit, subscribeIconWrites } from '../services/iconStore';

/**
 * 趋势榜单一榜一源：调 `fetchTrendsResult(board, { proxyPrefix })`，
 * 排序口径以后端 ranker 为准，前端不再做 fork/star 加权复算；
 * gh-proxy 前缀来自设置库 `active_mirror`（见下），service 内归一化。
 * 远端为空一律走空状态，绝不回退本地加权假榜。
 *
 * C2 vertical slice：本 View 仅做 load/refresh + render/filter/count；
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
  /** 全量收录（身份匹配用；缺省回退 apps）。显示用 apps 仍为 App 预过滤后的集合。 */
  allApps?: AppSummary[];
  /** 全局设备平台选择：传入即按其过滤榜单行（含未收录行）；缺省不过滤（旧行为）。 */
  selectedPlatforms?: ReadonlySet<string>;
  /** 已确认 other 追踪（App 懒回填落定集合）：缺席时沿用旧语义，传入空集合即启用 pending 语义。 */
  platformResolvedOtherIds?: ReadonlySet<string>;
  /** 榜单平台分布上报（未过滤口径，供侧栏计数切到当前榜单；memo 稳定引用）。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number>) => void;
}

type DisplayTrendItem =
  | { type: 'catalog'; app: AppSummary; rank: number; gain?: number }
  | { type: 'uncataloged'; repo: TrendRepo; rank: number; gain?: number };

/** 错误种类 → 描述文案键一处映射，避免渲染处散落四分支。 */
type TrendsErrorDescKey =
  | 'trends.error_network'
  | 'trends.error_timeout'
  | 'trends.error_rate_limited'
  | 'trends.error_unavailable';

/**
 * 未收录行 pending 落定超时：enrich 空 + 一次 lite 仍未治愈（或 lite 不可用/stale）
 * 至多等待此后降级为已确认 Other（徽标 + 计数 + 可过滤），而非无限 shimmer。
 * 待确认期间行恒可见（不看 Other 勾选），落定后走正常 Other 过滤。
 * 导出供单测以假时钟推进（与主列表共用 `PENDING_SETTLE_MS` 同值）。
 */
export const TREND_PENDING_SETTLE_MS = PENDING_SETTLE_MS;

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
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onResetPlatformFilter,
  allApps,
  selectedPlatforms,
  platformResolvedOtherIds,
  onDisplayPlatformCounts,
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
  } = useTrendBoard('weekly');

  // 未收录行 enrichment 镜像（键为小写 owner/repo）：命中即完整 AppCard，
  // 缺席（加载中/失败）即旧小行占位，榜单永不因此变空。
  // C2：View 仅持有此镜像；写透/hydrate/确认一律经 board seam。
  const [enrichedApps, setEnrichedApps] = useState<Record<string, AppSummary>>(() =>
    snapshotBoardEnrich(),
  );
  // 未收录行榜单内已确认 Other（lite 空非 stale 落定 + settle 超时兜底）：
  // App 级 lazyBackfill 只补 apps/recents，此处补 enrichedApps 覆盖不到的缺口；
  // 与全局 platformResolvedOtherIds 取并集判定 pending，详情治愈时同步移除。
  // 现状：初值置空由下 SWR 合并补齐；重启同 key 命中不回 pending；未就绪展裸行不拦榜。
  const [trendConfirmedOtherIds, setTrendConfirmedOtherIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const enrichedAppsRef = useRef(enrichedApps);
  enrichedAppsRef.current = enrichedApps;

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
  // catalog 匹配（matchCatalogApp）保留——下掉的只是分类榜单，不是收录对照展示。
  // 身份匹配用全量收录（未过滤口径，保证取消勾选后行直接消失而非降级为占位小行）。
  const matchingBase = allApps ?? apps;
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
          rank: items.length + 1,
          gain,
        });
        return;
      }
      items.push({
        type: 'uncataloged',
        repo: trend,
        rank: items.length + 1,
        gain,
      });
    });

    return items;
  }, [trendResult, matchingBase]);

  // 双维 pending 生命周期编排（lite 补验 + settle 超时 + 确认集并集，ticket 11）：
  // View 不再自持 inflight/seq/trusted/ref 镜像与两段 effect，经 board 唯一 hook 编排；
  // 返回的 `combinedConfirmed`（全局 ∪ 榜单内）为过滤/计数/徽标统一口径。
  const { combinedConfirmed } = useTrendPendingLifecycle({
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
  // 待确认行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet；
  // enrich 命中且具真实平台按其判定；enrich 空（`fallback_summary` 恒 `[]`）一律视为 pending：
  // 未确认前恒可见、不计入分布，详情治愈/lite 回填/确认为 other 后一次落定（VoiceStudio 类 bug 治愈）。
  // 裸 TrendRepo（enrich 尚未落定）视为 pending，恒可见，绝不视同 other；
  // settle 超时后降级为已确认 Other（可过滤、可计数、展示徽标），不再无限 shimmer。
  // 未传入 selectedPlatforms 时不过滤（旧行为，单测与旧调用方保持）。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (!selectedPlatforms) return rawDisplayItems;
    // 未接入追踪集合时沿用旧语义（裸行/空回填视同 other），保证旧调用方零变化；
    // 传入集合（含空集合）即启用 pending 语义（全局 ∪ 榜单内已确认）。
    const withPending = platformResolvedOtherIds !== undefined;
    return rawDisplayItems.filter((item) => {
      if (item.type === 'catalog') {
        if (withPending) return matchSelectedWithPending(item.app, selectedPlatforms, platformResolvedOtherIds);
        return matchPlatformSet(item.app, selectedPlatforms);
      }
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      if (!withPending) {
        if (enriched) return matchPlatformSet(enriched, selectedPlatforms);
        return selectedPlatforms.has('other');
      }
      // pending 语义：未落定恒可见（含裸行）；已确认 Other 后走正常 Other 过滤（统一接口判定）。
      if (isEnrichedRowPending(key, enriched, combinedConfirmed)) return true;
      return matchPlatformSet(enriched ?? { platforms: [] }, selectedPlatforms);
    });
  }, [rawDisplayItems, selectedPlatforms, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);

  // 榜单平台分布（已过滤口径：计数跟随当前可见行，取消勾选即收缩；与过滤判定同语义）。
  // 待确认行暂不计数：裸 TrendRepo（enrich 未落定）、catalog pending 行、enrich 空 pending 行均排除在外，
  // 首绘不闪 Other=N，enrich/回填/详情治愈/settle 落定后单次更新。未接入追踪时沿用旧语义。
  // memo 稳定引用：可见行/回填不变即不触发上报，避免侧栏数字闪烁。
  const displayPlatformCounts = useMemo<Record<PlatformId, number>>(() => {
    const counts = {} as Record<PlatformId, number>;
    for (const id of PLATFORM_IDS) counts[id] = 0;
    const withPending = platformResolvedOtherIds !== undefined;
    const platsOf = (item: DisplayTrendItem): string[] | undefined => {
      if (item.type === 'catalog') return item.app.platforms;
      return enrichedApps[item.repo.id.toLowerCase()]?.platforms;
    };
    const isPendingItem = (item: DisplayTrendItem): boolean => {
      if (!withPending) return false;
      if (item.type === 'catalog') return isPendingFor(item.app, platformResolvedOtherIds);
      // 未收录行 pending 口径与过滤判定同源（统一接口）。
      const key = item.repo.id.toLowerCase();
      return isEnrichedRowPending(key, enrichedApps[key], combinedConfirmed);
    };
    for (const id of PLATFORM_IDS) {
      const singleton = new Set<string>([id]);
      for (const item of displayItems) {
        if (isPendingItem(item)) continue;
        if (matchPlatformSet({ platforms: platsOf(item) }, singleton)) counts[id] += 1;
      }
    }
    return counts;
  }, [displayItems, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);

  useEffect(() => {
    onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  // SWR 旧富卡直展：榜缓存二级富信封命中后 boards 已 hydrate 进内存，
  // 此处经 board seam 同步合并进镜像先展旧富卡（含 pending 的 Other 待确认语义），不闪裸行；
  // 后台 enrich effect 再 revalidate 缺席项，找到具平台再覆盖写透；永不用空值覆盖已具平台值。
  // C2：合并逻辑收口 board（buildSwrFill + merge*Mirror），View 只做 load/refresh + 镜像持有。
  useEffect(() => {
    if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) {
      return;
    }
    const { snap, l2Confirmed } = buildSwrFill(trendResult.repos);
    if (l2Confirmed.length > 0) {
      setTrendConfirmedOtherIds((prev) => mergeSwrConfirmedMirror(prev, l2Confirmed, snap));
    }
    setEnrichedApps((prev) => mergeSwrEnrichedMirror(prev, snap));
  }, [trendResult]);

  // 未收录行 enrichment：逐仓复用搜索 enrichment（Rust 侧并发 5、分片 20/片×2 片=40 上限、单仓 10s），
  // 成功合并为完整卡片；失败/无命中保持旧小行（enrichTrendRepos 缺席即不写，缺席即展裸行/旧缓存，不等齐）。
  // C2：合并 + 写透收口 board（collectMissing + mergeEnrichFoundMirror + persistBoardNow）；
  // 裸行先展不拦榜，仅富卡升级受 boardReady 门控（swrSyncedResult/isUpgradePending）。
  useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    const missing = collectMissingEnrichRepos(displayItems, enrichedApps);
    if (missing.size === 0) return;
    let cancelled = false;
    // 写透时机：enrich 完成即同步 await 写透一次（关闭前 fire-and-forget 易丢，flush 兜底见下）。
    void enrichTrendRepos([...missing.values()]).then(async (found) => {
      if (cancelled || found.size === 0) return;
      // 首绘门：裸行已直展，此处仅做升级；未就绪时延迟到 boardReady 置位后（下轮 effect 重入）。
      const swrSynced = swrSyncedResult(trendResult.repos, enrichedAppsRef.current);
      if (isUpgradePending(boardReady, swrSynced) && !isEnrichUpgradeAllowed(boardReady)) {
        return;
      }
      const { next, hasNewEnrich, concreteKeys } = mergeEnrichFoundMirror(
        enrichedAppsRef.current,
        found,
      );
      if (next !== enrichedAppsRef.current) setEnrichedApps(next);
      // 具平台到达可覆盖升级：enrich 具平台即移出已确认（本地 + board 内存标记）。
      if (concreteKeys.length > 0) {
        unmarkConcreteKeys(concreteKeys);
        setTrendConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, concreteKeys));
      }
      // enrich 落定后经 board seam 写透同榜 key（await 落稳再返回，刷新 cached_at 即刷新 12h 窗口）。
      if (hasNewEnrich && trendResult.repos.length > 0) {
        const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
        await persistBoardNow(cacheKey, cacheBoard, trendResult.repos);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendResult, displayItems, activeBoard, trendFetchOpts, boardReady]);

  // 当前榜快照同步（render 侧同步 note，供 board debounce/pagehide/confirm 链读取）。
  // P1-C3 读写同源：key 与 boards 读路径同源（同 board + 同 trendFetchOpts），杜绝读写分叉。
  if (trendResult?.status === 'ok' && trendResult.repos.length > 0) {
    const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
    noteBoardReposForPersist({ cacheKey, cacheBoard, repos: trendResult.repos });
  }
  useEffect(() => {
    const flush = (): void => {
      flushBoardPersist();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // 已确认变更写透联动：经 board 统一订阅（mark/unmark 触发节流写透；读路径不触发）。
  useEffect(() => {
    return subscribeBoardPersistOnConfirmedChange();
  }, []);

  // 趋势流式图标订阅。
  // 后台 `icon-ready` 经 `applyHit` 接上 `board` 门控逐个补齐富卡图标。
  // 此处只 patch 图标（空值规则由店内保证），
  // 平台逻辑不动；`data:`/`via=m2`只进M1内存不落盘，`remote`才 hydrate + 节流写透榜缓存二级。
  // C2：hydrate/写透经 board seam（hydrateBoardEnrich + scheduleBoardPersist）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void tauriApi
      .onSearchIconUpgraded((payload) => {
        if (cancelled) return;
        const raw = (payload ?? {}) as unknown as Record<string, unknown>;
        const ctx = (raw['context'] ?? null) as {
          kind: string;
          search_id?: string;
          board?: string;
          gen?: number;
        } | null;
        const kind =
          ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
        // 趋势只消费 `trend` 上下文；搜索（`search`）交 App 处理。
        if (kind !== 'trend') return;
        const asStr = (v: unknown): string | undefined =>
          typeof v === 'string' ? v : undefined;
        const res = applyHit({
          key: asStr(raw['key']),
          id: asStr(raw['id']) ?? asStr(raw['app_id']),
          app_id: asStr(raw['app_id']),
          icon: asStr(raw['icon']),
          level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
          via: asStr(raw['via']),
          context: ctx,
          board: activeBoard,
          getCurrentIcon: (tid) => {
            const lk = tid.toLowerCase();
            return enrichedAppsRef.current[lk]?.icon;
          },
          patch: (tid, icon) => {
            setEnrichedApps((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const k of Object.keys(prev)) {
                const cur = prev[k];
                const alias = String(cur?.id ?? '').trim().toLowerCase();
                if (k.toLowerCase() === tid || (alias !== '' && alias === tid)) {
                  if (cur.icon !== icon) {
                    next[k] = { ...cur, icon };
                    changed = true;
                  }
                }
              }
              return changed ? next : prev;
            });
          },
        });
        if (!res.accepted || !res.icon) return;
        // 图标落盘：已 patch 条目经 board seam hydrate 快照 + 节流写透同榜 key。
        try {
          const targets = res.targets ?? [];
          if (targets.length === 0) return;
          const latest = enrichedAppsRef.current;
          const toHydrate: Record<string, AppSummary> = {};
          for (const t of targets) {
            for (const k of Object.keys(latest)) {
              const cur = latest[k];
              if (!cur) continue;
              const alias = String(cur.id ?? '').trim().toLowerCase();
              if (k.toLowerCase() === t || (alias !== '' && alias === t)) {
                toHydrate[k] = { ...cur, icon: res.icon };
              }
            }
          }
          if (Object.keys(toHydrate).length === 0) return;
          hydrateBoardEnrich(toHydrate);
          const cacheKey = getBoardPersistKey();
          if (!cacheKey) return;
          scheduleBoardPersist(cacheKey);
        } catch {
          // 落盘失败不影响内存即时补齐
        }
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch(() => {
        // 非 Tauri 环境（单测/浏览器预览）无事件总线：静默跳过，enrich 等齐路照旧
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeBoard]);

  // 治愈总线统一订阅：2 路 window 事件（detail-platforms / detail-richcard）
  // 经 board 同一归一 upsert 路径进镜像（normalizeHealKeys + boardRepoKeys 过滤跨榜）。
  // 图标经 `icon-ready → applyHit` 唯一写口逐个补齐（见上流式订阅），不走窗口总线。
  // C2：关闭原散写；key 归一 lower-trim 同源。
  useEffect(() => {
    return subscribeTrendHealBus({
      onPlatformsHeal: (payload: DetailPlatformsHealPayload, keys: string[]) => {
        const repoKeys = boardRepoKeys(trendResult?.repos);
        setEnrichedApps((prev) =>
          applyPlatformsHealToMirror(prev, keys, payload.summary, payload.platforms, repoKeys),
        );
        setTrendConfirmedOtherIds((prev) => cleanupPlatformsHealConfirmed(prev, keys));
        // 具平台升级同步清 board 内存确认标记（App 侧 upsert 已清同键，此处补清别名）。
        unmarkPlatformsHealKeys(keys);
      },
      onRichcardHeal: (payload: DetailRichcardHealPayload) => {
        const repoKeys = boardRepoKeys(trendResult?.repos);
        setEnrichedApps((prev) => applyRichcardHealToMirror(prev, payload, repoKeys));
        persistRichcardHeal(enrichedAppsRef.current, payload, repoKeys);
      },
    });
  }, [trendResult]);

  // 榜单 pending 生命周期（lite 补验 + settle 超时）经 board 唯一 hook 编排，
  // 此处不再自持 seq/inflight effect（重实现已删，见 `useTrendPendingLifecycle`）。

  // 图标写扇出订阅（读侧）：店内唯一写口受理后镜像跟进——覆盖无 patch 的本地写
  // （如详情轮转切 L5 只调 `applyHit` 不带 patch，榜单行经此清徽章）。
  // 纯内存合并（`applyIconChangedToMirror` 同语义；`''`/`data:` 不 hydrate/写透，
  // 与 `persistIconChanged` 同规则）；持久化源为 cycle 行/detail_json，remount 重衍生。
  // 卸载即退订。
  useEffect(() => {
    return subscribeIconWrites(({ targets, icon }) => {
      for (const t of targets) {
        setEnrichedApps((prev) => applyIconChangedToMirror(prev, t, icon));
      }
    });
  }, []);

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
              // 待确认恒可见（统一接口；缺席追踪集合时恒非 pending，沿用旧语义）。
              const catalogPending = isPendingFor(item.app, platformResolvedOtherIds);
              return (
                <AppCard
                  key={item.app.id}
                  app={item.app}
                  platformPending={catalogPending}
                  rank={item.rank}
                  className="fluent-list-row"
                  eager={index < 6}
                  trendGain={item.gain}
                  trendGainText={gainTextFor(item.gain)}
                  isInstalled={installedIds?.has(item.app.id) ?? false}
                  isInstalling={installingIds?.has(item.app.id) ?? false}
                  isFavorite={favoriteIds?.has(item.app.id) ?? false}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                />
              );
            }

            // 未收录行：enrich 命中即完整 AppCard（搜索式外观 + 涨星徽标），
            // 右按钮直开 GitHub（不调安装链）；缺席（加载中/失败）即旧小行占位。
            // enrich 空（fallback []）视为 pending：占位不闪 Other，Other 未勾选仍可见，
            // 详情治愈/lite 回填/settle 确认为 other 后一次落定。
            const enriched = enrichedApps[item.repo.id.toLowerCase()];
            if (enriched) {
              const hasDesc =
                enriched.description?.trim() || enriched.description_en?.trim();
              const displayApp = hasDesc
                ? enriched
                : { ...enriched, description: t('trends.no_desc') };
              const hasPlatforms = !!enriched.platforms && enriched.platforms.length > 0;
              const repoKey = item.repo.id.toLowerCase();
              // 未收录行 pending 口径与过滤判定同源（统一接口；缺席追踪集合时恒落定，沿用旧语义）。
              const enrichedPending = platformResolvedOtherIds !== undefined
                ? !hasPlatforms && isEnrichedRowPending(repoKey, enriched, combinedConfirmed)
                : false;
              return (
                <AppCard
                  key={`uncataloged-${item.repo.id || item.repo.name}-${index}`}
                  app={displayApp}
                  platformPending={enrichedPending}
                  rank={item.rank}
                  className="fluent-list-row"
                  eager={index < 6}
                  trendGain={item.gain}
                  trendGainText={gainTextFor(item.gain)}
                  isInstalled={false}
                  isInstalling={false}
                  isFavorite={false}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={() => {
                    if (item.repo.url) {
                      void tauriApi.openUrl(item.repo.url);
                    }
                  }}
                />
              );
            }

            const gainText = gainTextFor(item.gain);
            const owner = item.repo.owner?.trim();

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
                  aria-label={`#${item.rank}`}
                >
                  #{item.rank}
                </div>
                <div className="app-card-header trend-uncataloged-main">
                  <div className="app-meta" style={{ minWidth: 0 }}>
                    <div className="app-title">
                      <span className="app-name">{item.repo.name}</span>
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
