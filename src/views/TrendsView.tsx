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
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  enrichTrendRepos,
  formatStars,
  isPlaceholderDescription,
  hydrateTrendEnrichCache,
  markTrendConfirmedOthers,
  matchCatalogApp,
  saveBoardCacheMerged,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
  subscribeTrendConfirmedOtherChanges,
  unmarkTrendConfirmedOthers,
  TREND_BOARD_IDS,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
  type TrendBoardId,
  type TrendRepo,
  type TrendsErrorKind,
} from '../services/trends';
import {
  PENDING_SETTLE_MS,
  PLATFORM_IDS,
  isPlatformPending,
  matchPlatformSet,
  matchPlatformSetWithPending,
  resolvePendingPlatformsLite,
  type PlatformId,
} from '../lib/platformFilter';
import { zlogInfo } from '../lib/z-log';
import { isAvatarUrl } from '../components/AppIcon';
import { applyHit, getBufferedIcon } from '../services/iconStore';

/**
 * 趋势榜单一榜一源：调 `fetchTrendsResult(board, { proxyPrefix })`，
 * 排序口径以后端 ranker 为准，前端不再做 fork/star 加权复算；
 * gh-proxy 前缀来自设置库 `active_mirror`（见下），service 内归一化。
 * 远端为空一律走空状态，绝不回退本地加权假榜。
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

  // 未收录行 enrichment 结果（键为小写 owner/repo）：命中即完整 AppCard，
  // 缺席（加载中/失败）即旧小行占位，榜单永不因此变空。
  const [enrichedApps, setEnrichedApps] = useState<Record<string, AppSummary>>(() =>
    snapshotTrendEnrichCache(),
  );
  // 未收录行榜单内已确认 Other（lite 空非 stale 落定 + settle 超时兜底）：
  // App 级 lazyBackfill 只补 apps/recents，此处补 enrichedApps 覆盖不到的缺口；
  // 与全局 platformResolvedOtherIds 取并集判定 pending，详情治愈时同步移除。
  // 现状：初值置空由下 SWR 合并补齐；重启同 key 命中不回 pending；未就绪展裸行不拦榜。
  const [trendConfirmedOtherIds, setTrendConfirmedOtherIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  // 现状：当前 trendResult 的 SWR 合并是否已完成（快照与 hydrate 一致即升级富卡，不拦裸行）。
  const [swrSyncedResult, setSwrSyncedResult] = useState<unknown>(null);
  const trendLiteInflightRef = useRef<Set<string>>(new Set());
  const trendBoardSeqRef = useRef(0);
  // 榜缓存二级新鲜富卡免验集：SWR-fill 时内存快照已有的键（二级新鲜期内直接展，不调 lite）；
  // 后续 enrich 新取回的键不在集内，缺席/过期仍走 lite 补验（到期再验）。
  const swrTrustedRef = useRef<Set<string>>(new Set());
  const enrichedAppsRef = useRef(enrichedApps);
  enrichedAppsRef.current = enrichedApps;
  const trendConfirmedRef = useRef(trendConfirmedOtherIds);
  trendConfirmedRef.current = trendConfirmedOtherIds;
  const platformResolvedOtherIdsRef = useRef(platformResolvedOtherIds);
  platformResolvedOtherIdsRef.current = platformResolvedOtherIds;
  // 富卡写透节流：Map<cacheKey, timer> 800ms debounce，聚合连击为一次落盘；
  // 注：此 boardWriteTimers 为榜写盘 debounce（富卡/enrich 落盘节流），非 sweep timer（切榜顺手 sweep 不加 timer）。
  // 卸载/切榜时由 pagehide flush 刷掉 pending（见下）。
  const boardWriteTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scheduleBoardWriteThrough = (key: string): void => {
    const timers = boardWriteTimersRef.current;
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      timers.delete(key);
      const { cacheKey, cacheBoard, repos } = writeThroughRef.current;
      if (!cacheKey || repos.length === 0) return;
      void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
    }, 800);
    timers.set(key, timer);
  };

  // 全局已确认 ∪ 榜单内已确认：pending 判定的唯一口径（未传入全局集合时不启用）。
  const trendCombinedConfirmed = useMemo(() => {
    const out = new Set<string>();
    if (platformResolvedOtherIds) {
      for (const k of platformResolvedOtherIds) out.add(k);
    }
    for (const k of trendConfirmedOtherIds) out.add(k);
    return out;
  }, [platformResolvedOtherIds, trendConfirmedOtherIds]);

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
        if (withPending) return matchPlatformSetWithPending(item.app, selectedPlatforms, platformResolvedOtherIds);
        return matchPlatformSet(item.app, selectedPlatforms);
      }
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      if (!withPending) {
        if (enriched) return matchPlatformSet(enriched, selectedPlatforms);
        return selectedPlatforms.has('other');
      }
      // pending 语义：未落定恒可见（含裸行）；已确认 Other 后走正常 Other 过滤
      if (!enriched) {
        const confirmed = trendCombinedConfirmed.has(key);
        if (!confirmed) return true;
        return matchPlatformSet({ platforms: [] }, selectedPlatforms);
      }
      if (enriched.platforms && enriched.platforms.length > 0) {
        return matchPlatformSet(enriched, selectedPlatforms);
      }
      // enrich 空：已确认 other 才走正常过滤，否则 pending 恒可见
      const enrichedKey = (enriched.id || '').trim().toLowerCase();
      const confirmed =
        trendCombinedConfirmed.has(key) || (enrichedKey !== '' && trendCombinedConfirmed.has(enrichedKey));
      if (!confirmed) return true;
      return matchPlatformSet(enriched, selectedPlatforms);
    });
  }, [rawDisplayItems, selectedPlatforms, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed]);

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
      if (item.type === 'catalog') return isPlatformPending(item.app, platformResolvedOtherIds);
      // 未收录行：enrich 缺席且未确认即 pending；enrich 空 + 未确认即 pending（不计 Other，防闪）；
      // enrich 空/裸行 + 已确认（全局 ∪ 榜单内）即已落定，按其 platforms 计数；具真实平台即已落定。
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      if (!enriched) return !trendCombinedConfirmed.has(key);
      if (enriched.platforms && enriched.platforms.length > 0) return false;
      const enrichedKey = (enriched.id || '').trim().toLowerCase();
      const confirmed =
        trendCombinedConfirmed.has(key) || (enrichedKey !== '' && trendCombinedConfirmed.has(enrichedKey));
      return !confirmed;
    };
    for (const id of PLATFORM_IDS) {
      const singleton = new Set<string>([id]);
      for (const item of displayItems) {
        if (isPendingItem(item)) continue;
        if (matchPlatformSet({ platforms: platsOf(item) }, singleton)) counts[id] += 1;
      }
    }
    return counts;
  }, [displayItems, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed]);

  useEffect(() => {
    onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  // SWR 旧富卡直展：榜缓存二级富信封命中后 boards 已 hydrate 进内存，
  // 此处同步合并进 enrichedApps 先展旧富卡（含 pending 的 Other 待确认语义），不闪裸行；
  // 后台 enrich effect 再 revalidate 缺席项，找到具平台再覆盖写透；永不用空值覆盖已具平台值。
  // 富/裸以 enriched 存在为准，不用 icon 判定（有/无图标一视同仁）；图标回填只做升级（空不覆盖实）。
  // 可信集分两档：仅具真实平台（platforms.length>0）进可信免验；pending 空平台首屏仍展旧卡，
  // 但后台走 lite 补验（回来 patch 不闪裸）。新鲜度 12h／data: 禁入／小写归一由 snapshot 保证，此处不动。
  // 榜缓存二级落盘
  // 重挂免验直展 Other 卡（零 lite）；具平台升级由 put 自动移除确认，到期由 12h TTL 重验。
  useEffect(() => {
    if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) {
      swrTrustedRef.current = new Set();
      return;
    }
    const snap = snapshotTrendEnrichCache(trendResult.repos);
    swrTrustedRef.current = new Set(
      Object.entries(snap)
        .filter(([, v]) => !!v.platforms && v.platforms.length > 0)
        .map(([k]) => k),
    );
    // 榜缓存二级落盘
    const l2Confirmed = snapshotTrendConfirmedOthers(trendResult.repos);
    if (l2Confirmed.length > 0) {
      setTrendConfirmedOtherIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const k of l2Confirmed) {
          const nk = String(k).trim().toLowerCase();
          if (!nk || next.has(nk)) continue;
          // 已具平台不并入（禁 pending 覆盖具平台，升级后不再视同 Other）
          const cur = snap[nk];
          if (cur?.platforms && cur.platforms.length > 0) continue;
          next.add(nk);
          changed = true;
        }
        return changed ? next : prev;
      });
    }
    setEnrichedApps((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, v] of Object.entries(snap)) {
        const cur = next[k];
        if (!cur) {
          next[k] = v;
          changed = true;
          continue;
        }
        const curHas = !!cur.platforms && cur.platforms.length > 0;
        const incHas = !!v.platforms && v.platforms.length > 0;
        if (!curHas && incHas) {
          next[k] =
            v.icon.trim() === '' && cur.icon.trim() !== '' ? { ...v, icon: cur.icon } : v;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // 现状：SWR 合并完成即记同步（快照与 hydrate 一致即原地升级富卡，不拦裸行）。
    setSwrSyncedResult(trendResult);
  }, [trendResult]);

  // 未收录行 enrichment：逐仓复用搜索 enrichment（Rust 侧并发 5、分片 20/片×2 片=40 上限、单仓 10s），
  // 成功合并为完整卡片；失败/无命中保持旧小行（enrichTrendRepos 缺席即不写，缺席即展裸行/旧缓存，不等齐）。
  // 图标合并走 iconStore。
  // 后台 `icon-ready` 经 `applyHit`
  // patch 富卡（见下订阅 effect）；此处 `enrich` 回填仅做平台逻辑（详情治愈优先、
  // 空 pending 永不覆盖具平台），图标只做升级（空不覆实 + 缓冲补齐），无空覆实回归。
  // 详情已治愈的行不被空回填覆盖（空 pending 永不覆盖具真实平台的已治愈值，单次落定）。
  useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    const missing = new Map<string, TrendRepo>();
    for (const item of displayItems) {
      if (item.type !== 'uncataloged') continue;
      const key = item.repo.id.toLowerCase();
      if (!enrichedApps[key] && !missing.has(key)) missing.set(key, item.repo);
    }
    if (missing.size === 0) return;
    let cancelled = false;
    // 写透时机：enrich 完成即同步 await 写透一次（关闭前 fire-and-forget 易丢，见下卸载 flush）。
    void enrichTrendRepos([...missing.values()]).then(async (found) => {
      if (cancelled || found.size === 0) return;
      let hasNewEnrich = false;
      const concreteKeys: string[] = [];
      setEnrichedApps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, app] of found) {
          const prevApp = next[key] ?? prev[key];
          const incomingEmpty = !app.platforms || app.platforms.length === 0;
          const prevHasPlatforms = !!prevApp?.platforms && prevApp.platforms.length > 0;
          // 详情治愈优先：已具真实平台的行不被空 enrich 回填覆盖，避免治愈后回闪 pending/Other
          if (incomingEmpty && prevHasPlatforms) continue;
          // 图标回填只做升级：入项无图标但旧项有真实图标时保留旧图标（有/无图标一视同仁进富卡）；
          // 竞态补齐。
          // 空壳不覆盖缓冲实图（SHARD 只管平台，图标走 store）。
          let mergedApp = app;
          const prevHasRealIcon =
            !!prevApp &&
            typeof prevApp.icon === 'string' &&
            prevApp.icon.trim() !== '';
          if (app.icon.trim() === '' && prevHasRealIcon) {
            mergedApp = { ...app, icon: (prevApp as AppSummary).icon };
          } else if (app.icon.trim() === '') {
            const buffered = getBufferedIcon(key);
            if (buffered && buffered.trim() !== '') {
              mergedApp = { ...app, icon: buffered };
            }
          }
          if (next[key] !== mergedApp) {
            next[key] = mergedApp;
            changed = true;
            if (!prevHasPlatforms) {
              hasNewEnrich = true;
            }
          }
          if (!incomingEmpty) concreteKeys.push(key);
        }
        return changed ? next : prev;
      });
      // 具平台到达可覆盖升级：enrich 具平台即移出已确认（本地 + 内存标记，put 侧已自动移除同键）；
      // 空 pending 永不覆盖已具平台（上分支已跳过），此处只做确认移除。
      if (concreteKeys.length > 0) {
        unmarkTrendConfirmedOthers(concreteKeys);
        setTrendConfirmedOtherIds((prev) => {
          let hit = false;
          for (const k of concreteKeys) {
            if (prev.has(k)) {
              hit = true;
              break;
            }
          }
          if (!hit) return prev;
          const next = new Set(prev);
          for (const k of concreteKeys) next.delete(k);
          return next;
        });
      }
      // enrich 落定后写透同榜 key（await 落稳再返回，刷新 cached_at 即刷新 12h 窗口）：
      // SWR 富信封含 pending 直展，具平台与 pending 新项均可写透升级榜缓存二级；
      // P1-C3 读写同源：写透 key 与 boards 读路径同源（同 board + 同 trendFetchOpts），
      // 杜绝丢 opts 导致读写分叉；已确认 Other 经确认集同 key 写透（见 lite/settle），
      // 此处 saveBoardCacheMerged 自动携带内存确认快照（具平台键已剔除）。
      if (hasNewEnrich && trendResult.repos.length > 0) {
        const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
        const cacheKey = isDoforceBoard
          ? buildDoforceCacheKey(trendFetchOpts)
          : buildTrendsCacheKey(activeBoard, trendFetchOpts);
        const cacheBoard = isDoforceBoard ? 'doforce' : activeBoard;
        await saveBoardCacheMerged(cacheKey, cacheBoard, trendResult.repos);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [trendResult, displayItems, enrichedApps, activeBoard, trendFetchOpts]);

  // 卸载前再刷一次：关闭/切走时 enrich 可能刚落定，同步 flush 当前榜快照兜底（有富条目才写，防裸覆盖）。
  const writeThroughRef = useRef({
    cacheKey: '',
    cacheBoard: '' as TrendBoardId | 'doforce',
    repos: [] as TrendRepo[],
  });
  if (trendResult?.status === 'ok' && trendResult.repos.length > 0) {
    const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
    writeThroughRef.current = {
      cacheKey: isDoforceBoard
        ? buildDoforceCacheKey(trendFetchOpts)
        : buildTrendsCacheKey(activeBoard, trendFetchOpts),
      cacheBoard: isDoforceBoard ? 'doforce' : activeBoard,
      repos: trendResult.repos,
    };
  }
  useEffect(() => {
    const flush = (): void => {
      // 先刷掉富卡节流 pending（清定时器后立即落盘一次，避免关闭丢失）
      for (const timer of boardWriteTimersRef.current.values()) clearTimeout(timer);
      boardWriteTimersRef.current.clear();
      const { cacheKey, cacheBoard, repos } = writeThroughRef.current;
      if (!cacheKey || repos.length === 0) return;
      if (Object.keys(snapshotTrendEnrichCache(repos)).length === 0) return;
      void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // 已确认变更写透联动：mark/unmark（lite 确认、settle 兜底、详情治愈、具平台升级）触发后，
  // 节流写透同榜 key（含确认集，重挂免验）；读路径 hydrate/sweep 不触发，无读放大。
  useEffect(() => {
    return subscribeTrendConfirmedOtherChanges(() => {
      const { cacheKey } = writeThroughRef.current;
      if (!cacheKey) return;
      scheduleBoardWriteThrough(cacheKey);
    });
  }, []);

  // 趋势流式图标订阅。
  // 后台 `icon-ready` 经 `applyHit` 接上 `board` 门控逐个补齐富卡图标。
  // 此处只 patch 图标（空不覆实/`level`纯L单调/avatar 丢弃均由店内保证），
  // 平台逻辑不动；`data:`/`via=m2`只进M1内存不落盘（hydrate 内跳过），`remote`才
  // hydrate + 节流写透榜缓存二级。
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
        // 图标落盘：已 patch 条目 hydrate 快照 + 节流写透同榜 key（`data:` 禁入由 hydrate 保证）。
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
          hydrateTrendEnrichCache(toHydrate);
          const { cacheKey } = writeThroughRef.current;
          if (!cacheKey) return;
          scheduleBoardWriteThrough(cacheKey);
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

  // 详情治愈即时补齐：App 侧详情成功带回真实平台后派发事件，
  // 此处将摘要 upsert 进 enrichedApps，未收录行一次落定为 OS 图标（无需等下次 enrich）。
  // 空 enrich pending 行被具平台值替换；已具平台的行保持不动（单次更新）。
  // 与当前榜单无关的治愈经“已知仓 + 已有条目”双重过滤后自然无变化，避免无界膨胀。
  // 治愈键同步移出榜单内已确认集合（落定为 OS，不再视同 Other）。
  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<DetailPlatformsHealPayload>).detail;
      if (!payload || !Array.isArray(payload.platforms) || payload.platforms.length === 0) return;
      if (!payload.summary || !Array.isArray(payload.keys) || payload.keys.length === 0) return;
      const keys = payload.keys.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0);
      if (keys.length === 0) return;
      const keySet = new Set(keys);
      const repoKeys = new Set<string>();
      for (const r of trendResult?.repos ?? []) {
        if (r.id) repoKeys.add(r.id.trim().toLowerCase());
        if (r.owner && r.repo) repoKeys.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
      }
      setEnrichedApps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(prev)) {
          if (keySet.has(k.toLowerCase())) {
            const cur = prev[k];
            if (!cur.platforms || cur.platforms.length === 0) {
              // 图标回填只做升级：治愈摘要无图标但旧 pending 有真实图标时保留旧图标
              const keepIcon =
                payload.summary.icon.trim() === '' && cur.icon.trim() !== '';
              next[k] = {
                ...payload.summary,
                platforms: [...payload.platforms],
                ...(keepIcon ? { icon: cur.icon } : null),
              };
              changed = true;
            } else {
              // 图标升级（不觸平台逻辑）：已具平台的行仅跟随详情实际展示图标，
              // incoming 非空非 avatar 且与旧不同即覆盖，空不覆盖实。
              const incomingIcon =
                typeof payload.summary.icon === 'string' ? payload.summary.icon.trim() : '';
              if (incomingIcon !== '' && !isAvatarUrl(incomingIcon) && cur.icon !== incomingIcon) {
                const incomingBg =
                  typeof payload.summary.icon_bg === 'string' ? payload.summary.icon_bg : '';
                next[k] = {
                  ...cur,
                  icon: incomingIcon,
                  ...(incomingBg.trim() !== '' ? { icon_bg: payload.summary.icon_bg } : null),
                };
                changed = true;
              }
            }
          }
        }
        // 预 enrich 治愈：榜单已知但 enrich 尚未落定的行直接创建条目，行内即时 heals
        for (const k of keys) {
          if (!next[k] && repoKeys.has(k)) {
            next[k] = { ...payload.summary, platforms: [...payload.platforms] };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setTrendConfirmedOtherIds((prev) => {
        let hit = false;
        for (const k of keys) {
          if (prev.has(k)) {
            hit = true;
            break;
          }
        }
        if (!hit) return prev;
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
      // 具平台升级同步清内存确认标记（App 侧 upsert 已清同键，此处补清别名，防确认残留致 Other 误展）。
      unmarkTrendConfirmedOthers(keys);
    };
    window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, handler);
    return () => {
      window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, handler);
    };
  }, [trendResult]);

  // 图标单通道内存同步：详情实际展示图标（iconCycle 解析）经 `zstore:icon-changed`
  // 即时跟随外侧趋势榜同一应用。incoming 非 avatar 且与旧不同即覆盖，
  // 允许 `data:` 进内存态做即时展示（AppIcon 即时解码）。
  // L5（rawIcon ''）放行内存清零（icon 置 ''、icon_bg 保留），只走徽章分支，空不进盘；
  // 大小写归一，同时匹配坐标键与 `enriched.id` 小写别名。
  // 重启可恢复：rawIcon 为可持久化 URL（非 data:）时，对本次命中条目 hydrate 快照
  // 榜缓存二级落盘
  // （data: 永不进盘由 hydrate/snapshot 四道 continue 保证，此处亦主动跳过）。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ appId: string; icon: string }>).detail;
      if (!detail) return;
      const rawIcon = typeof detail.icon === 'string' ? detail.icon.trim() : '';
      const appIdNorm = String(detail.appId ?? '').trim().toLowerCase();
      if (!appIdNorm || isAvatarUrl(rawIcon)) return;
      setEnrichedApps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(prev)) {
          const cur = prev[k];
          const alias = String(cur?.id ?? '').trim().toLowerCase();
          if (k.toLowerCase() === appIdNorm || (alias !== '' && alias === appIdNorm)) {
            if (cur.icon !== rawIcon) {
              next[k] = { ...cur, icon: rawIcon };
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      // L5 清零只做内存（icon 已置 ''，徽章分支直显），空不进盘：跳过 hydrate/写透
      if (rawIcon === '') return;
      // 榜缓存二级落盘
      if (rawIcon.startsWith('data:')) return;
      try {
        const latest = enrichedAppsRef.current;
        const toHydrate: Record<string, AppSummary> = {};
        for (const k of Object.keys(latest)) {
          const cur = latest[k];
          if (!cur) continue;
          const alias = String(cur.id ?? '').trim().toLowerCase();
          if (k.toLowerCase() === appIdNorm || (alias !== '' && alias === appIdNorm)) {
            if (cur.icon !== rawIcon) {
              toHydrate[k] = { ...cur, icon: rawIcon };
            }
          }
        }
        if (Object.keys(toHydrate).length === 0) return;
        hydrateTrendEnrichCache(toHydrate);
        const { cacheKey, cacheBoard, repos } = writeThroughRef.current;
        if (!cacheKey || repos.length === 0) return;
        void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
      } catch {
        // 落盘失败不影响内存即时展示
      }
    };
    window.addEventListener('zstore:icon-changed', handler);
    return () => {
      window.removeEventListener('zstore:icon-changed', handler);
    };
  }, []);

  // 富卡全字段治愈：App 侧详情 diff→upsert 后派发，此处字段级 merge 进 enrichedApps。
  // - platforms 沿旧：仅旧空且 incoming 非空才补，空永不覆盖实（不觸平台确认/settle 逻辑）；
  // - icon/icon_bg 不动（归 icon 通道）；
  // - 其余 dirty 字段直接覆盖；dirty 为空跳写盘；
  // - 跨榜过滤：仅处理仍属本榜的行（repoKeys），无关治愈自然无变化；
  // - 落盘：hydrate 后包一层 scheduleBoardWriteThrough 节流写透（data: 禁入由 hydrate 保证）。
  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<DetailRichcardHealPayload>).detail;
      if (!payload || !payload.summary || typeof payload.summary !== 'object') return;
      if (!Array.isArray(payload.keys) || payload.keys.length === 0) return;
      if (!Array.isArray(payload.dirtyFields) || payload.dirtyFields.length === 0) return;
      const keys = payload.keys.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0);
      if (keys.length === 0) return;
      const keySet = new Set(keys);
      const dirtySet = new Set(payload.dirtyFields.filter((f) => typeof f === 'string'));
      dirtySet.delete('icon');
      dirtySet.delete('icon_bg');
      dirtySet.delete('platforms');
      if (dirtySet.size === 0 && (!payload.platforms || payload.platforms.length === 0)) return;
      const repoKeys = new Set<string>();
      for (const r of trendResult?.repos ?? []) {
        if (r.id) repoKeys.add(r.id.trim().toLowerCase());
        if (r.owner && r.repo) repoKeys.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
      }
      const hitKeys = keys.filter((k) => repoKeys.has(k));
      if (hitKeys.length === 0) {
        // 非本榜治愈：已有条目经别名命中亦可跟随（防 id/坐标不一致漏治愈），否则直接返回
        let aliasHit = false;
        for (const k of Object.keys(enrichedAppsRef.current)) {
          if (!keySet.has(k.toLowerCase())) continue;
          aliasHit = true;
          break;
        }
        if (!aliasHit) return;
      }
      setEnrichedApps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(prev)) {
          const cur = prev[k];
          const alias = String(cur?.id ?? '').trim().toLowerCase();
          if (!keySet.has(k.toLowerCase()) && (alias === '' || !keySet.has(alias))) continue;
          // 跨榜过滤：坐标键与别名均非本榜行则跳过
          if (!repoKeys.has(k.toLowerCase()) && (alias === '' || !repoKeys.has(alias))) continue;
          const patched: AppSummary = { ...cur };
          let rowChanged = false;
          // platforms 沿旧：仅旧空且 incoming 非空才补
          if ((!patched.platforms || patched.platforms.length === 0) && payload.platforms && payload.platforms.length > 0) {
            patched.platforms = [...payload.platforms];
            rowChanged = true;
          }
          for (const f of dirtySet) {
            const incoming = (payload.summary as unknown as Record<string, unknown>)[f];
            if (incoming === undefined) continue;
            // 占位简介兜底：即使 dirty 误带占位也不覆盖实值（展示兜底只留渲染侧）
            if (
              (f === 'description' || f === 'description_en') &&
              typeof incoming === 'string' &&
              isPlaceholderDescription(incoming)
            ) {
              continue;
            }
            if ((patched as unknown as Record<string, unknown>)[f] !== incoming) {
              (patched as unknown as Record<string, unknown>)[f] = incoming as unknown;
              rowChanged = true;
            }
          }
          if (rowChanged) {
            next[k] = patched;
            changed = true;
          }
        }
        // 预 enrich 富卡：榜单已知但 enrich 尚未落定的行直接创建条目（icon 归 icon 通道，此处不带 icon；占位简介剥离）
        for (const k of hitKeys) {
          if (!next[k]) {
            const { icon: _dropIcon, icon_bg: _dropBg, platforms: _dropPlats, ...rest } = payload.summary as unknown as AppSummary & Record<string, unknown>;
            void _dropIcon;
            void _dropBg;
            void _dropPlats;
            const restSummary = rest as unknown as AppSummary;
            next[k] = {
              ...restSummary,
              description:
                typeof restSummary.description === 'string' && isPlaceholderDescription(restSummary.description)
                  ? ''
                  : restSummary.description,
              description_en:
                typeof restSummary.description_en === 'string' && isPlaceholderDescription(restSummary.description_en)
                  ? ''
                  : restSummary.description_en,
              icon: '',
              icon_bg: 'linear-gradient(135deg, #475569, #334155)',
              platforms: payload.platforms && payload.platforms.length > 0 ? [...payload.platforms] : [],
            };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // 榜缓存二级落盘
      try {
        const latest = enrichedAppsRef.current;
        const toHydrate: Record<string, AppSummary> = {};
        for (const k of Object.keys(latest)) {
          const cur = latest[k];
          if (!cur) continue;
          const alias = String(cur.id ?? '').trim().toLowerCase();
          if (!keySet.has(k.toLowerCase()) && (alias === '' || !keySet.has(alias))) continue;
          if (!repoKeys.has(k.toLowerCase()) && (alias === '' || !repoKeys.has(alias))) continue;
          toHydrate[k] = cur;
        }
        // 刚创建的行（hydrate 时 ref 尚未更新）一并带上（占位简介剥离，不进盘）
        for (const k of hitKeys) {
          if (!toHydrate[k]) {
            const created = { ...payload.summary, platforms: payload.platforms && payload.platforms.length > 0 ? [...payload.platforms] : [] } as AppSummary;
            if (typeof created.icon === 'string' && created.icon.startsWith('data:')) continue;
            if (typeof created.description === 'string' && isPlaceholderDescription(created.description)) {
              created.description = '';
            }
            if (typeof created.description_en === 'string' && isPlaceholderDescription(created.description_en)) {
              created.description_en = '';
            }
            toHydrate[k] = created;
          }
        }
        if (Object.keys(toHydrate).length === 0) return;
        hydrateTrendEnrichCache(toHydrate);
        const { cacheKey } = writeThroughRef.current;
        if (!cacheKey) return;
        scheduleBoardWriteThrough(cacheKey);
      } catch {
        // 落盘失败不影响内存 merge
      }
    };
    window.addEventListener(DETAIL_RICHCARD_HEAL_EVENT, handler);
    return () => {
      window.removeEventListener(DETAIL_RICHCARD_HEAL_EVENT, handler);
    };
  }, [trendResult]);

  // 榜单切换即递增 lite 序列：旧榜在途 lite 落定不再写入，避免跨榜串扰。
  useEffect(() => {
    trendBoardSeqRef.current += 1;
  }, [activeBoard, trendResult]);

  // 未收录行 lite 确认（App lazyBackfill 的榜单侧补齐，经共享 helper 分批 5/上限 20/seq 守卫）：
  // enrich 落定为空（fallback []）的行按 App 同口径走 getPlatformsLite 轻量通道：
  // 非空非 stale 即 patch enrichedApps 治愈并同步 merge 内存快照 + await 写透榜缓存二级；
  // 空非 stale 即记入榜单内已确认 Other 并与 enrich 同 key 写透榜缓存二级，重挂免验直展 Other 卡，零 lite）；
  // stale/失败保持 pending 交给 settle 超时（不覆盖具平台）。enrich 合并与此处 patch 均永不以后续空值覆盖已治愈的真实平台。
  // 可信分三档：具真实平台（platforms.length>0）＋ 已确认 Other（榜缓存二级确认集新鲜）＋榜缓存二级新鲜
  // 即免验直接展；pending 空平台首屏先展旧卡，后台仍走 lite 补验，回来 patch 不闪裸（只 patch、不删卡）。
  // 只有 enrich 缺席（裸行交 enrich effect）、用户点详情/刷新才走其他通道。详情页 get_platforms_lite
  // 30m TTL/ETag 保持原样，趋势页不再每次直调（确认的 Other 随富卡存 12h，到期再验）。
  useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    if (platformResolvedOtherIds === undefined) return;
    const seq = trendBoardSeqRef.current;
    const inflight = trendLiteInflightRef.current;
    const trusted = swrTrustedRef.current;
    let freshSnap: Record<string, AppSummary> | null = null;
    // 两档中的具平台档：pending 空平台直接 false（永不免验，后台必补验）。
    const isFreshConcreteTrusted = (k: string): boolean => {
      if (!trusted.has(k)) return false;
      if (!freshSnap) {
        const boardRepos: TrendRepo[] = [];
        for (const item of rawDisplayItems) {
          if (item.type !== 'uncataloged') continue;
          boardRepos.push(item.repo);
        }
        freshSnap = snapshotTrendEnrichCache(boardRepos);
      }
      const hit = freshSnap[k];
      // 具平台才免验；pending 空平台永不免验（首屏展旧卡，后台补验）。
      if (!hit?.platforms || hit.platforms.length === 0) return false;
      return true;
    };
    const targets: Array<{ key: string; liteId: string }> = [];
    for (const item of rawDisplayItems) {
      if (item.type !== 'uncataloged') continue;
      const key = (item.repo.id || '').trim().toLowerCase();
      if (!key) continue;
      const enriched = enrichedApps[key];
      // 仅 enrich 已落定为空的行走 lite（裸行交由 settle 兜底，避免无摘要可 patch 却占通道）；
      // 已具真实平台 / 已确认 / 在途一律跳过。
      if (!enriched) continue;
      if (enriched.platforms && enriched.platforms.length > 0) continue;
      const enrichedKey = (enriched.id || '').trim().toLowerCase();
      if (trendCombinedConfirmed.has(key) || (enrichedKey !== '' && trendCombinedConfirmed.has(enrichedKey))) {
        continue;
      }
      if (inflight.has(key)) continue;
      // 两档：具平台已在上分支跳过（永不走 lite，防 patch 循环；stale 具平台交 enrich 重拉）；
      // 此处仅剩 pending，永不免验——首屏展旧卡，后台必补验（键及 id 别名双查，防 id 与坐标不一致漏验/误验）。
      if (isFreshConcreteTrusted(key) || (enrichedKey !== '' && isFreshConcreteTrusted(enrichedKey))) continue;
      const liteId = (enriched.id || '').trim() || (item.repo.id || '').trim();
      if (!liteId) continue;
      targets.push({ key, liteId });
      if (targets.length >= 20) break;
    }
    // 免验取证单行日志：每次决策记录 board/可信 concrete/pending/跳过/目标数，便于无 DevTools 取证；只读计数，不改分支逻辑。
    const trustedConcrete = trusted.size;
    let trustedPending = 0;
    let uncatalogedTotal = 0;
    for (const item of rawDisplayItems) {
      if (item.type !== 'uncataloged') continue;
      const k = (item.repo.id || '').trim().toLowerCase();
      if (!k) continue;
      uncatalogedTotal += 1;
      const en = enrichedApps[k];
      if (!en) continue;
      if (en.platforms && en.platforms.length > 0) continue;
      const enKey = (en.id || '').trim().toLowerCase();
      if (trendCombinedConfirmed.has(k) || (enKey !== '' && trendCombinedConfirmed.has(enKey))) continue;
      trustedPending += 1;
    }
    const skipped = uncatalogedTotal - targets.length;
    zlogInfo(
      `[trends] lite-skip board=${activeBoard} trustedConcrete=${trustedConcrete} trustedPending=${trustedPending} skipped=${skipped} targets=${targets.length}`,
    );
    if (targets.length === 0) return;
    for (const t of targets) inflight.add(t.key);
    void (async () => {
      try {
        const { patched, confirmedEmpty } = await resolvePendingPlatformsLite(
          targets,
          (liteId) => tauriApi.getPlatformsLite(liteId),
          () => seq !== trendBoardSeqRef.current,
        );
        if (seq !== trendBoardSeqRef.current) return;
        if (patched.size > 0) {
          // 具平台升级先清确认（本地 + 内存标记，防确认残留；hydrate 具平台侧亦会自动移除同键）。
          {
            const aliasKeys: string[] = [];
            const latestForAlias = enrichedAppsRef.current;
            for (const k of patched.keys()) {
              const nk = String(k).trim().toLowerCase();
              if (!nk) continue;
              aliasKeys.push(nk);
              const curAlias = (latestForAlias[nk]?.id || '').trim().toLowerCase();
              if (curAlias !== '' && curAlias !== nk) aliasKeys.push(curAlias);
            }
            if (aliasKeys.length > 0) unmarkTrendConfirmedOthers(aliasKeys);
          }
          setEnrichedApps((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const [k, plats] of patched) {
              const cur = next[k] ?? prev[k];
              if (!cur) continue;
              if (cur.platforms && cur.platforms.length > 0) continue;
              next[k] = { ...cur, platforms: [...plats] };
              changed = true;
            }
            return changed ? next : prev;
          });
          setTrendConfirmedOtherIds((prev) => {
            let hit = false;
            for (const k of patched.keys()) {
              if (prev.has(k)) {
                hit = true;
                break;
              }
            }
            if (!hit) return prev;
            const next = new Set(prev);
            for (const k of patched.keys()) next.delete(k);
            return next;
          });
          // 榜缓存二级落盘
          // 下次重挂直展具平台（零 lite）。stale/失败不进 patched，保持 pending 等 15s 兜底；
          // data: 禁入、key 小写归一由 hydrate/合并写盘保证，此处不改表结构。
          try {
            const toHydrate: Record<string, AppSummary> = {};
            const latest = enrichedAppsRef.current;
            for (const [k, plats] of patched) {
              const normKey = String(k).trim().toLowerCase();
              if (!normKey) continue;
              const cur = latest[normKey];
              if (!cur) continue;
              if (cur.platforms && cur.platforms.length > 0) continue;
              const icon =
                typeof cur.icon === 'string' && cur.icon.startsWith('data:') ? '' : cur.icon;
              toHydrate[normKey] = { ...cur, icon, platforms: [...plats] };
            }
            if (Object.keys(toHydrate).length > 0) {
              hydrateTrendEnrichCache(toHydrate);
              if (trendResult.repos.length > 0) {
                const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
                const cacheKey = isDoforceBoard
                  ? buildDoforceCacheKey(trendFetchOpts)
                  : buildTrendsCacheKey(activeBoard, trendFetchOpts);
                const cacheBoard = isDoforceBoard ? 'doforce' : activeBoard;
                await saveBoardCacheMerged(cacheKey, cacheBoard, trendResult.repos);
              }
            }
          } catch {
            // 写透失败不影响内存落定，pending 语义不变
          }
        }
        if (confirmedEmpty.length > 0) {
          // 空非 stale 即已确认 Other：本地 + 内存标记 + 与 enrich 同 key 写透榜缓存二级，
          // 重挂免验直展 Other 卡；具平台到达可覆盖升级（上分支已清），12h 到期重验。
          const aliasConfirmed: string[] = [];
          {
            const latest = enrichedAppsRef.current;
            for (const raw of confirmedEmpty) {
              const k = String(raw).trim().toLowerCase();
              if (!k) continue;
              const cur = latest[k];
              // 竞态：lite 回来前已被治愈为具平台则跳过（禁 pending 覆盖具平台）
              if (cur?.platforms && cur.platforms.length > 0) continue;
              aliasConfirmed.push(k);
              const alias = ((cur?.id || '') as string).trim().toLowerCase();
              if (alias !== '' && alias !== k) {
                const aliasCur = latest[alias];
                if (!(aliasCur?.platforms && aliasCur.platforms.length > 0)) {
                  aliasConfirmed.push(alias);
                }
              }
            }
          }
          if (aliasConfirmed.length > 0) {
            markTrendConfirmedOthers(aliasConfirmed);
            // 已确认摘要进内存：先 mark 后 hydrate（已确认 pending 方可进内存，随榜缓存同 key 落盘）；
            // data: 剥空后 hydrate（仍禁 data: 入盘），具平台不合成。
            try {
              const toHydrate: Record<string, AppSummary> = {};
              const latest = enrichedAppsRef.current;
              for (const k of aliasConfirmed) {
                const cur = latest[k];
                if (!cur) continue;
                if (cur.platforms && cur.platforms.length > 0) continue;
                toHydrate[k] =
                  typeof cur.icon === 'string' && cur.icon.startsWith('data:')
                    ? { ...cur, icon: '' }
                    : cur;
              }
              if (Object.keys(toHydrate).length > 0) {
                hydrateTrendEnrichCache(toHydrate);
              }
            } catch {
              // 剥离失败不影响确认标记
            }
          }
          setTrendConfirmedOtherIds((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const k of aliasConfirmed) {
              if (!next.has(k)) {
                next.add(k);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          // 榜缓存二级落盘
          if (aliasConfirmed.length > 0 && trendResult.repos.length > 0) {
            try {
              const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
              const cacheKey = isDoforceBoard
                ? buildDoforceCacheKey(trendFetchOpts)
                : buildTrendsCacheKey(activeBoard, trendFetchOpts);
              const cacheBoard = isDoforceBoard ? 'doforce' : activeBoard;
              await saveBoardCacheMerged(cacheKey, cacheBoard, trendResult.repos);
            } catch {
              // 写透失败不影响内存落定
            }
          }
          // 兼容旧变量名：已用 aliasConfirmed（含别名）落定，confirmedEmpty 仅作输入
          void confirmedEmpty;
        }
      } finally {
        for (const t of targets) inflight.delete(t.key);
      }
    })();
  }, [trendResult, rawDisplayItems, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed, activeBoard, trendFetchOpts]);

  // pending settle 超时：enrich 空 + 一次 lite 仍未治愈（或 lite stale/失败/裸行）
  // 至多等待 TREND_PENDING_SETTLE_MS 后降级为已确认 Other（徽标 + 计数 + 可过滤），
  // 而非无限 shimmer。超时前仍恒可见（不看 Other 勾选），落定后走正常 Other 过滤。
  // 治愈（具真实平台）的行永不被 settle 确认；定时器随榜单/回填变化重置，落稳后一次触发。
  // 已确认 Other 与 enrich 同 key 写透榜缓存二级：裸行合成最小摘要 hydrate，空 enrich 剥 data: 后 hydrate，
  // 重挂免验直展 Other 卡；具平台到达可覆盖升级，12h 到期重验；pending 永不覆盖具平台。
  useEffect(() => {
    if (platformResolvedOtherIds === undefined) return;
    if (trendResult?.status !== 'ok') return;
    const pendingSnapshot: string[] = [];
    // 兜底合成用仓库快照（裸行无摘要时按此合成最小 AppSummary 落盘，同 enrich 键）。
    const repoByKey = new Map<string, TrendRepo>();
    for (const item of rawDisplayItems) {
      if (item.type !== 'uncataloged') continue;
      const key = (item.repo.id || '').trim().toLowerCase();
      if (!key) continue;
      if (!repoByKey.has(key)) repoByKey.set(key, item.repo);
      const enriched = enrichedApps[key];
      if (enriched?.platforms && enriched.platforms.length > 0) continue;
      const enrichedKey = ((enriched?.id || '') as string).trim().toLowerCase();
      if (trendCombinedConfirmed.has(key) || (enrichedKey !== '' && trendCombinedConfirmed.has(enrichedKey))) {
        continue;
      }
      pendingSnapshot.push(key);
    }
    if (pendingSnapshot.length === 0) return;
    const timer = setTimeout(() => {
      const stillPending: string[] = [];
      for (const key of pendingSnapshot) {
        const cur = enrichedAppsRef.current[key];
        if (cur?.platforms && cur.platforms.length > 0) continue;
        const curKey = ((cur?.id || '') as string).trim().toLowerCase();
        const global = platformResolvedOtherIdsRef.current;
        const local = trendConfirmedRef.current;
        if (global?.has(key) || local.has(key)) continue;
        if (curKey !== '' && (global?.has(curKey) || local.has(curKey))) continue;
        stillPending.push(key);
      }
      if (stillPending.length === 0) return;
      // 同 key hydrate：空 enrich 剥 data:，裸行合成最小 Other 摘要（data 仍禁，具平台不合成）。
      const toHydrate: Record<string, AppSummary> = {};
      const aliasKeys: string[] = [];
      for (const key of stillPending) {
        const cur = enrichedAppsRef.current[key];
        if (cur?.platforms && cur.platforms.length > 0) continue;
        if (cur) {
          const curKey = ((cur.id || '') as string).trim().toLowerCase();
          aliasKeys.push(key);
          if (curKey !== '' && curKey !== key) aliasKeys.push(curKey);
          if (typeof cur.icon === 'string' && cur.icon.startsWith('data:')) {
            toHydrate[key] = { ...cur, icon: '' };
          } else if (!toHydrate[key]) {
            // 空 enrich 已在内存，仍需保证快照可收录：无 data: 即直接复用（hydrate 刷新 12h 窗口）。
            toHydrate[key] = cur;
          }
          continue;
        }
        const repo = repoByKey.get(key) ?? trendResult.repos.find((r) => (r.id || '').trim().toLowerCase() === key);
        if (!repo) continue;
        if (!repo.id || !repo.owner || !repo.repo) continue;
        aliasKeys.push(key);
        const shortName = (repo.repo || repo.name || repo.id).trim() || repo.id;
        toHydrate[key] = {
          id: repo.id,
          name: shortName,
          owner: repo.owner,
          repo: repo.repo,
          icon: '',
          icon_bg: 'linear-gradient(135deg, #475569, #334155)',
          description: repo.description ?? '',
          stars: typeof repo.stars === 'number' ? repo.stars : 0,
          forks: typeof repo.forks === 'number' ? repo.forks : 0,
          license: '',
          latest_version: 'latest',
          category: repo.category ?? 'dev',
          category_name: '',
          is_verified: false,
          forge: 'github',
          forge_host: 'github.com',
          homepage: null,
          platforms: [],
        };
      }
      if (aliasKeys.length === 0) return;
      try {
        // 先 mark 再 hydrate：已确认 pending 方可进内存（未确认 pending 永不进内存/落库）。
        markTrendConfirmedOthers(aliasKeys);
        if (Object.keys(toHydrate).length > 0) {
          hydrateTrendEnrichCache(toHydrate);
        }
      } catch {
        // 标记失败仍尝试本地落定
      }
      setTrendConfirmedOtherIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const k of aliasKeys) {
          const nk = String(k).trim().toLowerCase();
          if (!nk || next.has(nk)) continue;
          next.add(nk);
          changed = true;
        }
        return changed ? next : prev;
      });
      // 本地直展裸合成卡：enrichedApps 缺席的键一次并入（具平台不覆盖，已有不重写）。
      if (Object.keys(toHydrate).length > 0) {
        setEnrichedApps((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [k, v] of Object.entries(toHydrate)) {
            if (next[k]) continue;
            next[k] = v;
            changed = true;
          }
          return changed ? next : prev;
        });
      }
      // 确认写透：同榜 key saveBoardCacheMerged 落盘（含确认集），重挂零 lite 直展 Other 卡。
      if (trendResult.repos.length > 0) {
        try {
          const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
          const cacheKey = isDoforceBoard
            ? buildDoforceCacheKey(trendFetchOpts)
            : buildTrendsCacheKey(activeBoard, trendFetchOpts);
          const cacheBoard = isDoforceBoard ? 'doforce' : activeBoard;
          void saveBoardCacheMerged(cacheKey, cacheBoard, trendResult.repos);
        } catch {
          // 写透失败不影响内存落定
        }
      }
    }, TREND_PENDING_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [trendResult, rawDisplayItems, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed, activeBoard, trendFetchOpts]);

  const gainTextFor = (gain?: number): string | undefined => {
    if (!gain || gain <= 0) return undefined;
    const count = formatStars(gain);
    if (gainKey === 'today') return t('trends.stars_gained_today', { count });
    if (gainKey === 'month') return t('trends.stars_gained_month', { count });
    return t('trends.stars_gained_week', { count });
  };

  // 现状：未就绪不再拦整榜，board repos 直接展裸行（与下裸行同形），富卡到即原地升级。
  // 门信号仅用于升级判定，不阻塞裸行直展。
  const isUpgradePending =
    !boardReady ||
    (trendResult?.status === 'ok' &&
      trendResult.repos.length > 0 &&
      swrSyncedResult !== trendResult);
  void isUpgradePending;

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
              const catalogPending = platformResolvedOtherIds !== undefined
                ? isPlatformPending(item.app, platformResolvedOtherIds)
                : false;
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
              const enrichedKey = (enriched.id || '').trim().toLowerCase();
              const repoKey = item.repo.id.toLowerCase();
              const enrichedConfirmed = hasPlatforms
                ? true
                : platformResolvedOtherIds === undefined
                  ? true
                  : trendCombinedConfirmed.has(repoKey) ||
                    (enrichedKey !== '' && trendCombinedConfirmed.has(enrichedKey));
              const enrichedPending = !hasPlatforms && !enrichedConfirmed;
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
