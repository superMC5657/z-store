import type {
  FetchTrendsOptions,
  TrendBoardId,
  TrendRepo,
  TrendsResult,
} from '../../types';
import { tauriApi } from '../api';
import { zlogInfo, zlogWarn } from '../../lib/z-log';
import {
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  getDbTrendCache,
  getDoforceInflight,
  readDoforceShared,
  readTrendsCache,
  saveBoardCacheMerged,
  setDoforceInflight,
  sweepExpiredTrendsCache,
  writeDoforceShared,
  writeTrendsCache,
} from './cache';
import {
  markConfirmedOthersFreshNow,
  putTrendEnrichMemory,
  sweepExpiredTrendEnrichCache,
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

type TimeBoardId = 'daily' | 'weekly' | 'monthly';

/** Board → trending `?since=` 参数的单一映射（SSOT）。 */
export const TRENDING_SINCE: Record<TimeBoardId, 'daily' | 'weekly' | 'monthly'> = {
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

type TrendGainKey = 'today' | 'week' | 'month';

/** 榜单 → gain 文案口径（today/week/month），一处维护。 */
const BOARD_GAIN_KEY: Record<TrendBoardId, TrendGainKey> = {
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
  new: 'week',
  rising: 'week',
  healthy: 'week',
};

/** gain 文案口径查询（BOARD_GAIN_KEY 的唯一出口）。 */
export function boardGainKey(board: TrendBoardId): TrendGainKey {
  return BOARD_GAIN_KEY[board];
}

/** 时间榜判定（TRENDING_SINCE 单一映射的唯一出口，替代散写的 `in` 检查）。 */
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
export function buildTrendingUrl(board: TimeBoardId, opts: FetchTrendsOptions = {}): string {
  const since = TRENDING_SINCE[board];
  const lang = opts.language?.trim();
  const raw =
    lang && lang.toLowerCase() !== 'all'
      ? `https://github.com/trending/${encodeURIComponent(lang)}?since=${since}`
      : `https://github.com/trending?since=${since}`;
  return raw;
}

/**
 * daily/weekly/monthly 主源：trending HTML（Rust 侧抓取，10s 超时，无 CORS 概念）。
 * 失败抛错（上层映射 errorKind），空页返回 []。
 */
export async function fetchTrendingRepos(
  board: TimeBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendRepo[]> {
  const url = buildTrendingUrl(board, opts);
  const html = await tauriApi.fetchTrendsText(url);
  return parseTrendingHtml(html);
}

export const DOFORCE_URL = 'https://trend.doforce.dpdns.org/repo';

/** 构建 doforce 请求 URL（始终直连，单一出口）。 */
export function buildDoforceUrl(): string {
  return DOFORCE_URL;
}

/**
 * doforce 主源（Rust 侧抓取，10s 超时，无 CORS 限制）。
 * 支持纯数组或 `{items|data|repos}` 包装结构；失败时抛错，为空时返回 []。
 */
export async function fetchDoforceRepos(): Promise<TrendRepo[]> {
  const url = buildDoforceUrl();
  const text = await tauriApi.fetchTrendsText(url);
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

/**
 * new 榜主源：GitHub Search（created:>6个月，免 key 可用但配额极严）。
 * Rust 侧抓取，10s 超时；失败/空由上层按 error/empty 契约返回。
 */
export async function fetchGitHubNewRepos(): Promise<TrendRepo[]> {
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

/**
 * board 就绪订阅口（单 emit 源 `emitBoardHydrated` 的订阅口）。
 * View 经此口单订阅（useTrendBoard 内单 effect，不双订）；
 * L1/L2/网络三路径统一 emit（对称就绪），TTL/契约不变。
 */
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

async function fetchBoardWithL2(
  board: TrendBoardId,
  key: string,
  load: () => Promise<TrendsResult>,
  opts: FetchTrendsOptions = {},
): Promise<TrendsResult> {
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key, board);
    if (hit) {
      // L1 命中亦透出 hydrate 就绪信号（三路径统一 emit）。
      emitBoardHydrated(board, key);
      return { repos: hit, status: 'ok', stale: false };
    }

    const dbHit = await getDbTrendCache(key, board);
    if (dbHit && dbHit.length > 0) {
      const enrich = (dbHit as { enrich?: Record<string, import('../../types').AppSummary> }).enrich;
      if (enrich) putTrendEnrichMemory(enrich);
      // 已确认 Other 同 key 回填（读时 hydrate；getDb 内已按先确认后 enrich 顺序回填，此处幂等补齐）。
      const confirmed = (dbHit as { confirmedOther?: unknown }).confirmedOther;
      if (Array.isArray(confirmed)) markConfirmedOthersFreshNow(confirmed);
      writeTrendsCache(key, dbHit);
      l2HitLog(board, key, dbHit);
      // hydrate 完成后才透出就绪信号（首屏门订阅）。
      emitBoardHydrated(board, key);
      return { repos: dbHit, status: 'ok', stale: false };
    }
  }

  const result = await load();
  if (result.status === 'ok') {
    writeTrendsCache(key, result.repos);
    // 榜缓存二级落盘
    await saveBoardCacheMerged(key, board, result.repos);
    // 网络成功亦透出就绪（与 L1/L2 同通道，hook 不依赖直接置位）。
    emitBoardHydrated(board, key);
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
      // 共享槽命中亦透出（与 L2/网络同通道）。
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
          const enrich = (dbHit as { enrich?: Record<string, import('../../types').AppSummary> }).enrich;
          if (enrich) putTrendEnrichMemory(enrich);
          const confirmed = (dbHit as { confirmedOther?: unknown }).confirmedOther;
          if (Array.isArray(confirmed)) markConfirmedOthersFreshNow(confirmed);
          writeDoforceShared(dbHit);
          const hasEnrich = !!enrich && typeof enrich === 'object';
          const enrichCount = hasEnrich ? Object.keys(enrich as Record<string, unknown>).length : 0;
          zlogInfo(
            `[trends] board=doforce L2-cache hit key=${key} hasEnrich=${hasEnrich} ` +
              `enrichCount=${enrichCount} reposCount=${dbHit.length}`,
          );
          // hydrate 完成后才透出就绪信号（首屏门订阅）。
          emitBoardHydrated('doforce', key);
          return dbHit;
        }
      }

      const repos = await fetchDoforceWithRetry();
      if (repos.length > 0) {
        writeDoforceShared(repos);
        // 榜缓存二级落盘
        await saveBoardCacheMerged(key, 'doforce', repos);
        // doforce 网络成功亦透出（rising/healthy 共享槽同信号）。
        emitBoardHydrated('doforce', key);
      }
      return repos;
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
    // undefined 恒沉底、tie 按 id 升序（compareStarsGainedDesc SSOT）。
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

export async function fetchTrendsResult(
  board: TrendBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendsResult> {
  // 切榜 sweep 过期。
  // 本函数为 slice 内部实现；View 侧唯一对外口为 board.fetchTrendsResultSeam。
  sweepExpiredTrendsCache();
  sweepExpiredTrendEnrichCache();
  if (isTimeBoard(board)) {
    return fetchTimeBoardResult(board, opts);
  }
  const fetcher = STATIC_BOARD_FETCHERS[board];
  if (fetcher) return fetcher(opts);
  throw new Error(`[trends] unknown board: ${String(board)}`);
}
