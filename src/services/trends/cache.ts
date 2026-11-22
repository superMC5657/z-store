import type { FetchTrendsOptions, TrendBoardId, TrendRepo } from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from '../api/client';
import { normalizeId } from '../normalizeId';
import { zlogWarn } from '../../lib/z-log';
import { clearTrendEnrichCache } from './enrich';
import { createSerializedKeyWriter } from '../../lib/serializedKeyWriter';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 默认内存缓存回落（未知榜；daily/weekly/monthly/new 均为显式分档见 trendsBoardTtlMs；仅成功结果写入；rising/healthy 除外，见下）
/** doforce 源数据共享缓存 TTL。 */
export const DOFORCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 榜缓存二级落盘默认 TTL：12h。 */
export const TREND_DB_TTL_MS = 12 * 60 * 60 * 1000;
/** 榜缓存二级落盘 daily 榜 TTL：1h。 */
const TREND_DB_DAILY_TTL_MS = 60 * 60 * 1000;
/** 429 单次重试的最大等待：60s；超过上限则直接返回错误。 */
export const DOFORCE_RETRY_MAX_WAIT_MS = 60_000;
/** 429 响应未携带可用 `Retry-After` / `retry_after_ms` 时的默认等待。 */
export const DOFORCE_RETRY_DEFAULT_WAIT_MS = 5_000;

/** 榜缓存一级内存至多 200 条，写时 FIFO 删最旧。 */
export const TRENDS_CACHE_MAX_ENTRIES = 200;
/** 写盘前 UTF-8 预检上限 32 KiB（`v: 2` 瘦排行索引；后端硬上限 64 KiB）。 */
export const TREND_DB_PAYLOAD_MAX_BYTES = 32 * 1024;
/** 榜缓存二级落盘读错峰抖动上限 30s。 */
const TREND_L2_JITTER_MAX_MS = 30_000;

const trendsCache = new Map<string, { timestamp: number; data: TrendRepo[] }>();

/**
 * 榜缓存二级落盘读抖动 0-30s。
 */
export function trendL2JitterMs(key: string): number {
  let h = 2166136261 >>> 0;
  const s = String(key ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % TREND_L2_JITTER_MAX_MS;
}

/**
 * 榜缓存二级落盘有效 TTL=ttl-min(jitter,ttl/4)。
 */
export function trendL2EffectiveTtlMs(ttlMs: number, key: string): number {
  const jitter = trendL2JitterMs(key);
  const cap = Math.floor(ttlMs / 4);
  return ttlMs - Math.min(jitter, cap);
}

/** 写盘前 UTF-8 字节预检。 */
export function utf8ByteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    try {
      // Node/测试环境回退
      const buf = (globalThis as unknown as { Buffer?: { byteLength(x: string, e: string): number } }).Buffer;
      if (buf) return buf.byteLength(s, 'utf8');
    } catch {
      // 忽略回退异常，走近似
    }
    return s.length;
  }
}

/** 缓存键 = board + language + category（统一口径；三段归一 trim().toLowerCase()，读写同源）。
 *  View 侧唯一出口为 board.resolveBoardCacheKey，不直调此 builder。 */
export function buildTrendsCacheKey(board: TrendBoardId, opts: FetchTrendsOptions = {}): string {
  const language = normalizeId(opts.language);
  const category = normalizeId(opts.category);
  return `${board}|${language}|${category}`;
}

/** 榜缓存二级落盘 TTL 基准：daily 1h，其余 12h。 */
export function trendDbTtlMs(board: string): number {
  if (board === 'daily') return TREND_DB_DAILY_TTL_MS;
  return TREND_DB_TTL_MS;
}

/** 榜缓存 TTL：daily 1h，weekly/monthly/new 12h，其余 5min。 */
export function trendsBoardTtlMs(board: string): number {
  if (board === 'daily') return 60 * 60 * 1000;
  if (board === 'weekly' || board === 'monthly' || board === 'new') return 12 * 60 * 60 * 1000;
  return CACHE_TTL_MS;
}

export function readTrendsCache(key: string, board: string): TrendRepo[] | undefined {
  const hit = trendsCache.get(key);
  if (!hit) return undefined;
  // 时钟钳制：elapsed<0（系统时钟回拨/未来戳）按过期处理，不返回 stale。
  const elapsed = Date.now() - hit.timestamp;
  if (elapsed < 0) {
    trendsCache.delete(key);
    return undefined;
  }
  if (elapsed < trendsBoardTtlMs(board)) return hit.data;
  trendsCache.delete(key);
  return undefined;
}

export function writeTrendsCache(key: string, data: TrendRepo[]): void {
  // 刷新写序：已存在先删再插，使其成为最新；新插入触发 FIFO 裁剪时删最旧。
  if (trendsCache.has(key)) trendsCache.delete(key);
  trendsCache.set(key, { timestamp: Date.now(), data });
  // 写时 FIFO 删最旧。
  while (trendsCache.size > TRENDS_CACHE_MAX_ENTRIES) {
    const oldest = trendsCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === key) break;
    trendsCache.delete(oldest);
  }
}

/**
 * 切榜 sweep 过期。
 */
export function sweepExpiredTrendsCache(): void {
  const now = Date.now();
  for (const [k, v] of trendsCache) {
    const board = k.split('|')[0] ?? '';
    const elapsed = now - v.timestamp;
    if (elapsed < 0 || elapsed >= trendsBoardTtlMs(board)) trendsCache.delete(k);
  }
  if (doforceSharedCache) {
    const elapsed = now - doforceSharedCache.timestamp;
    if (elapsed < 0 || elapsed >= DOFORCE_CACHE_TTL_MS) doforceSharedCache = undefined;
  }
}

export function buildDoforceCacheKey(opts: FetchTrendsOptions = {}): string {
  // 归一 trim().toLowerCase()。
  const language = normalizeId(opts.language);
  const category = normalizeId(opts.category);
  return `doforce|${language}|${category}`;
}

export const DOFORCE_SHARED_CACHE_KEY = buildDoforceCacheKey();

/** 榜单 L2 排行索引项：有序规范 id + 上游独有的星数 / 周期涨星 / Fork 数。 */
export interface TrendRankIndexItem {
  id: string;
  stars: number;
  starsGained?: number;
  forks?: number;
}

/**
 * 榜单 L2 快照信封 `v: 2`（`trend_board_cache.payload_json`）：只存排行索引，不含任何卡片字段；
 * 未收录卡片由 `repo_card_cache` 承接，读侧经 `hydrateCardsByIds` 批量水合。
 */
export interface TrendBoardIndexEnvelope {
  v: 2;
  items: TrendRankIndexItem[];
}

interface DbTrendBoardCacheRow {
  payload_json?: string;
  cached_at?: number;
}

/** 榜单行 → 规范坐标（`owner/repo` 优先，其次 `id`）；无法解析返回 undefined。 */
function trendRepoCoord(r: TrendRepo): { id: string; owner: string; repo: string } | undefined {
  const owner = typeof r.owner === 'string' ? r.owner.trim() : '';
  const repo = typeof r.repo === 'string' ? r.repo.trim() : '';
  if (owner && repo) {
    return { id: normalizeId(`${owner}/${repo}`), owner, repo };
  }
  const id = typeof r.id === 'string' ? normalizeId(r.id) : '';
  const [o, p, ...rest] = id.split('/');
  if (!o || !p || rest.length > 0 || id.includes(':')) return undefined;
  return { id, owner: o, repo: p };
}

function finiteCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}

/** 榜单 → 去重有序排行索引。 */
export function buildTrendRankIndex(repos: readonly TrendRepo[]): TrendRankIndexItem[] {
  const out: TrendRankIndexItem[] = [];
  const seen = new Set<string>();
  for (const r of repos ?? []) {
    if (!r || typeof r !== 'object') continue;
    const coord = trendRepoCoord(r);
    if (!coord || seen.has(coord.id)) continue;
    seen.add(coord.id);
    const item: TrendRankIndexItem = {
      id: coord.id,
      stars: Math.max(0, finiteCount(r.stars) ?? 0),
    };
    const gained = finiteCount(r.starsGained);
    if (gained !== undefined) item.starsGained = gained;
    const forks = finiteCount(r.forks);
    if (forks !== undefined) item.forks = forks;
    out.push(item);
  }
  return out;
}

function repoFromIndexItem(raw: unknown): TrendRepo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<TrendRankIndexItem>;
  const id = typeof item.id === 'string' ? normalizeId(item.id) : '';
  const [owner, repo, ...rest] = id.split('/');
  if (!owner || !repo || rest.length > 0 || id.includes(':')) return undefined;
  const out: TrendRepo = {
    id,
    name: id,
    owner,
    repo,
    stars: Math.max(0, finiteCount(item.stars) ?? 0),
    url: `https://github.com/${id}`,
  };
  const gained = finiteCount(item.starsGained);
  if (gained !== undefined) out.starsGained = gained;
  const forks = finiteCount(item.forks);
  if (forks !== undefined) out.forks = forks;
  return out;
}

/** 榜缓存 L2 读：仅接受 `{ v: 2, items }` 索引（其余视为 miss），默认扣减 0–30s 错峰抖动校验 TTL。 */
export async function getDbTrendCache(
  key: string,
  board?: string,
  opts?: { allowStale?: boolean },
): Promise<TrendRepo[] | undefined> {
  if (!isTauri) return undefined;
  try {
    const row = await tauriInvoke<DbTrendBoardCacheRow | null>(CMD.getTrendBoardCache, {
      cacheKey: key,
    });
    if (!row) return undefined;
    const payloadStr = row.payload_json;
    const cachedAtSec = row.cached_at;
    if (typeof payloadStr !== 'string' || typeof cachedAtSec !== 'number' || cachedAtSec <= 0) {
      return undefined;
    }
    const elapsedMs = Date.now() - cachedAtSec * 1000;
    if (!opts?.allowStale) {
      if (elapsedMs < 0) return undefined;
      const resolvedBoard = board ?? key.split('|')[0] ?? '';
      if (elapsedMs >= trendL2EffectiveTtlMs(trendDbTtlMs(resolvedBoard), key)) {
        return undefined;
      }
    }
    const parsed: unknown = JSON.parse(payloadStr);
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 2) {
      return undefined;
    }
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return undefined;
    const repos: TrendRepo[] = [];
    const seen = new Set<string>();
    for (const raw of items) {
      const repo = repoFromIndexItem(raw);
      if (!repo || seen.has(repo.id)) continue;
      seen.add(repo.id);
      repos.push(repo);
    }
    return repos.length > 0 ? repos : undefined;
  } catch {
    return undefined;
  }
}

/** 按榜单 key 串行写盘（同 key 后写覆盖先写，跨 key 互不阻塞）。 */
const writeBoardSerialized = createSerializedKeyWriter();

/** 榜缓存 L2 写：仅在抓榜成功时写入 `{ v: 2, items }` 排行索引，超 32 KiB 跳过。 */
export function saveDbTrendCache(key: string, board: string, repos: readonly TrendRepo[]): Promise<void> {
  if (!isTauri || !Array.isArray(repos) || repos.length === 0) return Promise.resolve();
  const items = buildTrendRankIndex(repos);
  if (items.length === 0) return Promise.resolve();
  const envelope: TrendBoardIndexEnvelope = { v: 2, items };
  const payloadJson = JSON.stringify(envelope);
  if (utf8ByteLength(payloadJson) > TREND_DB_PAYLOAD_MAX_BYTES) {
    zlogWarn(`[trends] persist skipped reason=payload-too-large key=${key} bytes=${utf8ByteLength(payloadJson)}`);
    return Promise.resolve();
  }
  return writeBoardSerialized(
    key,
    () => tauriInvoke(CMD.saveTrendBoardCache, { cacheKey: key, board, payloadJson }),
    (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      zlogWarn(`[trends] persist save failed key=${key} reason=${reason.slice(0, 160)}`);
    },
  );
}

/** 判断图标是否为 `data:` 内联 URI（仅用于展示，不写入持久富卡池）。 */
export function isDataIcon(icon: unknown): boolean {
  return typeof icon === 'string' && icon.trim().startsWith('data:');
}

/** 图标缺失判定：空串或 `data:` 视为缺失（重挂自愈共用）。 */
export function isMissingIconForDisplay(icon: unknown): boolean {
  if (typeof icon !== 'string') return true;
  if (icon.trim() === '') return true;
  return isDataIcon(icon);
}

/** 可入池图标判定：非缺失即实图。 */
export function isPersistableIcon(icon: unknown): boolean {
  return !isMissingIconForDisplay(icon);
}

/**
 * doforce 共享缓存单槽。
 */
let doforceSharedCache: { timestamp: number; data: TrendRepo[] } | undefined;
/** doforce 在途共享 Promise（并发的 rising/healthy 复用同一请求，防 2 连击）。 */
let doforceInflight: Promise<TrendRepo[]> | undefined;

export function readDoforceShared(): TrendRepo[] | undefined {
  if (!doforceSharedCache) return undefined;
  // elapsed<0 按过期。
  const elapsed = Date.now() - doforceSharedCache.timestamp;
  if (elapsed < 0) {
    doforceSharedCache = undefined;
    return undefined;
  }
  if (elapsed < DOFORCE_CACHE_TTL_MS) {
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

/** 清空榜缓存。 */
export function clearTrendsCache(): void {
  trendsCache.clear();
  doforceSharedCache = undefined;
  doforceInflight = undefined;
  clearTrendEnrichCache();
}
