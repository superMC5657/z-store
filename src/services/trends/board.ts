/**
 * C2 趋势榜单模块（trend-board vertical slice，唯一入口）。
 *
 * boards.ts + cache.ts + enrich.ts 在此收口为单一模块：
 *   fetch → L1 → L2-hydrate → enrich-merge → saveBoardCacheMerged
 *
 * - 唯一对外抓取入口仍为 `fetchTrendsResult(board, opts)`（boards.ts 原样透出，
 *   L1/L2/网络三路径现均 emit boardHydrated，关闭 L2-only 不对称）。
 * - 所有持久化收口于本模块 seam 之后：
 *   `persistBoardNow` / `scheduleBoardPersist` / `flushBoardPersist` /
 *   `noteBoardReposForPersist` / `subscribeBoardPersistOnConfirmedChange`。
 *   View 层禁止直调 `saveBoardCacheMerged` / `hydrate*` / `mark/unmark*`，
 *   仅持有 `enrichedApps` 镜像 + 本模块纯合并函数。
 * - SWR-fill / enrich-merge / lite-verify / settle-timeout 四段 helper
 *   全部收口于此（原 TrendsView.tsx:317-366 / 375-461 / 903-1125 / 1133-1261
 *   逐行搬运，语义零差），View 只做 load/refresh + render/filter/count。
 * - 治愈总线收口：`normalizeHealKeys` + `subscribeTrendHealBus`，
 *   3 路 window 事件（detail-platforms / detail-richcard / icon-changed）
 *   经同一归一 upsert 路径进镜像，不再三处散写。
 * - 首绘门：裸行先展不拦榜，仅升级受门控
 *  （`boardReady` + `swrSyncedResult` + `isUpgradePending`，见下）。
 *
 * 约束（ADR-0011 / ADR-0014+D9）：
 * - doforce 仅 rising/healthy，经 fetch_trends_text 单飞 12h 共享；
 *   失败按 error/empty 契约返回，永不伪造。
 * - L1 daily 1h / weekly-monthly-new 12h / 其余 5min；
 *   L2 daily 1h / 其余 12h + 0-30s 抖动扣减；切榜顺手 sweep，不加 timer。
 * - FE 256KB 预检降级 + BE 512KiB 硬拒绝；data:/空平台永不进 payload。
 * - enrich FE 20×2=40 + BE take(40)+buffered(5)；429 单次重试，
 *   retry_after_ms>60s 直接 error；key 一律 board|lang|cat lower-trim 同源；
 *   BE 薄透传。
 */

import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo } from '../../types';
import {
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  saveBoardCacheMerged,
} from './cache';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  hydrateTrendEnrichCache,
  isPlaceholderDescription,
  markTrendConfirmedOthers,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
  subscribeTrendConfirmedOtherChanges,
  unmarkTrendConfirmedOthers,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
} from './enrich';
import { fetchTrendsResult as fetchTrendsResultInner } from './boards';
import { subscribeBoardHydrated as subscribeBoardHydratedInner } from './boards';
import {
  PENDING_SETTLE_MS,
  resolvePendingPlatformsLite,
  type PendingLiteTarget,
} from '../../lib/platformFilter';
import { zlogInfo } from '../../lib/z-log';
import { getBufferedIcon } from '../iconStore';
import { isAvatarUrl } from '../../components/AppIcon';

/** 单一抓取入口（fetch→L1→L2-hydrate→enrich-merge→saveBoardCacheMerged，boards 原样透出）。 */
export const fetchTrendsResultSeam = fetchTrendsResultInner;
export type { PendingLiteTarget };

/** 统一 boardReady 订阅（L1/L2/网络三路径在 boards 内统一 emit 后的唯一出口）。 */
export const subscribeBoardReady = subscribeBoardHydratedInner;

/** settle 超时与主列表同值（TrendsView 重导出保持兼容）。 */
export const TREND_BOARD_SETTLE_MS = PENDING_SETTLE_MS;

/* ------------------------------------------------------------------ */
/* A. 缓存键 + 持久化 seam（View 禁止直调 saveBoardCacheMerged）        */
/* ------------------------------------------------------------------ */

export interface BoardCacheRef {
  cacheKey: string;
  cacheBoard: TrendBoardId | 'doforce';
  repos: TrendRepo[];
}

/** board → 缓存键/落盘 board 的唯一出口（读写同源，与 boards 读路径同 builder）。 */
export function resolveBoardCacheKey(
  board: TrendBoardId,
  opts: FetchTrendsOptions = {},
): { cacheKey: string; cacheBoard: TrendBoardId | 'doforce' } {
  const isDoforceBoard = board === 'rising' || board === 'healthy';
  if (isDoforceBoard) {
    return { cacheKey: buildDoforceCacheKey(opts), cacheBoard: 'doforce' };
  }
  return { cacheKey: buildTrendsCacheKey(board, opts), cacheBoard: board };
}

/** 持久化 seam 内部位：当前榜快照（note + schedule/flush 成对使用）。 */
let boardPersistRef: BoardCacheRef = { cacheKey: '', cacheBoard: 'weekly', repos: [] };
const boardPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 同步当前榜快照（render 侧每拍更新，供 debounce/pagehide/flush 读取）。 */
export function noteBoardReposForPersist(ref: BoardCacheRef): void {
  boardPersistRef = ref;
}

/** 直接写透一次（await 落稳；空榜直接返回；失败吞错不影响主流程）。 */
export async function persistBoardNow(
  cacheKey: string,
  cacheBoard: TrendBoardId | 'doforce',
  repos: TrendRepo[],
): Promise<void> {
  if (!cacheKey || !Array.isArray(repos) || repos.length === 0) return;
  await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
}

/**
 * 富卡写透节流：800ms debounce，聚合连击为一次落盘。
 * （原 TrendsView scheduleBoardWriteThrough 逐行搬运；timer 归模块，不归 View。）
 */
export function scheduleBoardPersist(cacheKey: string): void {
  if (!cacheKey) return;
  const pending = boardPersistTimers.get(cacheKey);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    boardPersistTimers.delete(cacheKey);
    const { cacheKey: key, cacheBoard, repos } = boardPersistRef;
    if (!key || repos.length === 0) return;
    void saveBoardCacheMerged(key, cacheBoard, repos);
  }, 800);
  boardPersistTimers.set(cacheKey, timer);
}

/**
 * 卸载/切榜 flush：先清节流 pending 再落盘一次（有富条目才写，防裸覆盖）。
 * （原 TrendsView pagehide flush 逐行搬运。）
 */
export function flushBoardPersist(): void {
  for (const timer of boardPersistTimers.values()) clearTimeout(timer);
  boardPersistTimers.clear();
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (!cacheKey || repos.length === 0) return;
  if (Object.keys(snapshotTrendEnrichCache(repos)).length === 0) return;
  void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
}

/**
 * 已确认变更写透联动：mark/unmark（含具平台驱逐删标记）触发后节流写透同榜 key。
 * 读路径 hydrate/sweep 不触发，无读放大。（原 TrendsView 订阅逐行搬运。）
 */
export function subscribeBoardPersistOnConfirmedChange(): () => void {
  return subscribeTrendConfirmedOtherChanges(() => {
    const { cacheKey } = boardPersistRef;
    if (!cacheKey) return;
    scheduleBoardPersist(cacheKey);
  });
}

/** 仅供测试：重置持久化 seam（清快照 + 定时器）。 */
export function __resetBoardPersistForTest(): void {
  for (const timer of boardPersistTimers.values()) clearTimeout(timer);
  boardPersistTimers.clear();
  boardPersistRef = { cacheKey: '', cacheBoard: 'weekly', repos: [] };
}

/* ------------------------------------------------------------------ */
/* B. SWR-fill（原 TrendsView 317-366 逐行搬运）                        */
/* ------------------------------------------------------------------ */

export interface SwrFill {
  snap: Record<string, AppSummary>;
  trustedConcrete: Set<string>;
  l2Confirmed: string[];
}

/** SWR 旧富卡直展输入：内存快照 + 可信集（仅具真实平台免验）+ L2 确认集。 */
export function buildSwrFill(repos: TrendRepo[]): SwrFill {
  const snap = snapshotTrendEnrichCache(repos);
  const trustedConcrete = new Set(
    Object.entries(snap)
      .filter(([, v]) => !!v.platforms && v.platforms.length > 0)
      .map(([k]) => k),
  );
  const l2Confirmed = snapshotTrendConfirmedOthers(repos);
  return { snap, trustedConcrete, l2Confirmed };
}

/**
 * SWR 富卡合并进镜像：缺席新增；旧 pending + 新具平台才覆盖（图标空不覆实）。
 * 富/裸以 enriched 存在为准，不用 icon 判定。
 */
export function mergeSwrEnrichedMirror(
  prev: Record<string, AppSummary>,
  snap: Record<string, AppSummary>,
): Record<string, AppSummary> {
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
      next[k] = v.icon.trim() === '' && cur.icon.trim() !== '' ? { ...v, icon: cur.icon } : v;
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** SWR 确认集合并：L2 确认并入本地（已具平台不并入，禁 pending 覆盖具平台）。 */
export function mergeSwrConfirmedMirror(
  prev: Set<string>,
  l2Confirmed: readonly string[],
  snap: Record<string, AppSummary>,
): Set<string> {
  if (!l2Confirmed || l2Confirmed.length === 0) return prev;
  let changed = false;
  const next = new Set(prev);
  for (const k of l2Confirmed) {
    const nk = String(k).trim().toLowerCase();
    if (!nk || next.has(nk)) continue;
    const cur = snap[nk];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    next.add(nk);
    changed = true;
  }
  return changed ? next : prev;
}

/* ------------------------------------------------------------------ */
/* C. enrich-merge（原 TrendsView 375-461 逐行搬运）                    */
/* ------------------------------------------------------------------ */

export type DisplayTrendItemLite =
  | { type: 'catalog'; app: AppSummary }
  | { type: 'uncataloged'; repo: TrendRepo };

/** 未收录行缺席收集：enrich 尚未落定的坐标去重后待拉。 */
export function collectMissingEnrichRepos(
  items: readonly DisplayTrendItemLite[],
  enrichedApps: Record<string, AppSummary>,
): Map<string, TrendRepo> {
  const missing = new Map<string, TrendRepo>();
  for (const item of items) {
    if (item.type !== 'uncataloged') continue;
    const key = item.repo.id.toLowerCase();
    if (!enrichedApps[key] && !missing.has(key)) missing.set(key, item.repo);
  }
  return missing;
}

export interface EnrichMergeResult {
  next: Record<string, AppSummary>;
  hasNewEnrich: boolean;
  concreteKeys: string[];
}

/**
 * enrich 回填合并进镜像：
 * - 详情治愈优先：已具真实平台的行不被空 enrich 回填覆盖；
 * - 图标回填只做升级：入项无图标但旧项有真实图标时保留旧图标，否则经缓冲补齐；
 * - 空壳不覆盖缓冲实图；具平台键同步收集供确认移除。
 */
export function mergeEnrichFoundMirror(
  prev: Record<string, AppSummary>,
  found: Map<string, AppSummary>,
): EnrichMergeResult {
  let changed = false;
  let hasNewEnrich = false;
  const concreteKeys: string[] = [];
  const next = { ...prev };
  for (const [key, app] of found) {
    const prevApp = next[key] ?? prev[key];
    const incomingEmpty = !app.platforms || app.platforms.length === 0;
    const prevHasPlatforms = !!prevApp?.platforms && prevApp.platforms.length > 0;
    if (incomingEmpty && prevHasPlatforms) continue;
    let mergedApp = app;
    const prevHasRealIcon =
      !!prevApp && typeof prevApp.icon === 'string' && prevApp.icon.trim() !== '';
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
  return { next: changed ? next : prev, hasNewEnrich, concreteKeys };
}

/** 具平台到达可覆盖升级：enrich 具平台即移出已确认（本地 + 内存标记）。 */
export function removeConfirmedForConcrete(
  prev: Set<string>,
  concreteKeys: readonly string[],
): Set<string> {
  if (!concreteKeys || concreteKeys.length === 0) return prev;
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
}

/** enrich 具平台升级的内存确认清理（含 id 别名，防确认残留致 Other 误展）。 */
export function unmarkConcreteKeys(concreteKeys: readonly string[]): void {
  if (!concreteKeys || concreteKeys.length === 0) return;
  unmarkTrendConfirmedOthers(concreteKeys);
}

/** lite patched 具平台升级的别名清理键收集（坐标 + id 别名双查）。 */
export function collectUnmarkAliasKeys(
  patchedKeys: Iterable<string>,
  latest: Record<string, AppSummary>,
): string[] {
  const aliasKeys: string[] = [];
  for (const k of patchedKeys) {
    const nk = String(k).trim().toLowerCase();
    if (!nk) continue;
    aliasKeys.push(nk);
    const curAlias = (latest[nk]?.id || '').trim().toLowerCase();
    if (curAlias !== '' && curAlias !== nk) aliasKeys.push(curAlias);
  }
  return aliasKeys;
}

/* ------------------------------------------------------------------ */
/* D. lite-verify（原 TrendsView 903-1125 逐行搬运）                    */
/* ------------------------------------------------------------------ */

export interface LiteSelectInput {
  rawItems: readonly DisplayTrendItemLiteExt[];
  enrichedApps: Record<string, AppSummary>;
  combinedConfirmed: ReadonlySet<string>;
  inflight: ReadonlySet<string>;
  trusted: ReadonlySet<string>;
}

export interface DisplayTrendItemLiteExt {
  type: 'catalog' | 'uncataloged';
  repo?: TrendRepo;
}

export interface LiteTargetsResult {
  targets: PendingLiteTarget[];
  trustedConcrete: number;
  trustedPending: number;
  skipped: number;
  uncatalogedTotal: number;
}

function liteEnrichedKeyOf(enriched: AppSummary | undefined): string {
  return ((enriched?.id || '') as string).trim().toLowerCase();
}

/**
 * lite 补验目标选择：
 * 仅 enrich 已落定为空的行走 lite（裸行交 settle 兜底）；
 * 已具真实平台 / 已确认 / 在途一律跳过；
 * 具平台可信免验（fresh concrete 才免验，pending 永不免验）。
 */
export function selectLiteTargets(input: LiteSelectInput): LiteTargetsResult {
  const { rawItems, enrichedApps, combinedConfirmed, inflight, trusted } = input;
  let freshSnap: Record<string, AppSummary> | null = null;
  const isFreshConcreteTrusted = (k: string): boolean => {
    if (!trusted.has(k)) return false;
    if (!freshSnap) {
      const boardRepos: TrendRepo[] = [];
      for (const item of rawItems) {
        if (item.type !== 'uncataloged' || !item.repo) continue;
        boardRepos.push(item.repo);
      }
      freshSnap = snapshotTrendEnrichCache(boardRepos);
    }
    const hit = freshSnap[k];
    if (!hit?.platforms || hit.platforms.length === 0) return false;
    return true;
  };
  const targets: Array<{ key: string; liteId: string }> = [];
  for (const item of rawItems) {
    if (item.type !== 'uncataloged' || !item.repo) continue;
    const key = (item.repo.id || '').trim().toLowerCase();
    if (!key) continue;
    const enriched = enrichedApps[key];
    if (!enriched) continue;
    if (enriched.platforms && enriched.platforms.length > 0) continue;
    const enrichedKey = liteEnrichedKeyOf(enriched);
    if (
      combinedConfirmed.has(key) ||
      (enrichedKey !== '' && combinedConfirmed.has(enrichedKey))
    ) {
      continue;
    }
    if (inflight.has(key)) continue;
    if (isFreshConcreteTrusted(key) || (enrichedKey !== '' && isFreshConcreteTrusted(enrichedKey)))
      continue;
    const liteId = (enriched.id || '').trim() || (item.repo.id || '').trim();
    if (!liteId) continue;
    targets.push({ key, liteId });
    if (targets.length >= 20) break;
  }
  let trustedPending = 0;
  let uncatalogedTotal = 0;
  for (const item of rawItems) {
    if (item.type !== 'uncataloged' || !item.repo) continue;
    const k = (item.repo.id || '').trim().toLowerCase();
    if (!k) continue;
    uncatalogedTotal += 1;
    const en = enrichedApps[k];
    if (!en) continue;
    if (en.platforms && en.platforms.length > 0) continue;
    const enKey = liteEnrichedKeyOf(en);
    if (combinedConfirmed.has(k) || (enKey !== '' && combinedConfirmed.has(enKey))) continue;
    trustedPending += 1;
  }
  const skipped = uncatalogedTotal - targets.length;
  return {
    targets,
    trustedConcrete: trusted.size,
    trustedPending,
    skipped,
    uncatalogedTotal,
  };
}

/** 免验取证单行日志（board/可信 concrete/pending/跳过/目标数，只读计数）。 */
export function logLiteSkip(
  board: string,
  r: LiteTargetsResult,
): void {
  zlogInfo(
    `[trends] lite-skip board=${board} trustedConcrete=${r.trustedConcrete} ` +
      `trustedPending=${r.trustedPending} skipped=${r.skipped} targets=${r.targets.length}`,
  );
}

/** lite 通道批量确认（分批 5，上限 20，seq 守卫由调用方传入 shouldAbort）。 */
export async function verifyPendingLite(
  targets: readonly PendingLiteTarget[],
  fetchLite: (
    liteId: string,
  ) => Promise<{ platforms?: readonly string[] | null; is_stale?: boolean | null } | null | undefined>,
  shouldAbort?: () => boolean,
): Promise<{ patched: Map<string, string[]>; confirmedEmpty: string[] }> {
  return resolvePendingPlatformsLite(targets, fetchLite, shouldAbort);
}

/** lite patched 合并进镜像：空永不覆盖已具平台（调用方已跳过，此处再守一次）。 */
export function mergeLitePatchedMirror(
  prev: Record<string, AppSummary>,
  patched: Map<string, string[]>,
): Record<string, AppSummary> {
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
}

/**
 * lite patched 持久化：hydrate（含 data: 剥空）+ 同榜 key 写透。
 * stale/失败不进 patched，保持 pending 等 settle 兜底。
 */
export async function persistLitePatched(
  patched: Map<string, string[]>,
  latest: Record<string, AppSummary>,
): Promise<void> {
  const toHydrate: Record<string, AppSummary> = {};
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
  if (Object.keys(toHydrate).length === 0) return;
  hydrateTrendEnrichCache(toHydrate);
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (cacheKey && repos.length > 0) {
    await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  }
}

/**
 * lite 空非 stale 确认：本地 + 内存标记 + hydrate（含 data: 剥空）+ 同榜 key 写透。
 * 竞态下已被治愈为具平台则跳过（禁 pending 覆盖具平台）。
 */
export async function confirmLiteEmpty(
  confirmedEmpty: readonly string[],
  latest: Record<string, AppSummary>,
): Promise<string[]> {
  const aliasConfirmed: string[] = [];
  for (const raw of confirmedEmpty) {
    const k = String(raw).trim().toLowerCase();
    if (!k) continue;
    const cur = latest[k];
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
  if (aliasConfirmed.length === 0) return aliasConfirmed;
  markTrendConfirmedOthers(aliasConfirmed);
  try {
    const toHydrate: Record<string, AppSummary> = {};
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
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (aliasConfirmed.length > 0 && repos.length > 0 && cacheKey) {
    try {
      await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
    } catch {
      // 写透失败不影响内存落定
    }
  }
  return aliasConfirmed;
}

/** 已确认集合并进本地（lite 确认落定）。 */
export function addConfirmedMirror(prev: Set<string>, keys: readonly string[]): Set<string> {
  if (!keys || keys.length === 0) return prev;
  let changed = false;
  const next = new Set(prev);
  for (const k of keys) {
    if (!next.has(k)) {
      next.add(k);
      changed = true;
    }
  }
  return changed ? next : prev;
}

/* ------------------------------------------------------------------ */
/* E. settle-timeout（原 TrendsView 1133-1261 逐行搬运）                */
/* ------------------------------------------------------------------ */

export interface SettleCollect {
  pendingKeys: string[];
  repoByKey: Map<string, TrendRepo>;
}

/** settle 超时输入收集：仍 pending（未具平台 + 未确认）的未收录行。 */
export function collectSettlePending(
  rawItems: readonly DisplayTrendItemLiteExt[],
  enrichedApps: Record<string, AppSummary>,
  combinedConfirmed: ReadonlySet<string>,
): SettleCollect {
  const pendingSnapshot: string[] = [];
  const repoByKey = new Map<string, TrendRepo>();
  for (const item of rawItems) {
    if (item.type !== 'uncataloged' || !item.repo) continue;
    const key = (item.repo.id || '').trim().toLowerCase();
    if (!key) continue;
    if (!repoByKey.has(key)) repoByKey.set(key, item.repo);
    const enriched = enrichedApps[key];
    if (enriched?.platforms && enriched.platforms.length > 0) continue;
    const enrichedKey = ((enriched?.id || '') as string).trim().toLowerCase();
    if (
      combinedConfirmed.has(key) ||
      (enrichedKey !== '' && combinedConfirmed.has(enrichedKey))
    ) {
      continue;
    }
    pendingSnapshot.push(key);
  }
  return { pendingKeys: pendingSnapshot, repoByKey };
}

/** settle 超时仍 pending 过滤（timer 触发时按最新镜像 + 确认集复核）。 */
export function filterStillPending(
  pendingKeys: readonly string[],
  latestEnriched: Record<string, AppSummary>,
  globalConfirmed: ReadonlySet<string> | undefined,
  localConfirmed: ReadonlySet<string>,
): string[] {
  const stillPending: string[] = [];
  for (const key of pendingKeys) {
    const cur = latestEnriched[key];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    const curKey = ((cur?.id || '') as string).trim().toLowerCase();
    if (globalConfirmed?.has(key) || localConfirmed.has(key)) continue;
    if (curKey !== '' && (globalConfirmed?.has(curKey) || localConfirmed.has(curKey))) continue;
    stillPending.push(key);
  }
  return stillPending;
}

/** 裸行合成最小 Other 摘要（与原内联合成逐字段一致；具平台不合成）。 */
export function synthesizeSettleSummary(repo: TrendRepo): AppSummary | null {
  if (!repo.id || !repo.owner || !repo.repo) return null;
  const shortName = (repo.repo || repo.name || repo.id).trim() || repo.id;
  return {
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

export interface SettleHydration {
  toHydrate: Record<string, AppSummary>;
  aliasKeys: string[];
}

/** 同 key hydrate 输入构建：空 enrich 剥 data:，裸行合成最小摘要。 */
export function buildSettleHydration(
  stillPending: readonly string[],
  latestEnriched: Record<string, AppSummary>,
  repoByKey: Map<string, TrendRepo>,
  allRepos: readonly TrendRepo[],
): SettleHydration {
  const toHydrate: Record<string, AppSummary> = {};
  const aliasKeys: string[] = [];
  for (const key of stillPending) {
    const cur = latestEnriched[key];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    if (cur) {
      const curKey = ((cur.id || '') as string).trim().toLowerCase();
      aliasKeys.push(key);
      if (curKey !== '' && curKey !== key) aliasKeys.push(curKey);
      if (typeof cur.icon === 'string' && cur.icon.startsWith('data:')) {
        toHydrate[key] = { ...cur, icon: '' };
      } else if (!toHydrate[key]) {
        toHydrate[key] = cur;
      }
      continue;
    }
    const repo =
      repoByKey.get(key) ?? allRepos.find((r) => (r.id || '').trim().toLowerCase() === key);
    if (!repo) continue;
    const synth = synthesizeSettleSummary(repo);
    if (!synth) continue;
    aliasKeys.push(key);
    toHydrate[key] = synth;
  }
  return { toHydrate, aliasKeys };
}

/** settle 确认提交：先 mark 再 hydrate（已确认 pending 方可进内存）。 */
export function commitSettleConfirmed(aliasKeys: readonly string[], toHydrate: Record<string, AppSummary>): void {
  if (!aliasKeys || aliasKeys.length === 0) return;
  try {
    markTrendConfirmedOthers(aliasKeys);
    if (Object.keys(toHydrate).length > 0) {
      hydrateTrendEnrichCache(toHydrate);
    }
  } catch {
    // 标记失败仍尝试本地落定（调用方继续并镜像）
  }
}

/** settle 本地直展裸合成卡：镜像缺席的键一次并入（已有不重写）。 */
export function mergeSettleSyntheticMirror(
  prev: Record<string, AppSummary>,
  toHydrate: Record<string, AppSummary>,
): Record<string, AppSummary> {
  if (Object.keys(toHydrate).length === 0) return prev;
  let changed = false;
  const next = { ...prev };
  for (const [k, v] of Object.entries(toHydrate)) {
    if (next[k]) continue;
    next[k] = v;
    changed = true;
  }
  return changed ? next : prev;
}

/** settle 确认写透：同榜 key 落盘（含确认集），重挂零 lite 直展 Other 卡。 */
export function persistSettleConfirmed(): void {
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (!cacheKey || repos.length === 0) return;
  try {
    void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  } catch {
    // 写透失败不影响内存落定
  }
}

/* ------------------------------------------------------------------ */
/* F. 治愈总线（3 路 window 事件 → 同一归一 upsert）                    */
/* ------------------------------------------------------------------ */

/** 治愈键归一（lower-trim 去空，与 enrich 键同源）。 */
export function normalizeHealKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    const nk = String(k ?? '').trim().toLowerCase();
    if (nk) out.push(nk);
  }
  return out;
}

/** 当前榜已知仓键集（坐标 + id 双键；跨榜治愈据此过滤，防无界膨胀）。 */
export function boardRepoKeys(repos: readonly TrendRepo[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of repos ?? []) {
    if (r.id) out.add(r.id.trim().toLowerCase());
    if (r.owner && r.repo) out.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
  }
  return out;
}

/**
 * 平台治愈镜像合并（原 DETAIL_PLATFORMS_HEAL handler 逐行搬运）：
 * 空 pending 行被具平台值替换并保留旧真实图标；已具平台行仅跟随非空非 avatar 图标；
 * 预 enrich 行（榜单已知但镜像缺席）直接创建；命中键同步移出已确认。
 */
export function applyPlatformsHealToMirror(
  prev: Record<string, AppSummary>,
  keys: readonly string[],
  summary: AppSummary,
  platforms: readonly string[],
  repoKeys: ReadonlySet<string>,
): Record<string, AppSummary> {
  const keySet = new Set(keys);
  let changed = false;
  const next = { ...prev };
  for (const k of Object.keys(prev)) {
    if (!keySet.has(k.toLowerCase())) continue;
    const cur = prev[k];
    if (!cur.platforms || cur.platforms.length === 0) {
      const keepIcon = summary.icon.trim() === '' && cur.icon.trim() !== '';
      next[k] = {
        ...summary,
        platforms: [...platforms],
        ...(keepIcon ? { icon: cur.icon } : null),
      };
      changed = true;
    } else {
      const incomingIcon = typeof summary.icon === 'string' ? summary.icon.trim() : '';
      if (incomingIcon !== '' && !isAvatarUrl(incomingIcon) && cur.icon !== incomingIcon) {
        const incomingBg = typeof summary.icon_bg === 'string' ? summary.icon_bg : '';
        next[k] = {
          ...cur,
          icon: incomingIcon,
          ...(incomingBg.trim() !== '' ? { icon_bg: summary.icon_bg } : null),
        };
        changed = true;
      }
    }
  }
  for (const k of keys) {
    if (!next[k] && repoKeys.has(k)) {
      next[k] = { ...summary, platforms: [...platforms] };
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** 平台治愈确认清理（本地 + 内存标记别名，防确认残留致 Other 误展）。 */
export function cleanupPlatformsHealConfirmed(
  prev: Set<string>,
  keys: readonly string[],
): Set<string> {
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
}

/** 平台治愈内存确认清理（与 App 侧 upsert 同键互补，补清别名）。 */
export function unmarkPlatformsHealKeys(keys: readonly string[]): void {
  if (!keys || keys.length === 0) return;
  unmarkTrendConfirmedOthers(keys);
}

/**
 * 富卡治愈镜像合并（原 DETAIL_RICHCARD_HEAL handler 逐行搬运）：
 * platforms 沿旧（仅旧空且 incoming 非空才补）；icon/icon_bg 不动归 icon 通道；
 * 其余 dirty 直接覆盖（占位简介即使误带也不覆盖实值）；预 enrich 行创建时剥占位。
 */
export function applyRichcardHealToMirror(
  prev: Record<string, AppSummary>,
  payload: DetailRichcardHealPayload,
  repoKeys: ReadonlySet<string>,
): Record<string, AppSummary> {
  const keys = normalizeHealKeys(payload.keys);
  if (keys.length === 0) return prev;
  const keySet = new Set(keys);
  const dirtySet = new Set(
    (payload.dirtyFields ?? []).filter((f): f is string => typeof f === 'string'),
  );
  dirtySet.delete('icon');
  dirtySet.delete('icon_bg');
  dirtySet.delete('platforms');
  if (dirtySet.size === 0 && (!payload.platforms || payload.platforms.length === 0)) return prev;
  const hitKeys = keys.filter((k) => repoKeys.has(k));
  if (hitKeys.length === 0) {
    let aliasHit = false;
    for (const k of Object.keys(prev)) {
      if (!keySet.has(k.toLowerCase())) continue;
      aliasHit = true;
      break;
    }
    if (!aliasHit) return prev;
  }
  let changed = false;
  const next = { ...prev };
  for (const k of Object.keys(prev)) {
    const cur = prev[k];
    const alias = String(cur?.id ?? '').trim().toLowerCase();
    if (!keySet.has(k.toLowerCase()) && (alias === '' || !keySet.has(alias))) continue;
    if (!repoKeys.has(k.toLowerCase()) && (alias === '' || !repoKeys.has(alias))) continue;
    const patched: AppSummary = { ...cur };
    let rowChanged = false;
    if (
      (!patched.platforms || patched.platforms.length === 0) &&
      payload.platforms &&
      payload.platforms.length > 0
    ) {
      patched.platforms = [...payload.platforms];
      rowChanged = true;
    }
    for (const f of dirtySet) {
      const incoming = (payload.summary as unknown as Record<string, unknown>)[f];
      if (incoming === undefined) continue;
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
  for (const k of hitKeys) {
    if (!next[k]) {
      const {
        icon: _dropIcon,
        icon_bg: _dropBg,
        platforms: _dropPlats,
        ...rest
      } = payload.summary as unknown as AppSummary & Record<string, unknown>;
      void _dropIcon;
      void _dropBg;
      void _dropPlats;
      const restSummary = rest as unknown as AppSummary;
      next[k] = {
        ...restSummary,
        description:
          typeof restSummary.description === 'string' &&
          isPlaceholderDescription(restSummary.description)
            ? ''
            : restSummary.description,
        description_en:
          typeof restSummary.description_en === 'string' &&
          isPlaceholderDescription(restSummary.description_en)
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
}

/** 富卡治愈持久化：hydrate + 节流写透（data: 禁入由 hydrate 保证）。 */
export function persistRichcardHeal(
  latest: Record<string, AppSummary>,
  payload: DetailRichcardHealPayload,
  repoKeys: ReadonlySet<string>,
): void {
  try {
    const keys = normalizeHealKeys(payload.keys);
    const keySet = new Set(keys);
    const toHydrate: Record<string, AppSummary> = {};
    for (const k of Object.keys(latest)) {
      const cur = latest[k];
      if (!cur) continue;
      const alias = String(cur.id ?? '').trim().toLowerCase();
      if (!keySet.has(k.toLowerCase()) && (alias === '' || !keySet.has(alias))) continue;
      if (!repoKeys.has(k.toLowerCase()) && (alias === '' || !repoKeys.has(alias))) continue;
      toHydrate[k] = cur;
    }
    const hitKeys = keys.filter((k) => repoKeys.has(k));
    for (const k of hitKeys) {
      if (!toHydrate[k]) {
        const created = {
          ...payload.summary,
          platforms:
            payload.platforms && payload.platforms.length > 0 ? [...payload.platforms] : [],
        } as AppSummary;
        if (typeof created.icon === 'string' && created.icon.startsWith('data:')) continue;
        if (typeof created.description === 'string' && isPlaceholderDescription(created.description)) {
          created.description = '';
        }
        if (
          typeof created.description_en === 'string' &&
          isPlaceholderDescription(created.description_en)
        ) {
          created.description_en = '';
        }
        toHydrate[k] = created;
      }
    }
    if (Object.keys(toHydrate).length === 0) return;
    hydrateTrendEnrichCache(toHydrate);
    const { cacheKey } = boardPersistRef;
    if (!cacheKey) return;
    scheduleBoardPersist(cacheKey);
  } catch {
    // 落盘失败不影响内存 merge
  }
}

/**
 * 图标变更镜像合并（原 zstore:icon-changed handler 逐行搬运）：
 * incoming 非 avatar 且与旧不同即覆盖；L5（''）放行内存清零；
 * 大小写归一，同时匹配坐标键与 enriched.id 小写别名。
 */
export function applyIconChangedToMirror(
  prev: Record<string, AppSummary>,
  appIdNorm: string,
  rawIcon: string,
): Record<string, AppSummary> {
  if (!appIdNorm) return prev;
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
}

/** 图标变更持久化：L5 清零与 data: 只做内存，跳过 hydrate/写透；否则 hydrate + 直接写透。 */
export function persistIconChanged(
  latest: Record<string, AppSummary>,
  appIdNorm: string,
  rawIcon: string,
): void {
  if (rawIcon === '') return;
  if (rawIcon.startsWith('data:')) return;
  try {
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
    const { cacheKey, cacheBoard, repos } = boardPersistRef;
    if (!cacheKey || repos.length === 0) return;
    void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  } catch {
    // 落盘失败不影响内存即时展示
  }
}

export interface TrendHealBusHandlers {
  onPlatformsHeal?: (
    payload: DetailPlatformsHealPayload,
    keys: string[],
  ) => void;
  onRichcardHeal?: (
    payload: DetailRichcardHealPayload,
    keys: string[],
  ) => void;
  onIconChanged?: (appIdNorm: string, rawIcon: string) => void;
}

/**
 * 治愈总线统一订阅：3 路 window 事件经同一归一路径分发。
 * 调用方只订一次，不再三处 addEventListener 散写；
 * key 归一（lower-trim 去空） + avatar 过滤在此统一把关。
 */
export function subscribeTrendHealBus(handlers: TrendHealBusHandlers): () => void {
  const onPlatforms = (e: Event): void => {
    const payload = (e as CustomEvent<DetailPlatformsHealPayload>).detail;
    if (!payload || !Array.isArray(payload.platforms) || payload.platforms.length === 0) return;
    if (!payload.summary || !Array.isArray(payload.keys) || payload.keys.length === 0) return;
    const keys = normalizeHealKeys(payload.keys);
    if (keys.length === 0) return;
    handlers.onPlatformsHeal?.(payload, keys);
  };
  const onRichcard = (e: Event): void => {
    const payload = (e as CustomEvent<DetailRichcardHealPayload>).detail;
    if (!payload || !payload.summary || typeof payload.summary !== 'object') return;
    if (!Array.isArray(payload.keys) || payload.keys.length === 0) return;
    if (!Array.isArray(payload.dirtyFields) || payload.dirtyFields.length === 0) return;
    const keys = normalizeHealKeys(payload.keys);
    if (keys.length === 0) return;
    handlers.onRichcardHeal?.(payload, keys);
  };
  const onIcon = (e: Event): void => {
    const detail = (e as CustomEvent<{ appId: string; icon: string }>).detail;
    if (!detail) return;
    const rawIcon = typeof detail.icon === 'string' ? detail.icon.trim() : '';
    const appIdNorm = String(detail.appId ?? '').trim().toLowerCase();
    if (!appIdNorm || isAvatarUrl(rawIcon)) return;
    handlers.onIconChanged?.(appIdNorm, rawIcon);
  };
  window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
  window.addEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
  window.addEventListener('zstore:icon-changed', onIcon);
  return () => {
    window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
    window.removeEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
    window.removeEventListener('zstore:icon-changed', onIcon);
  };
}

/* ------------------------------------------------------------------ */
/* G. 首绘门：裸行先展不拦榜，仅升级受门控                              */
/* ------------------------------------------------------------------ */

/**
 * SWR 同步结果：board repos 落定 + 内存快照已合并进镜像即同步。
 * 裸行直展不拦榜；仅富卡升级参考此门。
 */
export function swrSyncedResult(
  repos: readonly TrendRepo[] | undefined,
  enrichedApps: Record<string, AppSummary>,
): boolean {
  if (!repos || repos.length === 0) return false;
  for (const r of repos) {
    const key = (r.id || '').trim().toLowerCase();
    if (!key) continue;
    if (enrichedApps[key]) return true;
  }
  return repos.length > 0;
}

/**
 * 升级是否挂起：未就绪（boardReady=false）或 SWR 尚未同步即挂起。
 * 调用方：裸行照常直展；enrich/图标补齐等升级路径据此决定是否延迟到就绪后。
 */
export function isUpgradePending(boardReady: boolean, swrSynced: boolean): boolean {
  return !boardReady || !swrSynced;
}

/** 富卡升级门：就绪即允许升级（裸行先展，升级不拦首绘）。 */
export function isEnrichUpgradeAllowed(boardReady: boolean): boolean {
  return boardReady;
}

/* ------------------------------------------------------------------ */
/* H. 确认集快照透出（View 过滤/计数口径用，不直调 enrich 内部）        */
/* ------------------------------------------------------------------ */

/** 榜单确认集快照（仍属本榜 + 新鲜 + 非具平台由 enrich 侧保证）。 */
export function snapshotBoardConfirmed(repos?: TrendRepo[]): string[] {
  return snapshotTrendConfirmedOthers(repos);
}

/** 榜单 enrich 快照（归一键 + 新鲜 + data: 禁入由 enrich 侧保证）。 */
export function snapshotBoardEnrich(repos?: TrendRepo[]): Record<string, AppSummary> {
  return snapshotTrendEnrichCache(repos);
}

/**
 * 镜像 hydrate 缝（View 侧唯一 hydrate 出口，不直调 enrich 内部）。
 * data:/未确认 pending/具平台覆盖等守卫仍由 enrich 侧执行。
 */
export function hydrateBoardEnrich(map: Record<string, AppSummary>): void {
  hydrateTrendEnrichCache(map);
}

/** 当前持久化榜键（供节流调度读取；快照经 noteBoardReposForPersist 同步）。 */
export function getBoardPersistKey(): string {
  return boardPersistRef.cacheKey;
}
