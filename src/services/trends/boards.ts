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
  saveDbTrendCache,
  setDoforceInflight,
  writeDoforceShared,
  writeTrendsCache,
} from './cache';
import { hydrateTrendEnrichCache } from './enrich';
import {
  classifyTrendsError,
  doforceRetryDelayMs,
  errorStatusOf,
  mapDoforceItem,
  mapGitHubSearchItem,
  parseTrendingHtml,
  sortByHealthyScore,
  withTrendsProxy,
} from './parse';

export type TimeBoardId = 'daily' | 'weekly' | 'monthly';

/** Board → trending `?since=` 参数的单一映射（SSOT）。 */
export const TRENDING_SINCE: Record<TimeBoardId, 'daily' | 'weekly' | 'monthly'> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

/** 当前 6 榜全集（常青/分类榜已下线，不在此列）。 */
export const TREND_BOARD_IDS: readonly TrendBoardId[] = [
  'daily',
  'weekly',
  'monthly',
  'new',
  'rising',
  'healthy',
];

export type TrendGainKey = 'today' | 'week' | 'month';

/** 榜单 → gain 文案口径（today/week/month），一处维护。 */
export const BOARD_GAIN_KEY: Record<TrendBoardId, TrendGainKey> = {
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
export function isTimeBoard(board: string): board is TimeBoardId {
  return board in TRENDING_SINCE;
}

/** 陈旧榜回落：非当前 6 榜（如已下线的 'top' / 'category' 残留）一律回落 'weekly'。 */
export function resolveTrendBoard(board: string): TrendBoardId {
  return (TREND_BOARD_IDS as readonly string[]).includes(board)
    ? (board as TrendBoardId)
    : 'weekly';
}

/** 构造 trending 抓取 URL（language 走 `/trending/<lang>` 路径段）。 */
export function buildTrendingUrl(board: TimeBoardId, opts: FetchTrendsOptions = {}): string {
  const since = TRENDING_SINCE[board];
  const lang = opts.language?.trim();
  const raw =
    lang && lang.toLowerCase() !== 'all'
      ? `https://github.com/trending/${encodeURIComponent(lang)}?since=${since}`
      : `https://github.com/trending?since=${since}`;
  return withTrendsProxy(raw, opts);
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

/** 构建 doforce 请求 URL（始终直连）。 */
export function buildDoforceUrl(opts: FetchTrendsOptions = {}): string {
  return withTrendsProxy(DOFORCE_URL, opts);
}

/**
 * doforce 主源（Rust 侧抓取，10s 超时，无 CORS 限制）。
 * 支持纯数组或 `{items|data|repos}` 包装结构；失败时抛错，为空时返回 []。
 */
export async function fetchDoforceRepos(): Promise<TrendRepo[]> {
  const url = buildDoforceUrl({});
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
  const url = withTrendsProxy(
    `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=20`,
  );

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
    if (repos.length === 0) return { repos: [], status: 'empty' };
    zlogInfo(`[trends] board=${board} source=${source} ok count=${repos.length}`);
    return { repos, status: 'ok' };
  } catch (err) {
    const errorKind = classifyTrendsError(err);
    zlogWarn(
      `[trends] board=${board} source=${source} error kind=${errorKind} ` +
        `status=${errorStatusOf(err) ?? '-'} msg=${String((err as { message?: unknown })?.message ?? err)}`,
    );
    return { repos: [], status: 'error', errorKind };
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
    if (hit) return { repos: hit, status: 'ok' };

    const dbHit = await getDbTrendCache(key, board);
    if (dbHit && dbHit.length > 0) {
      const enrich = (dbHit as { enrich?: Record<string, import('../../types').AppSummary> }).enrich;
      if (enrich) hydrateTrendEnrichCache(enrich);
      writeTrendsCache(key, dbHit);
      zlogInfo(`[trends] board=${board} L2-cache hit count=${dbHit.length}`);
      return { repos: dbHit, status: 'ok' };
    }
  }

  const result = await load();
  if (result.status === 'ok') {
    writeTrendsCache(key, result.repos);
    await saveDbTrendCache(key, board, result.repos);
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
          if (enrich) hydrateTrendEnrichCache(enrich);
          writeDoforceShared(dbHit);
          zlogInfo(`[trends] doforce L2-cache hit count=${dbHit.length}`);
          return dbHit;
        }
      }

      const repos = await fetchDoforceWithRetry();
      if (repos.length > 0) {
        writeDoforceShared(repos);
        await saveDbTrendCache(key, 'doforce', repos);
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
    return [...repos].sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0));
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
  if (isTimeBoard(board)) {
    return fetchTimeBoardResult(board, opts);
  }
  const fetcher = STATIC_BOARD_FETCHERS[board];
  if (fetcher) return fetcher(opts);
  throw new Error(`[trends] unknown board: ${String(board)}`);
}

export async function fetchTrends(board: TrendBoardId, opts: FetchTrendsOptions = {}): Promise<TrendRepo[]> {
  const result = await fetchTrendsResult(board, opts);
  return result.repos;
}
