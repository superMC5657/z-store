import type { FetchTrendsOptions, TrendBoardId, TrendRepo } from '../../types';
import { clearTrendEnrichCache } from './enrich';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 默认内存缓存（new 榜；daily/weekly/monthly 见 trendsBoardTtlMs；仅成功结果写入；rising/healthy 除外，见下）
/**
 * doforce 源数据共享缓存 TTL：12h。
 * 日榜粒度数据日内几乎不变，长缓存 + 两榜共享把远端命中压到最低。
 */
export const DOFORCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 429 单次重试的最大等待：60s；超过即直接 error，不再等待。 */
export const DOFORCE_RETRY_MAX_WAIT_MS = 60_000;
/** 429 错误串无 Retry-After 可用时的默认等待（Rust 侧当前仅回传状态码）。 */
export const DOFORCE_RETRY_DEFAULT_WAIT_MS = 5_000;
export const TRENDING_TIMEOUT_MS = 10_000; // github.com/trending HTML 抓取 10s 熔断
export const DOFORCE_TIMEOUT_MS = 10_000; // doforce API 10s 熔断（Rust 侧执行）
export const GITHUB_SEARCH_TIMEOUT_MS = 10_000; // GitHub Search 主源 10s 熔断

const trendsCache = new Map<string, { timestamp: number; data: TrendRepo[] }>();

/** 缓存键 = board + language + category（P1 要求，统一口径）。 */
export function buildTrendsCacheKey(board: TrendBoardId, opts: FetchTrendsOptions = {}): string {
  return `${board}|${opts.language ?? ''}|${opts.category ?? ''}`;
}

/** 按榜缓存 TTL：daily 1h，weekly/monthly 12h，其余回落 CACHE_TTL_MS（new 榜 5 分钟）。 */
export function trendsBoardTtlMs(board: string): number {
  if (board === 'daily') return 60 * 60 * 1000;
  if (board === 'weekly' || board === 'monthly') return 12 * 60 * 60 * 1000;
  return CACHE_TTL_MS;
}

export function readTrendsCache(key: string, board: string): TrendRepo[] | undefined {
  const hit = trendsCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.timestamp < trendsBoardTtlMs(board)) return hit.data;
  trendsCache.delete(key);
  return undefined;
}

export function writeTrendsCache(key: string, data: TrendRepo[]): void {
  trendsCache.set(key, { timestamp: Date.now(), data });
}

/** doforce 源数据共享缓存（rising/healthy 共用原始快照，各榜自行排序）。 */
let doforceSharedCache: { timestamp: number; data: TrendRepo[] } | undefined;
/** doforce 在途共享 Promise（并发的 rising/healthy 复用同一请求，防 2 连击）。 */
let doforceInflight: Promise<TrendRepo[]> | undefined;

export function readDoforceShared(): TrendRepo[] | undefined {
  if (!doforceSharedCache) return undefined;
  if (Date.now() - doforceSharedCache.timestamp < DOFORCE_CACHE_TTL_MS) {
    return doforceSharedCache.data;
  }
  doforceSharedCache = undefined;
  return undefined;
}

export function writeDoforceShared(data: TrendRepo[]): void {
  doforceSharedCache = { timestamp: Date.now(), data };
}

export function getDoforceInflight(): Promise<TrendRepo[]> | undefined {
  return doforceInflight;
}

export function setDoforceInflight(p: Promise<TrendRepo[]> | undefined): void {
  doforceInflight = p;
}

/** 仅供测试与榜单切换时使用：清空趋势内存缓存（含 doforce 共享缓存与在途请求、enrich 12h 缓存）。 */
export function clearTrendsCache(): void {
  trendsCache.clear();
  doforceSharedCache = undefined;
  doforceInflight = undefined;
  clearTrendEnrichCache();
}
