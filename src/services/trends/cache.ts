import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo } from '../../types';
import { isTauri, tauriInvoke } from '../api/client';
import { clearTrendEnrichCache, hydrateTrendEnrichCache } from './enrich';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 默认内存缓存（new 榜；daily/weekly/monthly 见 trendsBoardTtlMs；仅成功结果写入；rising/healthy 除外，见下）
/**
 * doforce 源数据共享缓存 TTL：12h。
 * 日榜粒度数据日内几乎不变，长缓存 + 两榜共享把远端命中压到最低。
 */
export const DOFORCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** DB L2 持久化缓存统一 TTL：12h（所有榜单按 12h 复用）。 */
export const TREND_DB_TTL_MS = 12 * 60 * 60 * 1000;
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

export function buildDoforceCacheKey(opts: FetchTrendsOptions = {}): string {
  const language = opts.language || '';
  const category = opts.category || '';
  return `doforce|${language}|${category}`;
}

export const DOFORCE_SHARED_CACHE_KEY = buildDoforceCacheKey();

export const CMD_GET_TREND_BOARD_CACHE = 'get_trend_board_cache';
export const CMD_SAVE_TREND_BOARD_CACHE = 'save_trend_board_cache';

/**
 * 榜单持久化信封 v1：
 * 包装榜单裸仓列表与对应的坐标 enrich 派生摘要。
 * enrich 键为小写 `owner/repo`，仅收录具真实平台且无 dataURI 的有效条目。
 */
export interface TrendCacheEnvelopeV1 {
  v: 1;
  repos: TrendRepo[];
  enrich?: Record<string, AppSummary>;
}

interface DbTrendBoardCacheRow {
  payload_json?: string;
  cached_at?: number;
}

/**
 * 读 DB L2 持久化缓存：
 * - 双形状解析：
 *   1) 纯数组 Array → 旧格式兼容，直接返回 TrendRepo[]；
 *   2) { v: 1, repos, enrich } 信封 → 新格式，repos 必须非空数组，enrich 逐项守卫后调 hydrateTrendEnrichCache 载入内存，并返回 repos；
 * - 命中且未过期（cached_at*1000 + TREND_DB_TTL_MS > now）返回解析后的 TrendRepo[]；
 * - 命令未就绪 / DB 损坏 / 反序列化失败 / 已过期一律降级返回 undefined（视为 miss 走网络）。
 */
export async function getDbTrendCache(key: string, _board?: string): Promise<TrendRepo[] | undefined> {
  if (!isTauri) return undefined;
  try {
    const row = await tauriInvoke<DbTrendBoardCacheRow | null>(CMD_GET_TREND_BOARD_CACHE, {
      cache_key: key,
      cacheKey: key,
    });
    if (!row) return undefined;

    const payloadStr = row.payload_json;
    const cachedAtSec = row.cached_at;

    if (typeof payloadStr !== 'string' || typeof cachedAtSec !== 'number' || cachedAtSec <= 0) {
      return undefined;
    }

    if (Date.now() - cachedAtSec * 1000 >= TREND_DB_TTL_MS) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(payloadStr);

    // 形状 1: Array → 旧格式兼容（裸榜数组）
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return undefined;
      }
      return parsed as TrendRepo[];
    }

    // 形状 2: v === 1 信封
    if (parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === 1) {
      const envelope = parsed as TrendCacheEnvelopeV1;
      if (!Array.isArray(envelope.repos) || envelope.repos.length === 0) {
        return undefined;
      }

      // enrich 逐项守卫：id/owner/repo/icon 为 string 才收，过滤 dataURI 与空 platforms
      const guardedEnrich: Record<string, AppSummary> = {};
      if (envelope.enrich && typeof envelope.enrich === 'object') {
        for (const [rawKey, item] of Object.entries(envelope.enrich)) {
          if (!item || typeof item !== 'object') continue;
          const candidate = item as Partial<AppSummary>;
          if (
            typeof candidate.id === 'string' &&
            candidate.id.trim() !== '' &&
            typeof candidate.owner === 'string' &&
            candidate.owner.trim() !== '' &&
            typeof candidate.repo === 'string' &&
            candidate.repo.trim() !== '' &&
            typeof candidate.icon === 'string' &&
            candidate.icon.trim() !== '' &&
            !candidate.icon.startsWith('data:') &&
            Array.isArray(candidate.platforms) &&
            candidate.platforms.length > 0
          ) {
            guardedEnrich[rawKey.trim().toLowerCase()] = item as AppSummary;
          }
        }
      }

      hydrateTrendEnrichCache(guardedEnrich);
      const repos = envelope.repos as TrendRepo[] & { enrich?: Record<string, AppSummary> };
      if (Object.keys(guardedEnrich).length > 0) {
        repos.enrich = guardedEnrich;
      }
      return repos;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写 DB L2 持久化缓存（fire-and-forget，不阻塞主流程，异常安全）。
 * - 第 4 参 enrich 可选：无参保持旧数组 JSON 写入；有参且合法时写入 { v: 1, repos, enrich } 信封。
 */
export async function saveDbTrendCache(
  key: string,
  board: string,
  repos: TrendRepo[],
  enrich?: Record<string, AppSummary>,
): Promise<void> {
  if (!isTauri || !Array.isArray(repos) || repos.length === 0) return;
  try {
    let payloadJson: string;
    if (enrich !== undefined) {
      const sanitizedEnrich: Record<string, AppSummary> = {};
      for (const [k, summary] of Object.entries(enrich)) {
        if (!summary || typeof summary !== 'object') continue;
        if (!Array.isArray(summary.platforms) || summary.platforms.length === 0) continue;
        if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) continue;
        const cleanKey = k.trim().toLowerCase();
        if (cleanKey) {
          sanitizedEnrich[cleanKey] = summary;
        }
      }
      const envelope: TrendCacheEnvelopeV1 = {
        v: 1,
        repos,
        enrich: sanitizedEnrich,
      };
      payloadJson = JSON.stringify(envelope);
    } else {
      payloadJson = JSON.stringify(repos);
    }

    await tauriInvoke(CMD_SAVE_TREND_BOARD_CACHE, {
      cache_key: key,
      cacheKey: key,
      board,
      payload_json: payloadJson,
      payloadJson,
    });
  } catch {
    // 降级吞错，不影响主流程
  }
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
