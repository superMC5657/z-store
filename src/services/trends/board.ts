/**
 * 趋势榜单模块（trend-board vertical slice，唯一入口）。
 *
 * boards.ts + cache.ts + enrich.ts 在此收口为单一模块：
 *   fetch → L1 → L2-hydrate → enrich-merge → saveBoardCacheMerged
 *
 * - 唯一对外抓取入口为本模块 `fetchTrendsResultSeam(board, opts)`（boards 内实现，
 *   L1/L2/网络三路径现均 emit boardHydrated）。
 *   View/hook 一律经此口，不直调 `boards.fetchTrendsResult`。
 * - 唯一就绪订阅为 `boards.subscribeBoardHydrated`（单 emit 源，View 侧单订阅，不双订）。
 * - key/TTL/envelope/hydrate/snapshot 一律收为内部 seams：
 *   key 经 `resolveBoardCacheKey`（读写同源），TTL 语义不变（ADR-0007/ADR-0014），
 *   信封/hydrate/快照经 `maybePersistBoardNow`/`putBoardEnrichMemory`/`snapshotBoard*`，
 *   View 层禁止直调 cache/enrich 底层（`build*CacheKey`/`getDb*`/`hydrate*`/`mark/unmark*`）。
 *   底层导出仅供 slice 内部 + 白盒单测。
 * - L2 归一 key 读写同源，旧非归一 key 按 miss 重抓。
 * - 所有持久化收口于本模块 seam 之后：
 *   `maybePersistBoardNow` / `maybeScheduleBoardPersist` / `flushBoardPersist` /
 *   `noteBoardReposForPersist` / `subscribeBoardPersistOnConfirmedChange`。
 *   View 层禁止直调 `saveBoardCacheMerged` / `hydrate*` / `mark/unmark*`，
 *   仅持有 `enrichedApps` 镜像 + 本模块纯合并函数。
 * - SWR-fill / enrich-merge / lite-verify / settle-timeout 四段 helper
 *   全部收口于此，View 只做 load/refresh + render/filter/count。
 * - 治愈总线收口：`normalizeHealKeys` + `subscribeTrendHealBus`，
 *   2 路 window 事件（detail-platforms / detail-richcard）
 *   经同一归一 upsert 路径进镜像（图标走 `icon-ready → admitIconHit` 唯一写口，不走窗口总线）。
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

import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo, TrendsResult } from '../../types';
import React from 'react';
import {
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  isDataIcon,
  isMissingIconForDisplay,
  isPersistableIcon,
  saveBoardCacheMerged,
} from './cache';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  putTrendEnrichMemory,
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
import {
  createInflightGuard,
  createSeqGuard,
  runLiteBatch,
  scheduleSettleConfirm,
  unionConfirmedSets,
  type InflightGuard,
  type LiteFetch,
  type LoadingLiteTarget,
  type SeqGuard,
} from '../../lib/platformFilter';
import { zlogInfo, zlogWarn } from '../../lib/z-log';
import { DEFAULT_ICON_BG } from '../../styles/tokens';
import {
  ASSEMBLED_ROW_ICON_QUEUE_CAP,
  admitIconHit,
  resolveIconWithBuffer,
} from '../iconStore';

export { isDataIcon, isMissingIconForDisplay, isPersistableIcon };

/**
 * 单一抓取入口（board 为唯一 deep module 的对外抓取口）。
 * fetch→L1→L2-hydrate→enrich-merge→saveBoardCacheMerged 全链路经 boards 内部实现，
 * 本包装为 View/hook 唯一对外 interface（不直调 `boards.fetchTrendsResult`）。
 * 保留 `fetchTrendsResultSeam` 命名以避 `services/trends` 星导出重名冲突；
 * TTL/错误契约不变（ADR-0007/ADR-0013/ADR-0014）。
 */
export function fetchTrendsResultSeam(
  ...args: Parameters<typeof fetchTrendsResultInner>
): ReturnType<typeof fetchTrendsResultInner> {
  return fetchTrendsResultInner(...args);
}
export type { LoadingLiteTarget };

/* ------------------------------------------------------------------ */
/* A. 缓存键 + 持久化 seam（View 禁止直调 saveBoardCacheMerged）        */
/* ------------------------------------------------------------------ */

interface BoardCacheRef {
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
export async function maybePersistBoardNow(
  cacheKey: string,
  cacheBoard: TrendBoardId | 'doforce',
  repos: TrendRepo[],
): Promise<void> {
  if (!cacheKey || !Array.isArray(repos) || repos.length === 0) return;
  await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
}

/**
 * 富卡写透节流：800ms debounce，聚合连击为一次落盘。
 * （timer 归模块，不归 View。）
 */
export function maybeScheduleBoardPersist(cacheKey: string): void {
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
 *
 */
function flushBoardPersist(): void {
  for (const timer of boardPersistTimers.values()) clearTimeout(timer);
  boardPersistTimers.clear();
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (!cacheKey || repos.length === 0) {
    zlogWarn(`[trends] persist skipped reason=no-key-or-empty-repos hasKey=${cacheKey !== ''} repos=${repos.length}`);
    return;
  }
  const snapSize = Object.keys(snapshotTrendEnrichCache(repos)).length;
  if (snapSize === 0) {
    zlogWarn(`[trends] persist skipped reason=empty-enrich-snapshot repos=${repos.length}`);
    return;
  }
  void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
}

/**
 * 卸载同步落盘（含最新镜像先行 hydrate）：先把已渲染镜像推入内存，
 * 再清 debounce 定时器并落盘一次；内存合并守卫（空不覆实、`data:` 禁入）由 enrich 侧执行。
 */
export function flushBoardPersistWithMirror(latest: Record<string, AppSummary>): void {
  try {
    if (latest && typeof latest === 'object' && Object.keys(latest).length > 0) {
      putTrendEnrichMemory(latest);
    }
  } catch {
    // hydrate 失败不阻塞落盘
  }
  flushBoardPersist();
}

/**
 * 已确认变更写透联动：mark/unmark（含具平台驱逐删标记）触发后节流写透同榜 key。
 * 读路径 hydrate/sweep 不触发，无读放大。
 */
export function subscribeBoardPersistOnConfirmedChange(): () => void {
  return subscribeTrendConfirmedOtherChanges(() => {
    const { cacheKey } = boardPersistRef;
    if (!cacheKey) return;
    maybeScheduleBoardPersist(cacheKey);
  });
}

/* ------------------------------------------------------------------ */
/* B. SWR-fill                        */
/* ------------------------------------------------------------------ */

interface SwrFill {
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
 * SWR 富卡合并进镜像：缺席新增；旧 loading + 新具平台才覆盖（图标经店内 `resolveIconWithBuffer` 单 interface 合并，空不覆实 + 缓冲回读）。
 * 富/裸以 enriched 存在为准，不用 icon 判定。图标 `depth` 在深 module，本函数只做平台准入，不自立图标 locality。
 * 同级（同 loading / 同具平台）仍合并图标：快照实图回填镜像空图（空/`data:` 永不覆实），重挂不闪空徽章。
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
      next[k] = resolveIconWithBuffer(cur, v);
      changed = true;
      continue;
    }
    // 同级仅图标跟进：快照实图补镜像空图，空/`data:` 永不覆实（单 interface 收敛）。
    const mergedIcon = resolveIconWithBuffer(cur, v);
    if (mergedIcon.icon !== cur.icon) {
      next[k] = mergedIcon;
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** SWR 确认集合并：L2 确认并入本地（已具平台不并入，禁 loading 覆盖具平台）。 */
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

/** 行图标缺失判定（SWR 重挂自愈用）：复用展示态 SSOT，空串或 `data:` 视为缺失。 */
function isRowIconMissing(icon: unknown): boolean {
  return isMissingIconForDisplay(icon);
}

/**
 * SWR 重挂图标自愈输入收集：镜像中图标缺失的坐标键（小写去重保序）。
 * 上限与组装落盘补齐同量级（`ASSEMBLED_ROW_ICON_QUEUE_CAP`），防 N+1 风暴；
 * 去重 + 保序与 enrich 缺席收集同约定。
 */
export function collectEmptyIconKeys(
  mirror: Record<string, AppSummary>,
  cap: number = ASSEMBLED_ROW_ICON_QUEUE_CAP,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(mirror ?? {})) {
    if (out.length >= cap) break;
    const nk = String(k).trim().toLowerCase();
    if (!nk || seen.has(nk)) continue;
    seen.add(nk);
    const cur = (mirror as Record<string, AppSummary>)[k];
    if (isRowIconMissing(cur?.icon)) out.push(nk);
  }
  return out;
}

interface DbIconMergeResult {
  next: Record<string, AppSummary>;
  patchedKeys: string[];
}

/**
 * DB 确认图标合并进镜像（重挂自愈写口，DB-only 无网络）：
 * 仅镜像图标缺失（空/`data:`）时受理；入库图标经店内唯一写口 `admitIconHit`
 *（`via=m2`，不占 `level`）合流，`data:` 只进 M1 内存、`http` 远端走落盘预热；
 * 已有实图永不覆写；大小写归一同时匹配坐标键与 `enriched.id` 小写别名。
 * 返回补齐后的镜像与被补键（供 hydrate 用）。
 */
export function mergeDbIconsIntoMirror(
  prev: Record<string, AppSummary>,
  icons: ReadonlyMap<string, string> | Record<string, string>,
): DbIconMergeResult {
  const entries =
    icons instanceof Map ? [...icons.entries()] : Object.entries(icons ?? {});
  if (entries.length === 0) return { next: prev, patchedKeys: [] };
  const byKey = new Map<string, string>();
  for (const [rawK, rawIcon] of entries) {
    const nk = String(rawK).trim().toLowerCase();
    if (!nk || byKey.has(nk)) continue;
    if (typeof rawIcon !== 'string' || rawIcon.trim() === '') continue;
    byKey.set(nk, rawIcon);
  }
  if (byKey.size === 0) return { next: prev, patchedKeys: [] };
  let changed = false;
  const next = { ...prev };
  const patchedKeys: string[] = [];
  for (const k of Object.keys(prev)) {
    const cur = prev[k];
    if (!isMissingIconForDisplay(cur?.icon)) continue;
    const alias = String(cur?.id ?? '').trim().toLowerCase();
    const hit =
      byKey.get(String(k).trim().toLowerCase()) ??
      (alias !== '' ? byKey.get(alias) : undefined);
    if (typeof hit !== 'string' || hit.trim() === '') continue;
    if (cur.icon === hit) continue;
    let admitted: string | undefined;
    try {
      const res = admitIconHit({
        id: String(k).trim().toLowerCase() || alias,
        icon: hit,
        via: 'm2',
      });
      if (!res.accepted || !res.icon) continue;
      admitted = res.icon;
    } catch {
      continue;
    }
    if (typeof admitted !== 'string' || admitted.trim() === '') continue;
    if (cur.icon === admitted) continue;
    next[k] = { ...cur, icon: admitted };
    changed = true;
    patchedKeys.push(k);
  }
  return { next: changed ? next : prev, patchedKeys };
}

/* ------------------------------------------------------------------ */
/* C. enrich-merge                    */
/* ------------------------------------------------------------------ */

type DisplayTrendItemLite =
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

interface EnrichMergeResult {
  next: Record<string, AppSummary>;
  hasNewEnrich: boolean;
  concreteKeys: string[];
}

/**
 * enrich 回填合并进镜像：
 * - 详情治愈优先：已具真实平台的行不被空 enrich 回填覆盖；
 * - 图标经店内 `resolveIconWithBuffer` 单 interface 合并（旧实 + 回填空 → 沿用旧，空壳经 M1 缓冲回读）；
 *   本函数只做平台准入，不自立图标 `trim()===''`/`getBufferedIcon` locality（`depth` 在深 module）；
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
    // 图标单 interface：`undefined` 旧值亦经缓冲回读（与旧 `getBufferedIcon(key)` 同语义）。
    const mergedApp = resolveIconWithBuffer(prevApp, app);
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
function collectUnmarkAliasKeys(
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
/* D. lite-verify                    */
/* ------------------------------------------------------------------ */

interface LiteSelectInput {
  rawItems: readonly DisplayTrendItemLiteExt[];
  enrichedApps: Record<string, AppSummary>;
  combinedConfirmed: ReadonlySet<string>;
  inflight: ReadonlySet<string>;
  trusted: ReadonlySet<string>;
}

interface DisplayTrendItemLiteExt {
  type: 'catalog' | 'uncataloged';
  repo?: TrendRepo;
}

interface LiteTargetsResult {
  targets: LoadingLiteTarget[];
  trustedConcrete: number;
  trustedLoading: number;
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
 * 具平台可信免验（fresh concrete 才免验，loading 永不免验）。
 */
function selectLiteTargets(input: LiteSelectInput): LiteTargetsResult {
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
  let trustedLoading = 0;
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
    trustedLoading += 1;
  }
  const skipped = uncatalogedTotal - targets.length;
  return {
    targets,
    trustedConcrete: trusted.size,
    trustedLoading,
    skipped,
    uncatalogedTotal,
  };
}

/** 免验取证单行日志（board/可信 concrete/loading/跳过/目标数，只读计数）。 */
function logLiteSkip(
  board: string,
  r: LiteTargetsResult,
): void {
  zlogInfo(
    `[trends] lite-skip board=${board} trustedConcrete=${r.trustedConcrete} ` +
      `trustedLoading=${r.trustedLoading} skipped=${r.skipped} targets=${r.targets.length}`,
  );
}

/** lite 通道批量确认（分批 5，上限 20，seq 守卫由调用方传入 shouldAbort；经深模块同一口）。 */
async function verifyLoadingLite(
  targets: readonly LoadingLiteTarget[],
  fetchLite: LiteFetch,
  shouldAbort?: () => boolean,
): Promise<{ patched: Map<string, string[]>; confirmedEmpty: string[] }> {
  return runLiteBatch(targets, fetchLite, shouldAbort);
}

/** lite patched 合并进镜像：空永不覆盖已具平台（调用方已跳过，此处再守一次）。 */
function mergeLitePatchedMirror(
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
 * lite patched 持久化：hydrate（`data:` 剥空由展示态 SSOT 裁决）+ 同榜 key 写透。
 * stale/失败不进 patched，保持 loading 等 settle 兜底。
 */
async function maybePersistLitePatched(
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
    const icon = isDataIcon(cur.icon) ? '' : cur.icon;
    toHydrate[normKey] = { ...cur, icon, platforms: [...plats] };
  }
  if (Object.keys(toHydrate).length === 0) return;
  putTrendEnrichMemory(toHydrate);
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (cacheKey && repos.length > 0) {
    await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  }
}

/**
 * lite 空非 stale 确认：本地 + 内存标记 + hydrate（`data:` 剥空由展示态 SSOT 裁决）+ 同榜 key 写透。
 * 竞态下已被治愈为具平台则跳过（禁 loading 覆盖具平台）。
 */
async function confirmLiteEmpty(
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
      toHydrate[k] = isDataIcon(cur.icon) ? { ...cur, icon: '' } : cur;
    }
    if (Object.keys(toHydrate).length > 0) {
      putTrendEnrichMemory(toHydrate);
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
function addConfirmedMirror(prev: Set<string>, keys: readonly string[]): Set<string> {
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
/* E. settle-timeout                */
/* ------------------------------------------------------------------ */

interface SettleCollect {
  loadingKeys: string[];
  repoByKey: Map<string, TrendRepo>;
}

/** settle 超时输入收集：仍 loading（未具平台 + 未确认）的未收录行。 */
function collectSettleLoading(
  rawItems: readonly DisplayTrendItemLiteExt[],
  enrichedApps: Record<string, AppSummary>,
  combinedConfirmed: ReadonlySet<string>,
): SettleCollect {
  const loadingSnapshot: string[] = [];
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
    loadingSnapshot.push(key);
  }
  return { loadingKeys: loadingSnapshot, repoByKey };
}

/** settle 超时仍 loading 过滤（timer 触发时按最新镜像 + 确认集复核）。 */
function filterStillLoading(
  loadingKeys: readonly string[],
  latestEnriched: Record<string, AppSummary>,
  globalConfirmed: ReadonlySet<string> | undefined,
  localConfirmed: ReadonlySet<string>,
): string[] {
  const stillLoading: string[] = [];
  for (const key of loadingKeys) {
    const cur = latestEnriched[key];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    const curKey = ((cur?.id || '') as string).trim().toLowerCase();
    if (globalConfirmed?.has(key) || localConfirmed.has(key)) continue;
    if (curKey !== '' && (globalConfirmed?.has(curKey) || localConfirmed.has(curKey))) continue;
    stillLoading.push(key);
  }
  return stillLoading;
}

/** 裸行合成最小 Other 摘要（与原内联合成逐字段一致；具平台不合成）。 */
function synthesizeSettleSummary(repo: TrendRepo): AppSummary | null {
  if (!repo.id || !repo.owner || !repo.repo) return null;
  const shortName = (repo.repo || repo.name || repo.id).trim() || repo.id;
  return {
    id: repo.id,
    name: shortName,
    owner: repo.owner,
    repo: repo.repo,
    icon: '',
    icon_bg: DEFAULT_ICON_BG,
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

interface SettleHydration {
  toHydrate: Record<string, AppSummary>;
  aliasKeys: string[];
}

/** 同 key hydrate 输入构建：`data:` 剥空由展示态 SSOT 裁决，裸行合成最小摘要。 */
function buildSettleHydration(
  stillLoading: readonly string[],
  latestEnriched: Record<string, AppSummary>,
  repoByKey: Map<string, TrendRepo>,
  allRepos: readonly TrendRepo[],
): SettleHydration {
  const toHydrate: Record<string, AppSummary> = {};
  const aliasKeys: string[] = [];
  for (const key of stillLoading) {
    const cur = latestEnriched[key];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    if (cur) {
      const curKey = ((cur.id || '') as string).trim().toLowerCase();
      aliasKeys.push(key);
      if (curKey !== '' && curKey !== key) aliasKeys.push(curKey);
      if (isDataIcon(cur.icon)) {
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

/** settle 确认提交：先 mark 再 hydrate（已确认 loading 方可进内存）。 */
function commitSettleConfirmed(aliasKeys: readonly string[], toHydrate: Record<string, AppSummary>): void {
  if (!aliasKeys || aliasKeys.length === 0) return;
  try {
    markTrendConfirmedOthers(aliasKeys);
    if (Object.keys(toHydrate).length > 0) {
      putTrendEnrichMemory(toHydrate);
    }
  } catch {
    // 标记失败仍尝试本地落定（调用方继续并镜像）
  }
}

/** settle 本地直展裸合成卡：镜像缺席的键一次并入（已有不重写）。 */
function mergeSettleSyntheticMirror(
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
function maybePersistSettleConfirmed(): void {
  const { cacheKey, cacheBoard, repos } = boardPersistRef;
  if (!cacheKey || repos.length === 0) return;
  try {
    void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  } catch {
    // 写透失败不影响内存落定
  }
}

/* ------------------------------------------------------------------ */
/* F. 治愈总线（2 路 window 事件 → 同一归一 upsert；图标经 icon-ready 走店内写口） */
/* ------------------------------------------------------------------ */

/** 治愈键归一（lower-trim 去空，与 enrich 键同源）。 */
function normalizeHealKeys(keys: unknown): string[] {
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
 * 平台治愈镜像合并：
 * 空 loading 行被具平台值替换并保留旧真实图标；已具平台行仅跟随非空图标；
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
      if (incomingIcon !== '' && cur.icon !== incomingIcon) {
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

/** 治愈行键匹配：镜像键或行 id 别名命中治愈键，且仍属本榜已知仓键。 */
function matchHealRowKey(
  mirrorKey: string,
  rowId: unknown,
  keySet: ReadonlySet<string>,
  repoKeys: ReadonlySet<string>,
): boolean {
  const alias = String(rowId ?? '').trim().toLowerCase();
  const lowerKey = mirrorKey.toLowerCase();
  if (!keySet.has(lowerKey) && (alias === '' || !keySet.has(alias))) return false;
  if (!repoKeys.has(lowerKey) && (alias === '' || !repoKeys.has(alias))) return false;
  return true;
}

/** 治愈行补丁：平台仅旧空时补，占位简介永不覆盖实值；无变更返回 null。 */
function patchHealRow(
  cur: AppSummary,
  dirtyFields: ReadonlySet<string>,
  summary: Record<string, unknown>,
  platforms: readonly string[] | undefined,
): AppSummary | null {
  const patched: AppSummary = { ...cur };
  let rowChanged = false;
  if ((!patched.platforms || patched.platforms.length === 0) && platforms && platforms.length > 0) {
    patched.platforms = [...platforms];
    rowChanged = true;
  }
  for (const f of dirtyFields) {
    const incoming = summary[f];
    if (incoming === undefined) continue;
    if (
      (f === 'description' || f === 'description_en') &&
      typeof incoming === 'string' &&
      isPlaceholderDescription(incoming)
    ) {
      continue;
    }
    if ((patched as unknown as Record<string, unknown>)[f] === incoming) continue;
    (patched as unknown as Record<string, unknown>)[f] = incoming as unknown;
    rowChanged = true;
  }
  return rowChanged ? patched : null;
}

/** 治愈行合成：预 enrich 行创建时剥图标通道与占位简介，平台取详情实值。 */
function synthesizeHealRow(summary: AppSummary, platforms: readonly string[] | undefined): AppSummary {
  const {
    icon: _dropIcon,
    icon_bg: _dropBg,
    platforms: _dropPlats,
    ...rest
  } = summary as unknown as AppSummary & Record<string, unknown>;
  void _dropIcon;
  void _dropBg;
  void _dropPlats;
  const restSummary = rest as unknown as AppSummary;
  return {
    ...restSummary,
    description:
      typeof restSummary.description === 'string' && isPlaceholderDescription(restSummary.description)
        ? ''
        : restSummary.description,
    description_en:
      typeof restSummary.description_en === 'string' &&
      isPlaceholderDescription(restSummary.description_en)
        ? ''
        : restSummary.description_en,
    icon: '',
    icon_bg: DEFAULT_ICON_BG,
    platforms: platforms && platforms.length > 0 ? [...platforms] : [],
  };
}

/**
 * 富卡治愈镜像合并：
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
  const hasMirrorHit = Object.keys(prev).some((k) => keySet.has(k.toLowerCase()));
  if (hitKeys.length === 0 && !hasMirrorHit) return prev;
  const summaryFields = payload.summary as unknown as Record<string, unknown>;
  let changed = false;
  const next = { ...prev };
  for (const k of Object.keys(prev)) {
    if (!matchHealRowKey(k, prev[k]?.id, keySet, repoKeys)) continue;
    const patched = patchHealRow(prev[k], dirtySet, summaryFields, payload.platforms);
    if (patched === null) continue;
    next[k] = patched;
    changed = true;
  }
  for (const k of hitKeys) {
    if (next[k]) continue;
    next[k] = synthesizeHealRow(payload.summary, payload.platforms);
    changed = true;
  }
  return changed ? next : prev;
}

/** 富卡治愈持久化：hydrate + 节流写透（`data:` 禁入由展示态 SSOT 与 hydrate 保证）。 */
export function maybePersistRichcardHeal(
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
        if (isDataIcon(created.icon)) continue;
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
    putTrendEnrichMemory(toHydrate);
    const { cacheKey } = boardPersistRef;
    if (!cacheKey) return;
    maybeScheduleBoardPersist(cacheKey);
  } catch {
    // 落盘失败不影响内存 merge
  }
}

interface TrendHealBusHandlers {
  onPlatformsHeal?: (
    payload: DetailPlatformsHealPayload,
    keys: string[],
  ) => void;
  onRichcardHeal?: (
    payload: DetailRichcardHealPayload,
    keys: string[],
  ) => void;
}

/**
 * 治愈总线统一订阅：2 路 window 事件经同一归一路径分发（图标经 `icon-ready → admitIconHit`，不走总线）。
 * 调用方只订一次；
 * key 归一（lower-trim 去空）。
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
  window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
  window.addEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
  return () => {
    window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
    window.removeEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
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
 * data:/未确认 loading/具平台覆盖等守卫仍由 enrich 侧执行。
 */
export function putBoardEnrichMemory(map: Record<string, AppSummary>): void {
  putTrendEnrichMemory(map);
}

/** 当前持久化榜键（供节流调度读取；快照经 noteBoardReposForPersist 同步）。 */
export function getBoardPersistKey(): string {
  return boardPersistRef.cacheKey;
}

/* ------------------------------------------------------------------ */
/* I. 趋势 loading 生命周期 hook（View 侧唯一编排出口）                 */
/* ------------------------------------------------------------------ */

interface TrendLoadingLifecycleParams {
  trendResult: TrendsResult | null;
  rawItems: readonly DisplayTrendItemLiteExt[];
  enrichedApps: Record<string, AppSummary>;
  activeBoard: TrendBoardId;
  trendFetchOpts: FetchTrendsOptions;
  /** 全局已确认集合；缺席时 lite/settle 不启用（调用方传空集合即启用）。 */
  globalConfirmed?: ReadonlySet<string>;
  /** 榜单内已确认集合（View 持有，hook 只读 + 经 setter 落定）。 */
  localConfirmed: ReadonlySet<string>;
  setEnrichedApps: React.Dispatch<React.SetStateAction<Record<string, AppSummary>>>;
  setTrendConfirmedOtherIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  fetchLite: LiteFetch;
}

/**
 * 趋势 loading 生命周期编排（lite 补验 + settle 超时 + 确认集并集）：
 * View 侧只调此 hook，不自持 inflight/seq/trusted/ref 镜像与两段 effect。
 * - inflight/seq 守卫与 15s settle 定时归深模块；合并/写透仍走本 board seam；
 * - 返回 `combinedConfirmed`（全局 ∪ 榜单内）供过滤/计数/徽标统一口径。
 */
export function useTrendLoadingLifecycle(
  params: TrendLoadingLifecycleParams,
): { combinedConfirmed: Set<string> } {
  const {
    trendResult,
    rawItems,
    enrichedApps,
    activeBoard,
    trendFetchOpts,
    globalConfirmed,
    localConfirmed,
    setEnrichedApps,
    setTrendConfirmedOtherIds,
    fetchLite,
  } = params;
  const inflightGuardRef = React.useRef<InflightGuard | null>(null);
  if (!inflightGuardRef.current) inflightGuardRef.current = createInflightGuard();
  const boardSeqRef = React.useRef(0);
  const seqGuardRef = React.useRef<SeqGuard | null>(null);
  if (!seqGuardRef.current) seqGuardRef.current = createSeqGuard(() => boardSeqRef.current);
  const enrichedAppsRef = React.useRef(enrichedApps);
  enrichedAppsRef.current = enrichedApps;
  const globalConfirmedRef = React.useRef(globalConfirmed);
  globalConfirmedRef.current = globalConfirmed;
  const localConfirmedRef = React.useRef(localConfirmed);
  localConfirmedRef.current = localConfirmed;
  const fetchLiteRef = React.useRef(fetchLite);
  fetchLiteRef.current = fetchLite;

  // 全局已确认 ∪ 榜单内已确认：loading 判定的唯一口径（未传入全局集合时不启用）。
  const combinedConfirmed = React.useMemo(
    () => unionConfirmedSets(globalConfirmed, localConfirmed),
    [globalConfirmed, localConfirmed],
  );

  // 榜缓存二级新鲜富卡免验集：SWR-fill 时内存快照已有的具平台键（二级新鲜期内直接展，不调 lite）；
  // 后续 enrich 新取回的键不在集内，缺席/过期仍走 lite 补验（到期再验）。
  const trusted = React.useMemo(() => {
    if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) return new Set<string>();
    return buildSwrFill(trendResult.repos).trustedConcrete;
  }, [trendResult]);

  // 榜单切换即递增 lite 序列：旧榜在途 lite 落定不再写入，避免跨榜串扰。
  React.useEffect(() => {
    boardSeqRef.current += 1;
  }, [activeBoard, trendResult]);

  // 未收录行 lite 确认（App lazyBackfill 的榜单侧补齐，分批 5/上限 20/seq 守卫）：
  // enrich 落定为空的行按 App 同口径走 getPlatformsLite 轻量通道：
  // 非空非 stale 即 patch 治愈并经 board seam 写透；空非 stale 即确认 Other 并写透，重挂免验；
  // stale/失败保持 loading 交给 settle 超时（不覆盖具平台）。
  React.useEffect(() => {
    if (trendResult?.status !== 'ok') return;
    if (globalConfirmed === undefined) return;
    const guard = seqGuardRef.current;
    const inflight = inflightGuardRef.current;
    if (!guard || !inflight) return;
    const seq = guard.capture();
    const sel = selectLiteTargets({
      rawItems,
      enrichedApps,
      combinedConfirmed,
      inflight: inflight.snapshot(),
      trusted,
    });
    logLiteSkip(activeBoard, sel);
    const { targets } = sel;
    if (targets.length === 0) return;
    const claimed = new Set(inflight.take(targets.map((t) => t.key)));
    const runTargets = targets.filter((t) => claimed.has(t.key));
    if (runTargets.length === 0) return;
    void (async () => {
      try {
        const { patched, confirmedEmpty } = await verifyLoadingLite(
          runTargets,
          (liteId) => fetchLiteRef.current(liteId),
          () => guard.isStale(seq),
        );
        if (guard.isStale(seq)) return;
        if (patched.size > 0) {
          // 具平台升级先清确认（本地 + board 内存标记，防确认残留；hydrate 具平台侧亦会自动移除同键）。
          {
            const aliasKeys = collectUnmarkAliasKeys(patched.keys(), enrichedAppsRef.current);
            if (aliasKeys.length > 0) unmarkConcreteKeys(aliasKeys);
          }
          setEnrichedApps((prev) => mergeLitePatchedMirror(prev, patched));
          setTrendConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, [...patched.keys()]));
          // 经 board seam 持久化（hydrate + 同榜 key 写透；stale/失败不进 patched，保持 loading）。
          try {
            await maybePersistLitePatched(patched, enrichedAppsRef.current);
          } catch {
            // 写透失败不影响内存落定，loading 语义不变
          }
        }
        if (confirmedEmpty.length > 0) {
          // 空非 stale 即已确认 Other：经 board seam（本地 + 内存标记 + hydrate + 写透）。
          const aliasConfirmed = await confirmLiteEmpty(confirmedEmpty, enrichedAppsRef.current);
          if (aliasConfirmed.length > 0) {
            setTrendConfirmedOtherIds((prev) => addConfirmedMirror(prev, aliasConfirmed));
          }
        }
      } finally {
        inflight.release(runTargets.map((t) => t.key));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendResult, rawItems, enrichedApps, globalConfirmed, combinedConfirmed, activeBoard, trendFetchOpts]);

  // loading settle 超时：enrich 空 + 一次 lite 仍未治愈（或 lite stale/失败/裸行）
  // 至多等待 15s 后降级为已确认 Other（徽标 + 计数 + 可过滤），而非无限 shimmer。
  // 超时前仍恒可见（不看 Other 勾选），落定后走正常 Other 过滤。定时归深模块所有。
  React.useEffect(() => {
    if (globalConfirmed === undefined) return;
    if (trendResult?.status !== 'ok') return;
    const { loadingKeys, repoByKey } = collectSettleLoading(rawItems, enrichedApps, combinedConfirmed);
    if (loadingKeys.length === 0) return;
    const repos = trendResult.repos;
    return scheduleSettleConfirm({
      keys: loadingKeys,
      recheck: (snapshot) =>
        filterStillLoading(
          snapshot,
          enrichedAppsRef.current,
          globalConfirmedRef.current,
          localConfirmedRef.current,
        ),
      onConfirm: (stillLoading) => {
        const { toHydrate, aliasKeys } = buildSettleHydration(
          stillLoading,
          enrichedAppsRef.current,
          repoByKey,
          repos,
        );
        if (aliasKeys.length === 0) return;
        // 先 mark 再 hydrate：已确认 loading 方可进 board 内存（未确认 loading 永不进内存/落库）。
        commitSettleConfirmed(aliasKeys, toHydrate);
        setTrendConfirmedOtherIds((prev) =>
          addConfirmedMirror(
            prev,
            aliasKeys.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0),
          ),
        );
        // 本地直展裸合成卡：镜像缺席的键一次并入（具平台不覆盖，已有不重写）。
        if (Object.keys(toHydrate).length > 0) {
          setEnrichedApps((prev) => mergeSettleSyntheticMirror(prev, toHydrate));
        }
        // 确认写透：经 board seam 同榜 key 落盘（含确认集），重挂零 lite 直展 Other 卡。
        maybePersistSettleConfirmed();
      },
    });
  }, [trendResult, rawItems, enrichedApps, globalConfirmed, combinedConfirmed, activeBoard, trendFetchOpts]);

  return { combinedConfirmed };
}
