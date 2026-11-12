/**
 * 趋势榜单深模块（trend-board vertical slice）。
 *
 * 合并抓榜数据源（trending HTML / doforce / GitHub Search）、L1/L2 缓存读写、
 * SWR-fill、DB 确认图标回填、enrich 批处理、lite 补验、15s settle 兜底、
 * 详情治愈总线（detail-platforms / detail-richcard）、`icon-ready` 流式图标与
 * 防抖 L2 写透于单一 `TrendBoardSession` 控制器。
 *
 * 约束（ADR-0011 / ADR-0014+D9）：
 * - doforce 仅 rising/healthy，经 fetch_trends_text 单飞 12h 共享；429 至多单次重试。
 * - L1 daily 1h / weekly-monthly-new 12h / 其余 5min；L2 daily 1h / 其余 12h + 0-30s 抖动扣减。
 * - FE 256KB 预检降级 + BE 512KiB 硬拒绝；data:/未确认 loading 永不落盘。
 */

import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo, TrendsResult } from '../../types';
import { tauriApi } from '../api';
import {
  admitIconHit,
  patchIconMirror,
  queueAssembledRowIcons,
  resolveIconWithBuffer,
  subscribeIconWrites,
} from '../iconStore';
import {
  createInflightGuard,
  createSeqGuard,
  runLiteBatch,
  scheduleSettleConfirm,
  unionConfirmedSets,
  type LiteFetch,
  type LoadingLiteTarget,
} from '../../lib/platformFilter';
import { zlogInfo, zlogWarn } from '../../lib/z-log';
import { DEFAULT_ICON_BG } from '../../styles/tokens';
import {
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  getDbTrendCache,
  getDoforceInflight,
  isDataIcon,
  isMissingIconForDisplay,
  isPersistableIcon,
  readDoforceShared,
  readTrendsCache,
  saveBoardCacheMerged,
  setDoforceInflight,
  sweepExpiredTrendsCache,
  writeDoforceShared,
  writeTrendsCache,
} from './cache';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  enrichTrendRepos,
  isPlaceholderDescription,
  markConfirmedOthersFreshNow,
  markTrendConfirmedOthers,
  putTrendEnrichMemory,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
  subscribeTrendConfirmedOtherChanges,
  sweepExpiredTrendEnrichCache,
  unmarkTrendConfirmedOthers,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
} from './enrich';
import {
  classifyTrendsError,
  compareStarsGainedDesc,
  doforceRetryDelayMs,
  errorStatusOf,
  mapDoforceItem,
  mapGitHubSearchItem,
  parseTrendingHtml,
  sortByHealthyScore,
} from './parse';

/* ------------------------------------------------------------------ */
/* A. 榜单定义、数据源抓取与 L1/L2 缓存读取                           */
/* ------------------------------------------------------------------ */

type TimeBoardId = 'daily' | 'weekly' | 'monthly';
type TrendGainKey = 'today' | 'week' | 'month';

/** Board → trending `?since=` 参数的单一映射（SSOT）。 */
const TRENDING_SINCE: Record<TimeBoardId, 'daily' | 'weekly' | 'monthly'> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

/** 当前合法 6 榜全集。 */
export const TREND_BOARD_IDS: readonly TrendBoardId[] = [
  'daily',
  'weekly',
  'monthly',
  'new',
  'rising',
  'healthy',
];

const BOARD_GAIN_KEY: Record<TrendBoardId, TrendGainKey> = {
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
  new: 'week',
  rising: 'week',
  healthy: 'week',
};

const DOFORCE_URL = 'https://trend.doforce.dpdns.org/repo';

/** gain 文案口径查询（BOARD_GAIN_KEY 的唯一出口）。 */
export function boardGainKey(board: TrendBoardId): TrendGainKey {
  return BOARD_GAIN_KEY[board];
}

function isTimeBoard(board: string): board is TimeBoardId {
  return board in TRENDING_SINCE;
}

/** 榜单名校验：仅接受当前合法 6 榜；非法输入返回 undefined（调用方拒绝）。 */
export function resolveTrendBoard(board: string): TrendBoardId | undefined {
  if (!(TREND_BOARD_IDS as readonly string[]).includes(board)) {
    return undefined;
  }
  return board as TrendBoardId;
}

/** 构造 trending 抓取 URL（language 走 `/trending/<lang>` 路径段，始终直连）。 */
function buildTrendingUrl(board: TimeBoardId, opts: FetchTrendsOptions = {}): string {
  const since = TRENDING_SINCE[board];
  const lang = opts.language?.trim();
  return lang && lang.toLowerCase() !== 'all'
    ? `https://github.com/trending/${encodeURIComponent(lang)}?since=${since}`
    : `https://github.com/trending?since=${since}`;
}

/** daily/weekly/monthly 主源：trending HTML（Rust 侧抓取，10s 超时）。 */
async function fetchTrendingRepos(
  board: TimeBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendRepo[]> {
  const html = await tauriApi.fetchTrendsText(buildTrendingUrl(board, opts));
  return parseTrendingHtml(html);
}

/** 构建 doforce 请求 URL（始终直连，单一出口）。 */
function buildDoforceUrl(): string {
  return DOFORCE_URL;
}

/** doforce 主源：支持纯数组或 `{items|data|repos}` 包装结构。 */
async function fetchDoforceRepos(): Promise<TrendRepo[]> {
  const text = await tauriApi.fetchTrendsText(buildDoforceUrl());
  const json: unknown = JSON.parse(text);
  const items = Array.isArray(json)
    ? json
    : (json as Record<string, unknown>)?.items ??
      (json as Record<string, unknown>)?.data ??
      (json as Record<string, unknown>)?.repos;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .map((it: Record<string, unknown>) => mapDoforceItem(it))
    .filter((item): item is TrendRepo => item !== null);
}

/** new 榜主源：GitHub Search（created:>6个月）。 */
async function fetchGitHubNewRepos(): Promise<TrendRepo[]> {
  const since = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url =
    `https://api.github.com/search/repositories` +
    `?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=20`;

  const text = await tauriApi.fetchTrendsText(url);
  const json: unknown = JSON.parse(text);
  const items = (json as Record<string, unknown>)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .map((it: Record<string, unknown>) => mapGitHubSearchItem(it))
    .filter((item): item is TrendRepo => item !== null);
}

async function runBoardFetch(
  board: TrendBoardId,
  source: string,
  load: () => Promise<TrendRepo[]>,
): Promise<TrendsResult> {
  try {
    const repos = await load();
    if (repos.length === 0) return { repos: [], status: 'empty', stale: false };
    zlogInfo(`[trends] board=${board} source=${source} ok count=${repos.length}`);
    return { repos, status: 'ok', stale: false };
  } catch (err) {
    const errorKind = classifyTrendsError(err);
    zlogWarn(
      `[trends] board=${board} source=${source} error kind=${errorKind} ` +
        `status=${errorStatusOf(err) ?? '-'} msg=${String((err as { message?: unknown })?.message ?? err)}`,
    );
    return { repos: [], status: 'error', errorKind, stale: false };
  }
}

type BoardHydratedListener = (board: string, key: string) => void;
const boardHydratedListeners = new Set<BoardHydratedListener>();

/** board 就绪订阅口：L1/L2/网络三路径统一 emit（对称就绪）。 */
export function subscribeBoardHydrated(fn: BoardHydratedListener): () => void {
  boardHydratedListeners.add(fn);
  return () => {
    boardHydratedListeners.delete(fn);
  };
}

function emitBoardHydrated(board: string, key: string): void {
  if (boardHydratedListeners.size === 0) return;
  for (const fn of [...boardHydratedListeners]) {
    try {
      fn(board, key);
    } catch {
      // 订阅失败不影响榜单返回
    }
  }
}

function l2HitLog(board: string, key: string, dbHit: TrendRepo[]): void {
  const enrich = (dbHit as { enrich?: Record<string, unknown> }).enrich;
  const hasEnrich = !!enrich && typeof enrich === 'object';
  const enrichCount = hasEnrich ? Object.keys(enrich as Record<string, unknown>).length : 0;
  zlogInfo(
    `[trends] board=${board} L2-cache hit key=${key} hasEnrich=${hasEnrich} ` +
      `enrichCount=${enrichCount} reposCount=${dbHit.length}`,
  );
}

function hydrateBoardDbHit(dbHit: TrendRepo[]): void {
  const enrich = (dbHit as { enrich?: Record<string, AppSummary> }).enrich;
  if (enrich) putTrendEnrichMemory(enrich);
  const confirmed = (dbHit as { confirmedOther?: unknown }).confirmedOther;
  if (Array.isArray(confirmed)) markConfirmedOthersFreshNow(confirmed);
}

async function fetchBoardWithL2(
  board: TrendBoardId,
  key: string,
  load: () => Promise<TrendsResult>,
  opts: FetchTrendsOptions = {},
): Promise<TrendsResult> {
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key, board);
    if (hit) {
      emitBoardHydrated(board, key);
      return { repos: hit, status: 'ok', stale: false };
    }

    const dbHit = await getDbTrendCache(key, board);
    if (dbHit && dbHit.length > 0) {
      hydrateBoardDbHit(dbHit);
      writeTrendsCache(key, dbHit);
      l2HitLog(board, key, dbHit);
      emitBoardHydrated(board, key);
      return { repos: dbHit, status: 'ok', stale: false };
    }
  }

  const result = await load();
  if (result.status === 'ok') {
    writeTrendsCache(key, result.repos);
    await saveBoardCacheMerged(key, board, result.repos);
    emitBoardHydrated(board, key);
    return result;
  }
  if (result.status === 'error') {
    const staleHit = await getDbTrendCache(key, board, { allowStale: true });
    if (staleHit && staleHit.length > 0) {
      hydrateBoardDbHit(staleHit);
      writeTrendsCache(key, staleHit);
      l2HitLog(board, key, staleHit);
      emitBoardHydrated(board, key);
      return { repos: staleHit, status: 'ok', stale: true };
    }
  }
  return result;
}

async function fetchTimeBoardResult(board: TimeBoardId, opts: FetchTrendsOptions): Promise<TrendsResult> {
  const key = buildTrendsCacheKey(board, opts);
  return fetchBoardWithL2(
    board,
    key,
    () => runBoardFetch(board, 'trending-html', () => fetchTrendingRepos(board, opts)),
    opts,
  );
}

async function fetchNewBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  const key = buildTrendsCacheKey('new', opts);
  return fetchBoardWithL2(
    'new',
    key,
    () => runBoardFetch('new', 'github-search', () => fetchGitHubNewRepos()),
    opts,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchDoforceWithRetry(): Promise<TrendRepo[]> {
  try {
    return await fetchDoforceRepos();
  } catch (err) {
    if (classifyTrendsError(err) !== 'rate-limited') throw err;
    const wait = doforceRetryDelayMs(err);
    if (wait === undefined) throw err;
    zlogWarn(`[trends] doforce 429 single retry after ${wait}ms`);
    await sleep(wait);
    return fetchDoforceRepos();
  }
}

async function fetchDoforceShared(opts: FetchTrendsOptions = {}): Promise<TrendRepo[]> {
  const forceRefresh = opts.forceRefresh;
  const key = buildDoforceCacheKey(opts);
  if (!forceRefresh) {
    const hit = readDoforceShared();
    if (hit) {
      zlogInfo('[trends] doforce shared-cache hit');
      emitBoardHydrated('doforce', key);
      return hit;
    }
    const inflight = getDoforceInflight();
    if (inflight) {
      zlogInfo('[trends] doforce single-flight shared-hit');
      return inflight;
    }
  }
  const slot: { current?: Promise<TrendRepo[]> } = {};
  slot.current = (async (): Promise<TrendRepo[]> => {
    try {
      if (!forceRefresh) {
        const dbHit = await getDbTrendCache(key, 'doforce');
        if (dbHit && dbHit.length > 0) {
          hydrateBoardDbHit(dbHit);
          writeDoforceShared(dbHit);
          l2HitLog('doforce', key, dbHit);
          emitBoardHydrated('doforce', key);
          return dbHit;
        }
      }

      try {
        const repos = await fetchDoforceWithRetry();
        if (repos.length > 0) {
          writeDoforceShared(repos);
          await saveBoardCacheMerged(key, 'doforce', repos);
          emitBoardHydrated('doforce', key);
        }
        return repos;
      } catch (err) {
        const staleHit = await getDbTrendCache(key, 'doforce', { allowStale: true });
        if (staleHit && staleHit.length > 0) {
          hydrateBoardDbHit(staleHit);
          writeDoforceShared(staleHit);
          emitBoardHydrated('doforce', key);
          return staleHit;
        }
        throw err;
      }
    } finally {
      if (getDoforceInflight() === slot.current) setDoforceInflight(undefined);
    }
  })();
  setDoforceInflight(slot.current);
  return slot.current;
}

async function fetchRisingBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  return runBoardFetch('rising', 'doforce', async () => {
    const repos = await fetchDoforceShared(opts);
    if (repos.length === 0) return [];
    return [...repos].sort(compareStarsGainedDesc);
  });
}

async function fetchHealthyBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  return runBoardFetch('healthy', 'doforce', async () => {
    const repos = await fetchDoforceShared(opts);
    if (repos.length === 0) return [];
    return sortByHealthyScore(repos);
  });
}

const STATIC_BOARD_FETCHERS: Record<string, (opts: FetchTrendsOptions) => Promise<TrendsResult>> = {
  new: fetchNewBoardResult,
  rising: fetchRisingBoardResult,
  healthy: fetchHealthyBoardResult,
};

/** 趋势榜单唯一抓取入口（L1/L2/网络三路径对称 emit `subscribeBoardHydrated`）。 */
export async function fetchTrendsResult(
  board: TrendBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendsResult> {
  sweepExpiredTrendsCache();
  sweepExpiredTrendEnrichCache();
  if (isTimeBoard(board)) {
    return fetchTimeBoardResult(board, opts);
  }
  const fetcher = STATIC_BOARD_FETCHERS[board];
  if (fetcher) return fetcher(opts);
  throw new Error(`[trends] unknown board: ${String(board)}`);
}

/* ------------------------------------------------------------------ */
/* B. 模块内部持久化、镜像合并、lite 补验、settle 与治愈总线         */
/* ------------------------------------------------------------------ */

interface BoardCacheRef {
  cacheKey: string;
  cacheBoard: TrendBoardId | 'doforce';
  repos: TrendRepo[];
}

function resolveBoardCacheKey(
  board: TrendBoardId,
  opts: FetchTrendsOptions = {},
): { cacheKey: string; cacheBoard: TrendBoardId | 'doforce' } {
  if (board === 'rising' || board === 'healthy') {
    return { cacheKey: buildDoforceCacheKey(opts), cacheBoard: 'doforce' };
  }
  return { cacheKey: buildTrendsCacheKey(board, opts), cacheBoard: board };
}

/** 供跨页详情治愈复用最近展示榜单坐标（TrendsView 卸载后仍可触发二级缓存写透）。 */
let lastDetailHealBoardRef: BoardCacheRef = { cacheKey: '', cacheBoard: 'weekly', repos: [] };
let detailHealTimer: ReturnType<typeof setTimeout> | null = null;

function flushBoardRef(ref: BoardCacheRef, latest?: Record<string, AppSummary>): void {
  try {
    if (latest && typeof latest === 'object' && Object.keys(latest).length > 0) {
      putTrendEnrichMemory(latest);
    }
  } catch {
    // hydrate 失败不阻塞落盘
  }
  const { cacheKey, cacheBoard, repos } = ref;
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

function boardRepoKeys(repos: readonly TrendRepo[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of repos ?? []) {
    if (r.id) out.add(r.id.trim().toLowerCase());
    if (r.owner && r.repo) out.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
  }
  return out;
}

/**
 * 详情更新写透榜单二级缓存（即使 `TrendsView` 当前未挂载）：
 * 若最近加载过的榜单包含该应用，调度节流写盘将最新 `trendEnrichCache` 快照持久化至 SQLite `trend_board_cache`。
 */
export function persistBoardCacheFromDetailIfPresent(keys: readonly string[]): void {
  const { cacheKey, cacheBoard, repos } = lastDetailHealBoardRef;
  if (!cacheKey || !Array.isArray(repos) || repos.length === 0) return;
  const repoKeys = boardRepoKeys(repos);
  const hit = keys.some((k) => repoKeys.has(String(k ?? '').trim().toLowerCase()));
  if (!hit) return;
  if (detailHealTimer) clearTimeout(detailHealTimer);
  detailHealTimer = setTimeout(() => {
    detailHealTimer = null;
    void saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  }, 800);
}

interface SwrFill {
  snap: Record<string, AppSummary>;
  trustedConcrete: Set<string>;
  l2Confirmed: string[];
}

function buildSwrFill(repos: TrendRepo[]): SwrFill {
  const snap = snapshotTrendEnrichCache(repos);
  const trustedConcrete = new Set(
    Object.entries(snap)
      .filter(([, v]) => !!v.platforms && v.platforms.length > 0)
      .map(([k]) => k),
  );
  const l2Confirmed = snapshotTrendConfirmedOthers(repos);
  return { snap, trustedConcrete, l2Confirmed };
}

function mergeSwrEnrichedMirror(
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
    const mergedIcon = resolveIconWithBuffer(cur, v);
    if (mergedIcon.icon !== cur.icon) {
      next[k] = mergedIcon;
      changed = true;
    }
  }
  return changed ? next : prev;
}

function mergeSwrConfirmedMirror(
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

function collectEmptyIconKeys(mirror: Record<string, AppSummary>, cap = 200): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(mirror ?? {})) {
    if (out.length >= cap) break;
    const nk = String(k).trim().toLowerCase();
    if (!nk || seen.has(nk)) continue;
    seen.add(nk);
    if (isMissingIconForDisplay(mirror[k]?.icon)) out.push(nk);
  }
  return out;
}

function mergeDbIconsIntoMirror(
  prev: Record<string, AppSummary>,
  icons: ReadonlyMap<string, string>,
): { next: Record<string, AppSummary>; patchedKeys: string[] } {
  if (icons.size === 0) return { next: prev, patchedKeys: [] };
  const byKey = new Map<string, string>();
  for (const [rawK, rawIcon] of icons.entries()) {
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
    if (typeof hit !== 'string' || hit.trim() === '' || cur.icon === hit) continue;
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
    if (!admitted || admitted.trim() === '' || cur.icon === admitted) continue;
    next[k] = { ...cur, icon: admitted };
    changed = true;
    patchedKeys.push(k);
  }
  return { next: changed ? next : prev, patchedKeys };
}

/** 趋势可见行（catalog 富卡 / 未收录裸行）：enrich 编排与过滤共用形状。 */
export type DisplayTrendItem =
  | { type: 'catalog'; app: AppSummary; gain?: number }
  | { type: 'uncataloged'; repo: TrendRepo; gain?: number };

function collectMissingEnrichRepos(
  items: readonly DisplayTrendItem[],
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

function mergeEnrichFoundMirror(
  prev: Record<string, AppSummary>,
  found: Map<string, AppSummary>,
): { next: Record<string, AppSummary>; hasNewEnrich: boolean; concreteKeys: string[] } {
  let changed = false;
  let hasNewEnrich = false;
  const concreteKeys: string[] = [];
  const next = { ...prev };
  for (const [key, app] of found) {
    const prevApp = next[key] ?? prev[key];
    const incomingEmpty = !app.platforms || app.platforms.length === 0;
    const prevHasPlatforms = !!prevApp?.platforms && prevApp.platforms.length > 0;
    if (incomingEmpty && prevHasPlatforms) continue;
    const mergedApp = resolveIconWithBuffer(prevApp, app);
    if (next[key] !== mergedApp) {
      next[key] = mergedApp;
      changed = true;
      if (!prevHasPlatforms) hasNewEnrich = true;
    }
    if (!incomingEmpty) concreteKeys.push(key);
  }
  return { next: changed ? next : prev, hasNewEnrich, concreteKeys };
}

function removeConfirmedForConcrete(
  prev: Set<string>,
  concreteKeys: readonly string[],
): Set<string> {
  if (!concreteKeys || concreteKeys.length === 0) return prev;
  if (!concreteKeys.some((k) => prev.has(k))) return prev;
  const next = new Set(prev);
  for (const k of concreteKeys) next.delete(k);
  return next;
}

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

function selectLiteTargets(input: {
  rawItems: readonly DisplayTrendItem[];
  enrichedApps: Record<string, AppSummary>;
  combinedConfirmed: ReadonlySet<string>;
  inflight: ReadonlySet<string>;
  trusted: ReadonlySet<string>;
}): {
  targets: LoadingLiteTarget[];
  trustedConcrete: number;
  trustedLoading: number;
  skipped: number;
} {
  const { rawItems, enrichedApps, combinedConfirmed, inflight, trusted } = input;
  let freshSnap: Record<string, AppSummary> | null = null;
  const isFreshConcreteTrusted = (k: string): boolean => {
    if (!trusted.has(k)) return false;
    if (!freshSnap) {
      const boardRepos: TrendRepo[] = [];
      for (const item of rawItems) {
        if (item.type === 'uncataloged') boardRepos.push(item.repo);
      }
      freshSnap = snapshotTrendEnrichCache(boardRepos);
    }
    const hit = freshSnap[k];
    return !!hit?.platforms && hit.platforms.length > 0;
  };
  const targets: LoadingLiteTarget[] = [];
  let trustedLoading = 0;
  let uncatalogedTotal = 0;
  for (const item of rawItems) {
    if (item.type !== 'uncataloged') continue;
    const key = (item.repo.id || '').trim().toLowerCase();
    if (!key) continue;
    uncatalogedTotal += 1;
    const enriched = enrichedApps[key];
    if (!enriched) continue;
    if (enriched.platforms && enriched.platforms.length > 0) continue;
    const enrichedKey = (enriched.id || '').trim().toLowerCase();
    if (
      combinedConfirmed.has(key) ||
      (enrichedKey !== '' && combinedConfirmed.has(enrichedKey))
    ) {
      continue;
    }
    trustedLoading += 1;
    if (targets.length >= 20) continue;
    if (inflight.has(key)) continue;
    if (isFreshConcreteTrusted(key) || (enrichedKey !== '' && isFreshConcreteTrusted(enrichedKey))) {
      continue;
    }
    const liteId = (enriched.id || '').trim() || (item.repo.id || '').trim();
    if (!liteId) continue;
    targets.push({ key, liteId });
  }
  return {
    targets,
    trustedConcrete: trusted.size,
    trustedLoading,
    skipped: uncatalogedTotal - targets.length,
  };
}

function mergeLitePatchedMirror(
  prev: Record<string, AppSummary>,
  patched: Map<string, string[]>,
): Record<string, AppSummary> {
  let changed = false;
  const next = { ...prev };
  for (const [k, plats] of patched) {
    const cur = next[k] ?? prev[k];
    if (!cur || (cur.platforms && cur.platforms.length > 0)) continue;
    next[k] = { ...cur, platforms: [...plats] };
    changed = true;
  }
  return changed ? next : prev;
}

async function maybePersistLitePatched(
  patched: Map<string, string[]>,
  latest: Record<string, AppSummary>,
  boardRef: BoardCacheRef,
): Promise<void> {
  const toHydrate: Record<string, AppSummary> = {};
  for (const [k, plats] of patched) {
    const normKey = String(k).trim().toLowerCase();
    if (!normKey) continue;
    const cur = latest[normKey];
    if (!cur || (cur.platforms && cur.platforms.length > 0)) continue;
    const icon = isDataIcon(cur.icon) ? '' : cur.icon;
    toHydrate[normKey] = { ...cur, icon, platforms: [...plats] };
  }
  if (Object.keys(toHydrate).length === 0) return;
  putTrendEnrichMemory(toHydrate);
  const { cacheKey, cacheBoard, repos } = boardRef;
  if (cacheKey && repos.length > 0) {
    await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
  }
}

async function confirmLiteEmpty(
  confirmedEmpty: readonly string[],
  latest: Record<string, AppSummary>,
  boardRef: BoardCacheRef,
): Promise<string[]> {
  const aliasConfirmed: string[] = [];
  for (const raw of confirmedEmpty) {
    const k = String(raw).trim().toLowerCase();
    if (!k) continue;
    const cur = latest[k];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    aliasConfirmed.push(k);
    const alias = (cur?.id || '').trim().toLowerCase();
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
      if (!cur || (cur.platforms && cur.platforms.length > 0)) continue;
      toHydrate[k] = isDataIcon(cur.icon) ? { ...cur, icon: '' } : cur;
    }
    if (Object.keys(toHydrate).length > 0) {
      putTrendEnrichMemory(toHydrate);
    }
  } catch {
    // hydrate 失败不影响确认标记
  }
  const { cacheKey, cacheBoard, repos } = boardRef;
  if (aliasConfirmed.length > 0 && repos.length > 0 && cacheKey) {
    try {
      await saveBoardCacheMerged(cacheKey, cacheBoard, repos);
    } catch {
      // 写透失败不影响内存落定
    }
  }
  return aliasConfirmed;
}

function collectSettleLoading(
  rawItems: readonly DisplayTrendItem[],
  enrichedApps: Record<string, AppSummary>,
  combinedConfirmed: ReadonlySet<string>,
): { loadingKeys: string[]; repoByKey: Map<string, TrendRepo> } {
  const loadingKeys: string[] = [];
  const repoByKey = new Map<string, TrendRepo>();
  for (const item of rawItems) {
    if (item.type !== 'uncataloged') continue;
    const key = (item.repo.id || '').trim().toLowerCase();
    if (!key) continue;
    if (!repoByKey.has(key)) repoByKey.set(key, item.repo);
    const enriched = enrichedApps[key];
    if (enriched?.platforms && enriched.platforms.length > 0) continue;
    const enrichedKey = (enriched?.id || '').trim().toLowerCase();
    if (
      combinedConfirmed.has(key) ||
      (enrichedKey !== '' && combinedConfirmed.has(enrichedKey))
    ) {
      continue;
    }
    loadingKeys.push(key);
  }
  return { loadingKeys, repoByKey };
}

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
    const curKey = (cur?.id || '').trim().toLowerCase();
    if (globalConfirmed?.has(key) || localConfirmed.has(key)) continue;
    if (curKey !== '' && (globalConfirmed?.has(curKey) || localConfirmed.has(curKey))) continue;
    stillLoading.push(key);
  }
  return stillLoading;
}

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

function buildSettleHydration(
  stillLoading: readonly string[],
  latestEnriched: Record<string, AppSummary>,
  repoByKey: Map<string, TrendRepo>,
  allRepos: readonly TrendRepo[],
): { toHydrate: Record<string, AppSummary>; aliasKeys: string[] } {
  const toHydrate: Record<string, AppSummary> = {};
  const aliasKeys: string[] = [];
  for (const key of stillLoading) {
    const cur = latestEnriched[key];
    if (cur?.platforms && cur.platforms.length > 0) continue;
    if (cur) {
      const curKey = (cur.id || '').trim().toLowerCase();
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

function normalizeHealKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    const nk = String(k ?? '').trim().toLowerCase();
    if (nk) out.push(nk);
  }
  return out;
}

function applyPlatformsHealToMirror(
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

function applyRichcardHealToMirror(
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

function maybePersistRichcardHeal(
  latest: Record<string, AppSummary>,
  payload: DetailRichcardHealPayload,
  repoKeys: ReadonlySet<string>,
  boardRef: BoardCacheRef,
  schedulePersist: (cacheKey: string) => void,
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
    const { cacheKey } = boardRef;
    if (cacheKey) schedulePersist(cacheKey);
  } catch {
    // 落盘失败不影响内存 merge
  }
}

/* ------------------------------------------------------------------ */
/* C. TrendBoardSession 控制器（深模块唯一状态编排出口）              */
/* ------------------------------------------------------------------ */

export interface TrendMirrorState {
  enrichedApps: Record<string, AppSummary>;
  confirmedOtherIds: Set<string>;
}

export interface TrendBoardSessionOptions {
  initialEnrichedApps?: Record<string, AppSummary>;
}

export interface TrendBoardSession {
  getSnapshot(): TrendMirrorState;
  subscribe(listener: (state: TrendMirrorState) => void): () => void;
  start(): void;
  dispose(): void;
  syncBoard(params: {
    trendResult: TrendsResult | null;
    activeBoard: TrendBoardId;
    trendFetchOpts: FetchTrendsOptions;
  }): void;
  resetLoadingBoard(activeBoard: TrendBoardId, trendResult: TrendsResult | null): void;
  syncEnrichment(params: {
    trendResult: TrendsResult | null;
    activeBoard: TrendBoardId;
    trendFetchOpts: FetchTrendsOptions;
    displayItems: ReadonlyArray<DisplayTrendItem>;
    boardReady: boolean;
    consumeForceEnrich: () => boolean;
  }): void;
  syncLiteVerify(params: {
    trendResult: TrendsResult | null;
    rawItems: ReadonlyArray<DisplayTrendItem>;
    activeBoard: TrendBoardId;
    globalConfirmed?: ReadonlySet<string>;
    fetchLite: LiteFetch;
  }): void;
  scheduleSettle(params: {
    trendResult: TrendsResult | null;
    rawItems: ReadonlyArray<DisplayTrendItem>;
    globalConfirmed?: ReadonlySet<string>;
  }): () => void;
}

/**
 * 创建趋势榜会话控制器：收口 SWR 直展、DB 确认图标回填、enrich 批处理、
 * lite 补验、settle 超时、详情治愈总线、`icon-ready` 订阅与 L2 防抖写透。
 */
export function createTrendBoardSession(
  options: TrendBoardSessionOptions = {},
): TrendBoardSession {
  let enrichedApps: Record<string, AppSummary> =
    options.initialEnrichedApps ?? snapshotTrendEnrichCache();
  let confirmedOtherIds = new Set<string>();
  const listeners = new Set<(state: TrendMirrorState) => void>();

  let sessionEpoch = 0;
  let activeCleanups: Array<() => void> = [];
  let swrBackfillToken = 0;
  let lastSwrResult: TrendsResult | null = null;
  let currentActiveBoard: TrendBoardId = 'weekly';
  let currentTrendResult: TrendsResult | null = null;
  let latestGlobalConfirmed: ReadonlySet<string> | undefined;

  const attemptedEnrichKeys = new Set<string>();
  const enrichCycle: {
    trendResult: TrendsResult | null;
    activeBoard: TrendBoardId;
    seq: number;
  } = {
    trendResult: null,
    activeBoard: 'weekly',
    seq: 0,
  };

  let boardSeq = 0;
  const liteSeqGuard = createSeqGuard(() => boardSeq);
  const liteInflightGuard = createInflightGuard();
  let lastTrustedResult: TrendsResult | null = null;
  let trustedConcreteCache = new Set<string>();
  let sessionBoardRef: BoardCacheRef = { cacheKey: '', cacheBoard: 'weekly', repos: [] };
  const sessionPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleSessionPersist(cacheKey: string): void {
    if (!cacheKey) return;
    const pending = sessionPersistTimers.get(cacheKey);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      sessionPersistTimers.delete(cacheKey);
      const { cacheKey: key, cacheBoard, repos } = sessionBoardRef;
      if (!key || repos.length === 0) return;
      void saveBoardCacheMerged(key, cacheBoard, repos);
    }, 800);
    sessionPersistTimers.set(cacheKey, timer);
  }

  function flushSessionPersist(latest: Record<string, AppSummary>): void {
    for (const timer of sessionPersistTimers.values()) clearTimeout(timer);
    sessionPersistTimers.clear();
    flushBoardRef(sessionBoardRef, latest);
  }

  function getSnapshot(): TrendMirrorState {
    return { enrichedApps, confirmedOtherIds };
  }

  function notify(): void {
    const snap = getSnapshot();
    for (const fn of [...listeners]) {
      fn(snap);
    }
  }

  function updateEnrichedApps(
    updater:
      | Record<string, AppSummary>
      | ((prev: Record<string, AppSummary>) => Record<string, AppSummary>),
  ): void {
    const next = typeof updater === 'function' ? updater(enrichedApps) : updater;
    if (next === enrichedApps) return;
    enrichedApps = next;
    notify();
  }

  function updateConfirmedOtherIds(
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ): void {
    const next = typeof updater === 'function' ? updater(confirmedOtherIds) : updater;
    if (next === confirmedOtherIds) return;
    confirmedOtherIds = next;
    notify();
  }

  function getTrustedConcrete(trendResult: TrendsResult | null): Set<string> {
    if (lastTrustedResult !== trendResult) {
      lastTrustedResult = trendResult;
      trustedConcreteCache =
        trendResult?.status === 'ok' && trendResult.repos.length > 0
          ? buildSwrFill(trendResult.repos).trustedConcrete
          : new Set<string>();
    }
    return trustedConcreteCache;
  }

  function backfillDbIconsForEmptyKeys(emptyKeys: string[], isCancelled: () => boolean): void {
    if (emptyKeys.length === 0) return;
    void (async () => {
      let icons: (string | null)[];
      try {
        icons = await tauriApi.getConfirmedIconsBatch(emptyKeys);
      } catch {
        return;
      }
      if (isCancelled() || !Array.isArray(icons)) return;
      const iconMap = new Map<string, string>();
      emptyKeys.forEach((k, i) => {
        const icon = icons[i];
        if (typeof icon === 'string' && icon.trim() !== '') iconMap.set(k, icon);
      });
      if (iconMap.size === 0) return;
      const merged = mergeDbIconsIntoMirror(enrichedApps, iconMap);
      if (merged.patchedKeys.length === 0 || isCancelled()) return;
      updateEnrichedApps(merged.next);
      try {
        const toHydrate: Record<string, AppSummary> = {};
        for (const k of merged.patchedKeys) {
          const row = merged.next[k];
          if (row && isPersistableIcon(row.icon)) {
            toHydrate[k] = row;
          }
        }
        if (Object.keys(toHydrate).length > 0) {
          putTrendEnrichMemory(toHydrate);
          if (sessionBoardRef.cacheKey) scheduleSessionPersist(sessionBoardRef.cacheKey);
        }
      } catch {
        // 内存同步失败不影响已呈现
      }
    })();
  }

  function attachHealBus(): () => void {
    const onPlatforms = (e: Event): void => {
      const payload = (e as CustomEvent<DetailPlatformsHealPayload>).detail;
      if (!payload || !Array.isArray(payload.platforms) || payload.platforms.length === 0) return;
      if (!payload.summary || !Array.isArray(payload.keys) || payload.keys.length === 0) return;
      const keys = normalizeHealKeys(payload.keys);
      if (keys.length === 0) return;
      const repoKeys = boardRepoKeys(currentTrendResult?.repos);
      const next = applyPlatformsHealToMirror(
        enrichedApps,
        keys,
        payload.summary,
        payload.platforms,
        repoKeys,
      );
      updateEnrichedApps(next);
      updateConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, keys));
      unmarkTrendConfirmedOthers(keys);
      putTrendEnrichMemory(next);
      if (sessionBoardRef.cacheKey) scheduleSessionPersist(sessionBoardRef.cacheKey);
    };

    const onRichcard = (e: Event): void => {
      const payload = (e as CustomEvent<DetailRichcardHealPayload>).detail;
      if (!payload || !payload.summary || typeof payload.summary !== 'object') return;
      if (!Array.isArray(payload.keys) || payload.keys.length === 0) return;
      const hasDirty = Array.isArray(payload.dirtyFields) && payload.dirtyFields.length > 0;
      const hasPlats = Array.isArray(payload.platforms) && payload.platforms.length > 0;
      if (!hasDirty && !hasPlats && payload.confirmedOther !== true) return;
      const keys = normalizeHealKeys(payload.keys);
      if (keys.length === 0) return;
      const repoKeys = boardRepoKeys(currentTrendResult?.repos);
      const next = applyRichcardHealToMirror(enrichedApps, payload, repoKeys);
      updateEnrichedApps(next);
      maybePersistRichcardHeal(next, payload, repoKeys, sessionBoardRef, scheduleSessionPersist);
    };

    window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
    window.addEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
    return () => {
      window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatforms);
      window.removeEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRichcard);
    };
  }

  function attachStreamIconListener(startEpoch: number): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void tauriApi
      .onIconReady((payload) => {
        if (cancelled || sessionEpoch !== startEpoch) return;
        const raw = (payload ?? {}) as unknown as Record<string, unknown>;
        const ctx = (raw['context'] ?? null) as {
          kind: string;
          search_id?: string;
          board?: string;
          gen?: number;
        } | null;
        const kind = ctx && typeof ctx.kind === 'string' ? ctx.kind.trim().toLowerCase() : '';
        if (kind !== 'trend') return;
        const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        const res = admitIconHit({
          id: asStr(raw['id']),
          icon: asStr(raw['icon']),
          level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
          via: asStr(raw['via']),
          context: ctx,
          board: currentActiveBoard,
          getCurrentIcon: (tid) => enrichedApps[tid.toLowerCase()]?.icon,
          patch: (tid, icon) => {
            updateEnrichedApps((prev) => {
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
        try {
          const targets = res.targets ?? [];
          if (targets.length === 0) return;
          const toHydrate: Record<string, AppSummary> = {};
          for (const t of targets) {
            for (const k of Object.keys(enrichedApps)) {
              const cur = enrichedApps[k];
              if (!cur) continue;
              const alias = String(cur.id ?? '').trim().toLowerCase();
              if (k.toLowerCase() === t || (alias !== '' && alias === t)) {
                toHydrate[k] = { ...cur, icon: res.icon };
              }
            }
          }
          if (Object.keys(toHydrate).length === 0) return;
          putTrendEnrichMemory(toHydrate);
          if (sessionBoardRef.cacheKey) scheduleSessionPersist(sessionBoardRef.cacheKey);
        } catch {
          // 落盘失败不影响内存即时补齐
        }
      })
      .then((u) => {
        if (cancelled || sessionEpoch !== startEpoch) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch(() => {
        // 非 Tauri 环境无事件总线
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }

  return {
    getSnapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (activeCleanups.length > 0) return;
      const startEpoch = sessionEpoch;
      const onPageHide = (): void => {
        try {
          flushSessionPersist(enrichedApps);
        } catch {
          // 卸载兜底不抛错
        }
      };
      window.addEventListener('pagehide', onPageHide);
      const unsubPageHide = () => window.removeEventListener('pagehide', onPageHide);
      const unsubConfirmed = subscribeTrendConfirmedOtherChanges(() => {
        if (sessionBoardRef.cacheKey) scheduleSessionPersist(sessionBoardRef.cacheKey);
      });
      const unsubStreamIcons = attachStreamIconListener(startEpoch);
      const unsubHeal = attachHealBus();
      const unsubIconWrites = subscribeIconWrites(({ targets, icon }) => {
        let next = enrichedApps;
        for (const t of targets) {
          next = patchIconMirror(next, t, icon);
        }
        if (next !== enrichedApps) {
          updateEnrichedApps(next);
          if (typeof icon === 'string' && !icon.startsWith('data:')) {
            putTrendEnrichMemory(next);
            if (sessionBoardRef.cacheKey) scheduleSessionPersist(sessionBoardRef.cacheKey);
          }
        }
      });
      activeCleanups = [
        unsubConfirmed,
        unsubPageHide,
        unsubStreamIcons,
        unsubHeal,
        unsubIconWrites,
      ];
    },

    dispose() {
      sessionEpoch += 1;
      swrBackfillToken += 1;
      lastSwrResult = null;
      lastTrustedResult = null;
      trustedConcreteCache = new Set<string>();
      enrichCycle.trendResult = null;
      enrichCycle.seq += 1;
      attemptedEnrichKeys.clear();
      boardSeq += 1;
      const cleanups = activeCleanups;
      activeCleanups = [];
      for (const cleanup of cleanups) cleanup();
      try {
        flushSessionPersist(enrichedApps);
      } catch {
        // 卸载兜底不抛错
      }
    },

    syncBoard({ trendResult, activeBoard, trendFetchOpts }) {
      currentActiveBoard = activeBoard;
      currentTrendResult = trendResult;
      if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) {
        if (lastSwrResult !== trendResult) {
          lastSwrResult = trendResult;
          swrBackfillToken += 1;
        }
        return;
      }
      const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
      sessionBoardRef = { cacheKey, cacheBoard, repos: trendResult.repos };
      lastDetailHealBoardRef = sessionBoardRef;

      if (lastSwrResult === trendResult) return;
      lastSwrResult = trendResult;
      swrBackfillToken += 1;
      const myToken = swrBackfillToken;
      const myEpoch = sessionEpoch;

      const { snap, l2Confirmed } = buildSwrFill(trendResult.repos);
      if (l2Confirmed.length > 0) {
        updateConfirmedOtherIds((prev) => mergeSwrConfirmedMirror(prev, l2Confirmed, snap));
      }
      const nextMirror = mergeSwrEnrichedMirror(enrichedApps, snap);
      updateEnrichedApps(nextMirror);
      queueAssembledRowIcons(Object.values(snap));
      const emptyKeys = collectEmptyIconKeys(nextMirror);
      if (emptyKeys.length > 0) {
        backfillDbIconsForEmptyKeys(emptyKeys, () => myEpoch !== sessionEpoch || myToken !== swrBackfillToken);
      }
    },

    resetLoadingBoard(activeBoard, trendResult) {
      currentActiveBoard = activeBoard;
      currentTrendResult = trendResult;
      boardSeq += 1;
    },

    syncEnrichment({
      trendResult,
      activeBoard,
      trendFetchOpts,
      displayItems,
      boardReady,
      consumeForceEnrich,
    }) {
      if (trendResult?.status !== 'ok' || !boardReady) return;
      const enrichForce = consumeForceEnrich();
      if (
        enrichCycle.trendResult !== trendResult ||
        enrichCycle.activeBoard !== activeBoard ||
        enrichForce
      ) {
        enrichCycle.trendResult = trendResult;
        enrichCycle.activeBoard = activeBoard;
        enrichCycle.seq += 1;
        attemptedEnrichKeys.clear();
      }
      const { snap } = buildSwrFill(trendResult.repos);
      const effectiveEnriched = mergeSwrEnrichedMirror(enrichedApps, snap);
      const missing = collectMissingEnrichRepos(displayItems, effectiveEnriched);
      if (missing.size === 0) return;
      const toEnrich: TrendRepo[] = [];
      for (const [key, repo] of missing) {
        if (attemptedEnrichKeys.has(key)) continue;
        attemptedEnrichKeys.add(key);
        toEnrich.push(repo);
      }
      if (toEnrich.length === 0) return;
      const seqAtStart = enrichCycle.seq;
      const epochAtStart = sessionEpoch;
      void enrichTrendRepos(toEnrich, enrichForce ? { forceRefresh: true } : undefined).then(
        async (found) => {
          if (epochAtStart !== sessionEpoch || enrichCycle.seq !== seqAtStart || found.size === 0) {
            return;
          }
          const { next, hasNewEnrich, concreteKeys } = mergeEnrichFoundMirror(enrichedApps, found);
          if (next !== enrichedApps) updateEnrichedApps(next);
          if (found.size > 0) queueAssembledRowIcons([...found.values()]);
          const remainingEmptyKeys = collectEmptyIconKeys(next);
          if (remainingEmptyKeys.length > 0) {
            backfillDbIconsForEmptyKeys(
              remainingEmptyKeys,
              () => epochAtStart !== sessionEpoch || enrichCycle.seq !== seqAtStart,
            );
          }
          if (concreteKeys.length > 0) {
            unmarkTrendConfirmedOthers(concreteKeys);
            updateConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, concreteKeys));
          }
          if (hasNewEnrich && trendResult.repos.length > 0) {
            const { cacheKey, cacheBoard } = resolveBoardCacheKey(activeBoard, trendFetchOpts);
            await saveBoardCacheMerged(cacheKey, cacheBoard, trendResult.repos);
          }
        },
      );
    },

    syncLiteVerify({ trendResult, rawItems, activeBoard, globalConfirmed, fetchLite }) {
      if (trendResult?.status !== 'ok' || globalConfirmed === undefined) return;
      const combinedConfirmed = unionConfirmedSets(globalConfirmed, confirmedOtherIds);
      const seq = liteSeqGuard.capture();
      const epochAtStart = sessionEpoch;
      const trusted = getTrustedConcrete(trendResult);
      const sel = selectLiteTargets({
        rawItems,
        enrichedApps,
        combinedConfirmed,
        inflight: liteInflightGuard.snapshot(),
        trusted,
      });
      zlogInfo(
        `[trends] lite-skip board=${activeBoard} trustedConcrete=${sel.trustedConcrete} ` +
          `trustedLoading=${sel.trustedLoading} skipped=${sel.skipped} targets=${sel.targets.length}`,
      );
      if (sel.targets.length === 0) return;
      const claimed = new Set(liteInflightGuard.take(sel.targets.map((t) => t.key)));
      const runTargets = sel.targets.filter((t) => claimed.has(t.key));
      if (runTargets.length === 0) return;
      const boardAtStart = sessionBoardRef;
      void (async () => {
        try {
          const { patched, confirmedEmpty } = await runLiteBatch(
            runTargets,
            fetchLite,
            () => epochAtStart !== sessionEpoch || liteSeqGuard.isStale(seq),
          );
          if (epochAtStart !== sessionEpoch || liteSeqGuard.isStale(seq)) return;
          const preLiteSnapshot = enrichedApps;
          if (patched.size > 0) {
            const aliasKeys = collectUnmarkAliasKeys(patched.keys(), preLiteSnapshot);
            if (aliasKeys.length > 0) unmarkTrendConfirmedOthers(aliasKeys);
            updateEnrichedApps((prev) => mergeLitePatchedMirror(prev, patched));
            updateConfirmedOtherIds((prev) =>
              removeConfirmedForConcrete(prev, [...patched.keys()]),
            );
            try {
              await maybePersistLitePatched(patched, preLiteSnapshot, boardAtStart);
            } catch {
              // 写透失败不影响内存落定
            }
          }
          if (confirmedEmpty.length > 0) {
            const aliasConfirmed = await confirmLiteEmpty(
              confirmedEmpty,
              preLiteSnapshot,
              boardAtStart,
            );
            if (
              aliasConfirmed.length > 0 &&
              epochAtStart === sessionEpoch &&
              !liteSeqGuard.isStale(seq)
            ) {
              updateConfirmedOtherIds((prev) => addConfirmedMirror(prev, aliasConfirmed));
            }
          }
        } finally {
          liteInflightGuard.release(runTargets.map((t) => t.key));
        }
      })();
    },

    scheduleSettle({ trendResult, rawItems, globalConfirmed }) {
      latestGlobalConfirmed = globalConfirmed;
      if (globalConfirmed === undefined || trendResult?.status !== 'ok') return () => {};
      const combinedConfirmed = unionConfirmedSets(globalConfirmed, confirmedOtherIds);
      const { loadingKeys, repoByKey } = collectSettleLoading(
        rawItems,
        enrichedApps,
        combinedConfirmed,
      );
      if (loadingKeys.length === 0) return () => {};
      const repos = trendResult.repos;
      return scheduleSettleConfirm({
        keys: loadingKeys,
        recheck: (snapshot) =>
          filterStillLoading(snapshot, enrichedApps, latestGlobalConfirmed, confirmedOtherIds),
        onConfirm: (stillLoading) => {
          const { toHydrate, aliasKeys } = buildSettleHydration(
            stillLoading,
            enrichedApps,
            repoByKey,
            repos,
          );
          if (aliasKeys.length === 0) return;
          try {
            markTrendConfirmedOthers(aliasKeys);
            if (Object.keys(toHydrate).length > 0) {
              putTrendEnrichMemory(toHydrate);
            }
          } catch {
            // 标记失败仍尝试本地落定
          }
          updateConfirmedOtherIds((prev) =>
            addConfirmedMirror(
              prev,
              aliasKeys.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0),
            ),
          );
          if (Object.keys(toHydrate).length > 0) {
            updateEnrichedApps((prev) => mergeSettleSyntheticMirror(prev, toHydrate));
          }
          const { cacheKey, cacheBoard, repos: curRepos } = sessionBoardRef;
          if (cacheKey && curRepos.length > 0) {
            try {
              void saveBoardCacheMerged(cacheKey, cacheBoard, curRepos);
            } catch {
              // 写透失败不影响内存落定
            }
          }
        },
      });
    },
  };
}
