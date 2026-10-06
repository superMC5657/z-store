import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { TrendingUp, WifiOff } from 'lucide-react';
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
  enrichTrendRepos,
  formatStars,
  matchCatalogApp,
  saveDbTrendCache,
  snapshotTrendEnrichCache,
  TREND_BOARD_IDS,
  type DetailPlatformsHealPayload,
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
    errorKind,
    handleRetry,
  } = useTrendBoard('weekly');

  // 未收录行 enrichment 结果（键为小写 owner/repo）：命中即完整 AppCard，
  // 缺席（加载中/失败）即旧小行占位，榜单永不因此变空。
  const [enrichedApps, setEnrichedApps] = useState<Record<string, AppSummary>>(() =>
    snapshotTrendEnrichCache(),
  );
  // 未收录行榜单内已确认 Other（lite 空非 stale 落定 + settle 超时兜底）：
  // App 级 lazyBackfill 只补 apps/recents，此处补 enrichedApps 覆盖不到的缺口；
  // 与全局 platformResolvedOtherIds 取并集判定 pending，详情治愈时同步移除。
  const [trendConfirmedOtherIds, setTrendConfirmedOtherIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const trendLiteInflightRef = useRef<Set<string>>(new Set());
  const trendBoardSeqRef = useRef(0);
  const enrichedAppsRef = useRef(enrichedApps);
  enrichedAppsRef.current = enrichedApps;
  const trendConfirmedRef = useRef(trendConfirmedOtherIds);
  trendConfirmedRef.current = trendConfirmedOtherIds;
  const platformResolvedOtherIdsRef = useRef(platformResolvedOtherIds);
  platformResolvedOtherIdsRef.current = platformResolvedOtherIds;

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

  // 未收录行 enrichment：逐仓复用搜索 enrichment（Rust 侧并发 5、上限 20、单仓 10s），
  // 成功合并为完整卡片；失败/无命中保持旧小行（enrichTrendRepos 缺席即不写）。
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
    void enrichTrendRepos([...missing.values()]).then((found) => {
      if (cancelled || found.size === 0) return;
      let hasNewWithPlatforms = false;
      setEnrichedApps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, app] of found) {
          const prevApp = next[key] ?? prev[key];
          const incomingEmpty = !app.platforms || app.platforms.length === 0;
          const prevHasPlatforms = !!prevApp?.platforms && prevApp.platforms.length > 0;
          // 详情治愈优先：已具真实平台的行不被空 enrich 回填覆盖，避免治愈后回闪 pending/Other
          if (incomingEmpty && prevHasPlatforms) continue;
          if (next[key] !== app) {
            next[key] = app;
            changed = true;
            if (!incomingEmpty && !prevHasPlatforms) {
              hasNewWithPlatforms = true;
            }
          }
        }
        return changed ? next : prev;
      });
      // enrich useEffect落定后若有新增具平台条目则saveDbTrendCache重存同榜key（fire-and-forget，刷新cached_at即刷新12h窗口）
      if (hasNewWithPlatforms && trendResult.repos.length > 0) {
        const isDoforceBoard = activeBoard === 'rising' || activeBoard === 'healthy';
        const cacheKey = isDoforceBoard ? buildDoforceCacheKey() : buildTrendsCacheKey(activeBoard);
        const cacheBoard = isDoforceBoard ? 'doforce' : activeBoard;
        const enrichSnapshot = snapshotTrendEnrichCache(trendResult.repos);
        void saveDbTrendCache(cacheKey, cacheBoard, trendResult.repos, enrichSnapshot);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [trendResult, displayItems, enrichedApps, activeBoard]);

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
              next[k] = { ...payload.summary, platforms: [...payload.platforms] };
              changed = true;
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
    };
    window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, handler);
    return () => {
      window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, handler);
    };
  }, [trendResult]);

  // 榜单切换即递增 lite 序列：旧榜在途 lite 落定不再写入，避免跨榜串扰。
  useEffect(() => {
    trendBoardSeqRef.current += 1;
  }, [activeBoard, trendResult]);

  // 未收录行 lite 确认（App lazyBackfill 的榜单侧补齐，经共享 helper 分批 5/上限 20/seq 守卫）：
  // enrich 落定为空（fallback []）的行按 App 同口径走 getPlatformsLite 轻量通道：
  // 非空非 stale 即 patch enrichedApps 治愈，空非 stale 即记入榜单内已确认 Other；
  // stale/失败保持 pending 交给 settle 超时。enrich 合并与此处 patch 均永不以后续空值覆盖已治愈的真实平台。
  useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    if (platformResolvedOtherIds === undefined) return;
    const seq = trendBoardSeqRef.current;
    const inflight = trendLiteInflightRef.current;
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
      const liteId = (enriched.id || '').trim() || (item.repo.id || '').trim();
      if (!liteId) continue;
      targets.push({ key, liteId });
      if (targets.length >= 20) break;
    }
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
        }
        if (confirmedEmpty.length > 0) {
          setTrendConfirmedOtherIds((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const k of confirmedEmpty) {
              if (!next.has(k)) {
                next.add(k);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } finally {
        for (const t of targets) inflight.delete(t.key);
      }
    })();
  }, [trendResult, rawDisplayItems, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed]);

  // pending settle 超时：enrich 空 + 一次 lite 仍未治愈（或 lite stale/失败/裸行）
  // 至多等待 TREND_PENDING_SETTLE_MS 后降级为已确认 Other（徽标 + 计数 + 可过滤），
  // 而非无限 shimmer。超时前仍恒可见（不看 Other 勾选），落定后走正常 Other 过滤。
  // 治愈（具真实平台）的行永不被 settle 确认；定时器随榜单/回填变化重置，落稳后一次触发。
  useEffect(() => {
    if (platformResolvedOtherIds === undefined) return;
    if (trendResult?.status !== 'ok') return;
    const pendingSnapshot: string[] = [];
    for (const item of rawDisplayItems) {
      if (item.type !== 'uncataloged') continue;
      const key = (item.repo.id || '').trim().toLowerCase();
      if (!key) continue;
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
      setTrendConfirmedOtherIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const k of stillPending) {
          if (!next.has(k)) {
            next.add(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, TREND_PENDING_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [trendResult, rawDisplayItems, enrichedApps, platformResolvedOtherIds, trendCombinedConfirmed]);

  const gainTextFor = (gain?: number): string | undefined => {
    if (!gain || gain <= 0) return undefined;
    const count = formatStars(gain);
    if (gainKey === 'today') return t('trends.stars_gained_today', { count });
    if (gainKey === 'month') return t('trends.stars_gained_month', { count });
    return t('trends.stars_gained_week', { count });
  };

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
        {displayItems.length > 0 && (
          <span className="trends-count">
            {t('trends.results_count', { count: displayItems.length })}
          </span>
        )}
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
