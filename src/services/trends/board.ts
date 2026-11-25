/**
 * 趋势榜单控制器与抓榜入口：整合数据源抓取、L1/L2 索引缓存、卡片批量水合、
 * 元数据 enrich、lite 平台补验、settle 超时兜底与详情/图标同步。
 */

import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo, TrendsResult } from '../../types';
import { tauriApi } from '../api';
import { hydrateCardsByIds, subscribeRepoCardHeals, type RepoCardHeal } from '../repoEnrichCache';
import {
  admitIconHit,
  advanceTrendIconGateOnRefresh,
  ensureIconReadySubscription,
  patchIconMirror,
  queueAssembledRowIcons,
  resolveIconWithBuffer,
  setActiveTrendIconGate,
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
import { zlogWarn } from '../../lib/z-log';
import { DEFAULT_ICON_BG } from '../../styles/tokens';
import { arePlatformsEqual } from '../../utils/appHelper';
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
  saveDbTrendCache,
  setDoforceInflight,
  sweepExpiredTrendsCache,
  writeDoforceShared,
  writeTrendsCache,
} from './cache';
import {
  diffRichSummary,
  enrichTrendRepos,
  isPlaceholderDescription,
  markTrendConfirmedOthers,
  putTrendEnrichMemory,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
  snapshotTrendRepoCards,
  sweepExpiredTrendEnrichCache,
  unmarkTrendConfirmedOthers,
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
      writeTrendsCache(key, dbHit);
      emitBoardHydrated(board, key);
      return { repos: dbHit, status: 'ok', stale: false };
    }
  }

  const result = await load();
  if (result.status === 'ok') {
    writeTrendsCache(key, result.repos);
    await saveDbTrendCache(key, board, result.repos);
    emitBoardHydrated(board, key);
    return result;
  }
  if (result.status === 'error') {
    const staleHit = await getDbTrendCache(key, board, { allowStale: true });
    if (staleHit && staleHit.length > 0) {
      writeTrendsCache(key, staleHit);
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
      emitBoardHydrated('doforce', key);
      return hit;
    }
    const inflight = getDoforceInflight();
    if (inflight) {
      return inflight;
    }
  }
  const slot: { current?: Promise<TrendRepo[]> } = {};
  slot.current = (async (): Promise<TrendRepo[]> => {
    try {
      if (!forceRefresh) {
        const dbHit = await getDbTrendCache(key, 'doforce');
        if (dbHit && dbHit.length > 0) {
          writeDoforceShared(dbHit);
          emitBoardHydrated('doforce', key);
          return dbHit;
        }
      }

      try {
        const repos = await fetchDoforceWithRetry();
        if (repos.length > 0) {
          writeDoforceShared(repos);
          await saveDbTrendCache(key, 'doforce', repos);
          emitBoardHydrated('doforce', key);
        }
        return repos;
      } catch (err) {
        const staleHit = await getDbTrendCache(key, 'doforce', { allowStale: true });
        if (staleHit && staleHit.length > 0) {
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

function boardRepoKeys(repos: readonly TrendRepo[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of repos ?? []) {
    if (r.id) out.add(r.id.trim().toLowerCase());
    if (r.owner && r.repo) out.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
  }
  return out;
}

interface SwrFill {
  snap: Record<string, AppSummary>;
  trustedConcrete: Set<string>;
  l2Confirmed: string[];
}

function buildSwrFill(repos: TrendRepo[]): SwrFill {
  const snap = snapshotTrendRepoCards(repos);
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
  needsRefresh: ReadonlySet<string>,
): Map<string, TrendRepo> {
  const missing = new Map<string, TrendRepo>();
  for (const item of items) {
    if (item.type !== 'uncataloged') continue;
    const key = item.repo.id.toLowerCase();
    if (missing.has(key)) continue;
    if (!enrichedApps[key] || needsRefresh.has(key)) missing.set(key, item.repo);
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

function recordLitePatched(
  patched: Map<string, string[]>,
  latest: Record<string, AppSummary>,
): void {
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
}

function confirmLiteEmpty(
  confirmedEmpty: readonly string[],
  latest: Record<string, AppSummary>,
): string[] {
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

/** 详情补丁并入单行：平台补齐，其余字段仅取实质变更（图标通道由 iconStore 写口扇出）。 */
function patchHealRow(cur: AppSummary, heal: RepoCardHeal): AppSummary {
  let patched: AppSummary | null = null;
  const platforms = heal.platforms;
  if (platforms && platforms.length > 0 && !arePlatformsEqual(cur.platforms, platforms)) {
    patched = { ...cur, platforms: [...platforms] };
  }
  const summary = heal.summary as unknown as Record<string, unknown>;
  for (const f of diffRichSummary(cur, heal.summary)) {
    patched ??= { ...cur };
    (patched as unknown as Record<string, unknown>)[f] = summary[f];
  }
  return patched ?? cur;
}

/** 尚未 enrich 的本榜行：由详情补丁合成（图标通道置空，占位简介剥空）。 */
function synthesizeHealRow(heal: RepoCardHeal): AppSummary {
  const summary = heal.summary;
  return {
    ...summary,
    description: isPlaceholderDescription(summary.description) ? '' : summary.description,
    description_en:
      typeof summary.description_en === 'string' && isPlaceholderDescription(summary.description_en)
        ? ''
        : summary.description_en,
    icon: '',
    icon_bg: DEFAULT_ICON_BG,
    platforms: heal.platforms && heal.platforms.length > 0 ? [...heal.platforms] : [],
  };
}

/** 将详情补丁并入榜单镜像：命中行（镜像键或行 id 别名）就地补丁，本榜缺席行合成。 */
function applyRepoCardHealToMirror(
  prev: Record<string, AppSummary>,
  heal: RepoCardHeal,
  repoKeys: ReadonlySet<string>,
): Record<string, AppSummary> {
  const keySet = new Set(heal.keys);
  let next: Record<string, AppSummary> | null = null;
  for (const k of Object.keys(prev)) {
    const cur = prev[k];
    if (!cur) continue;
    const alias = String(cur.id ?? '').trim().toLowerCase();
    if (!keySet.has(k.toLowerCase()) && (alias === '' || !keySet.has(alias))) continue;
    const patched = patchHealRow(cur, heal);
    if (patched === cur) continue;
    next ??= { ...prev };
    next[k] = patched;
  }
  for (const k of heal.keys) {
    if ((next ?? prev)[k] || !repoKeys.has(k)) continue;
    next ??= { ...prev };
    next[k] = synthesizeHealRow(heal);
  }
  return next ?? prev;
}

/* ------------------------------------------------------------------ */
/* C. TrendBoardSession 控制器                                        */
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
  }): void;
  resetLoadingBoard(activeBoard: TrendBoardId, trendResult: TrendsResult | null): void;
  syncEnrichment(params: {
    trendResult: TrendsResult | null;
    activeBoard: TrendBoardId;
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

/** 创建趋势榜会话控制器，管理抓榜、水合、enrich/lite 补验、settle 兜底与事件同步。 */
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
  /** 当前榜单的批量水合（`get_repo_cards_batch`）：enrich 决策等待其完成，避免重复请求。 */
  let hydration: { trendResult: TrendsResult; promise: Promise<void> } | null = null;
  /** 已水合但元数据超出 12h 新鲜窗口、仍需 enrich 刷新的键。 */
  const staleHydratedKeys = new Set<string>();

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
        }
      } catch {
        // 内存同步失败不影响已呈现
      }
    })();
  }

  /** 订阅详情落定补丁：仅更新榜单镜像与已确认 Other 镜像（富卡池已由 `upsertRepoCardFromDetail` 写入）。 */
  function attachHealBus(): () => void {
    return subscribeRepoCardHeals((heal) => {
      const repoKeys = boardRepoKeys(currentTrendResult?.repos);
      updateEnrichedApps((prev) => applyRepoCardHealToMirror(prev, heal, repoKeys));
      if (heal.platforms && heal.platforms.length > 0) {
        updateConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, heal.keys));
      } else if (heal.confirmedOther) {
        const keySet = new Set(heal.keys.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0));
        const candidates = new Set<string>();
        let hasBoardConcrete = false;
        for (const k of keySet) {
          if (repoKeys.has(k) || Boolean(enrichedApps[k])) candidates.add(k);
        }
        for (const [mirrorKey, row] of Object.entries(enrichedApps)) {
          const nk = mirrorKey.trim().toLowerCase();
          const alias = String(row?.id ?? '').trim().toLowerCase();
          if (!keySet.has(nk) && (alias === '' || !keySet.has(alias))) continue;
          if (row?.platforms && row.platforms.length > 0) {
            hasBoardConcrete = true;
            break;
          }
          if (nk) candidates.add(nk);
          if (alias) candidates.add(alias);
        }
        if (!hasBoardConcrete) {
          const toConfirm = [...candidates].filter((k) => {
            const row = enrichedApps[k];
            return !(row?.platforms && row.platforms.length > 0);
          });
          if (toConfirm.length > 0) {
            updateConfirmedOtherIds((prev) => addConfirmedMirror(prev, toConfirm));
          }
        }
      }
    });
  }

  /** enrich 批量取回后并入镜像（`enrichTrendRepos` 内已写富卡池，榜单 L2 不重写）。 */
  function runEnrichment(
    toEnrich: TrendRepo[],
    force: boolean,
    board: TrendBoardId,
    seqAtStart: number,
    epochAtStart: number,
  ): void {
    const isStale = (): boolean => epochAtStart !== sessionEpoch || enrichCycle.seq !== seqAtStart;
    void enrichTrendRepos(toEnrich, { forceRefresh: force, board }).then((found) => {
      if (isStale() || found.size === 0) return;
      const { next, concreteKeys } = mergeEnrichFoundMirror(enrichedApps, found);
      if (next !== enrichedApps) updateEnrichedApps(next);
      queueAssembledRowIcons([...found.values()]);
      for (const k of found.keys()) staleHydratedKeys.delete(k);
      const remainingEmptyKeys = collectEmptyIconKeys(next);
      if (remainingEmptyKeys.length > 0) backfillDbIconsForEmptyKeys(remainingEmptyKeys, isStale);
      if (concreteKeys.length > 0) {
        unmarkTrendConfirmedOthers(concreteKeys);
        updateConfirmedOtherIds((prev) => removeConfirmedForConcrete(prev, concreteKeys));
      }
    });
  }

  /** 批量水合未命中缓冲的榜单仓库，并按新鲜度标记交由后续 enrich 刷新。 */
  function ensureHydration(trendResult: TrendsResult): Promise<void> {
    if (hydration && hydration.trendResult === trendResult) return hydration.promise;
    const myEpoch = sessionEpoch;
    const myToken = swrBackfillToken;
    const isCancelled = (): boolean => myEpoch !== sessionEpoch || myToken !== swrBackfillToken;
    const snap = snapshotTrendRepoCards(trendResult.repos);
    const pending: string[] = [];
    for (const r of trendResult.repos) {
      const key = (r.id || '').trim().toLowerCase();
      if (!key || snap[key] || enrichedApps[key]) continue;
      pending.push(key);
    }
    const promise = (async (): Promise<void> => {
      if (pending.length > 0) {
        let hydrated: Awaited<ReturnType<typeof hydrateCardsByIds>> | null = null;
        try {
          hydrated = await hydrateCardsByIds(pending, { uncatalogedOnly: true });
        } catch {
          hydrated = null;
        }
        if (hydrated && !isCancelled()) {
          const found: Record<string, AppSummary> = {};
          for (const [k, card] of hydrated.byId) {
            if (card.is_cataloged === true) continue;
            found[k] = card;
            if (hydrated.freshCardIds.has(k)) staleHydratedKeys.delete(k);
            else staleHydratedKeys.add(k);
          }
          if (Object.keys(found).length > 0) {
            updateEnrichedApps((prev) => mergeSwrEnrichedMirror(prev, found));
            queueAssembledRowIcons(Object.values(found));
          }
          if (hydrated.confirmedOtherIds.length > 0) {
            updateConfirmedOtherIds((prev) => addConfirmedMirror(prev, hydrated!.confirmedOtherIds));
          }
        }
      }
      if (isCancelled()) return;
      const emptyKeys = collectEmptyIconKeys(enrichedApps);
      if (emptyKeys.length > 0) backfillDbIconsForEmptyKeys(emptyKeys, isCancelled);
    })();
    hydration = { trendResult, promise };
    return promise;
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
      setActiveTrendIconGate({ board: currentActiveBoard });
      const releaseIconReady = ensureIconReadySubscription(tauriApi.onIconReady);
      const unsubHeal = attachHealBus();
      const unsubIconWrites = subscribeIconWrites(({ targets, icon }) => {
        const prevEnriched = enrichedApps;
        let next = prevEnriched;
        for (const t of targets) {
          next = patchIconMirror(next, t, icon);
        }
        if (next !== prevEnriched) {
          updateEnrichedApps(next);
          if (typeof icon === 'string' && !icon.startsWith('data:')) {
            const toHydrate: Record<string, AppSummary> = {};
            for (const k of Object.keys(next)) {
              if (next[k] !== prevEnriched[k]) toHydrate[k] = next[k];
            }
            if (Object.keys(toHydrate).length > 0) putTrendEnrichMemory(toHydrate);
          }
        }
      });
      activeCleanups = [
        releaseIconReady,
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
      hydration = null;
      staleHydratedKeys.clear();
      boardSeq += 1;
      setActiveTrendIconGate(null);
      const cleanups = activeCleanups;
      activeCleanups = [];
      for (const cleanup of cleanups) cleanup();
    },

    syncBoard({ trendResult, activeBoard }) {
      currentActiveBoard = activeBoard;
      currentTrendResult = trendResult;
      setActiveTrendIconGate({ board: activeBoard });
      if (trendResult?.status !== 'ok' || trendResult.repos.length === 0) {
        if (lastSwrResult !== trendResult) {
          lastSwrResult = trendResult;
          swrBackfillToken += 1;
        }
        return;
      }
      if (lastSwrResult === trendResult) return;
      lastSwrResult = trendResult;
      swrBackfillToken += 1;

      const { snap, l2Confirmed } = buildSwrFill(trendResult.repos);
      if (l2Confirmed.length > 0) {
        updateConfirmedOtherIds((prev) => mergeSwrConfirmedMirror(prev, l2Confirmed, snap));
      }
      updateEnrichedApps(mergeSwrEnrichedMirror(enrichedApps, snap));
      queueAssembledRowIcons(Object.values(snap));
      void ensureHydration(trendResult);
    },

    resetLoadingBoard(activeBoard, trendResult) {
      currentActiveBoard = activeBoard;
      currentTrendResult = trendResult;
      boardSeq += 1;
      advanceTrendIconGateOnRefresh();
      setActiveTrendIconGate({ board: activeBoard });
    },

    syncEnrichment({ trendResult, activeBoard, displayItems, boardReady, consumeForceEnrich }) {
      if (trendResult?.status !== 'ok' || !boardReady) return;
      const enrichForce = consumeForceEnrich();
      if (enrichForce) advanceTrendIconGateOnRefresh();
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
      const seqAtStart = enrichCycle.seq;
      const epochAtStart = sessionEpoch;
      // 冷启动：先等本榜批量水合落定，再判定真正缺失（或超 12h）的仓库，避免重复 enrich。
      void ensureHydration(trendResult).then(() => {
        if (epochAtStart !== sessionEpoch || enrichCycle.seq !== seqAtStart) return;
        const { snap } = buildSwrFill(trendResult.repos);
        const effectiveEnriched = mergeSwrEnrichedMirror(enrichedApps, snap);
        const missing = collectMissingEnrichRepos(displayItems, effectiveEnriched, staleHydratedKeys);
        if (missing.size === 0) return;
        const toEnrich: TrendRepo[] = [];
        for (const [key, repo] of missing) {
          if (attemptedEnrichKeys.has(key)) continue;
          attemptedEnrichKeys.add(key);
          toEnrich.push(repo);
        }
        if (toEnrich.length === 0) return;
        runEnrichment(toEnrich, enrichForce, activeBoard, seqAtStart, epochAtStart);
      });
    },

    syncLiteVerify({ trendResult, rawItems, globalConfirmed, fetchLite }) {
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
      if (sel.targets.length === 0) return;
      const claimed = new Set(liteInflightGuard.take(sel.targets.map((t) => t.key)));
      const runTargets = sel.targets.filter((t) => claimed.has(t.key));
      if (runTargets.length === 0) return;
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
              recordLitePatched(patched, preLiteSnapshot);
            } catch {
              // 镜像同步失败不影响内存落定
            }
          }
          if (confirmedEmpty.length > 0) {
            const aliasConfirmed = confirmLiteEmpty(confirmedEmpty, preLiteSnapshot);
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
        },
      });
    },
  };
}
