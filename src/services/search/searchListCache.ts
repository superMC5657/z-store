import type { AppSummary } from '../../types';
import { TREND_DB_PAYLOAD_MAX_BYTES, utf8ByteLength } from '../trends/cache';
import { normalizeIdSet } from '../normalizeId';

/** 搜索列表缓存：M1 内存。key=`search|norm|page|perPage`，TTL 30min，50 条 FIFO，无 timer（提交/翻页时 sweep）。 */

/** 搜索列表缓存 TTL 30min。 */
export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;
/** 搜索列表缓存至多 50 条。 */
export const SEARCH_LIST_MAX_ENTRIES = 50;

export interface SearchListCacheEntry {
  at: number;
  ids: string[];
  rows: AppSummary[];
}

/** 搜索列表键：归一词 + 页码 + 页大小。 */
export interface SearchListKey {
  query: string;
  page: number;
  perPage: number;
}

const searchListCache = new Map<string, SearchListCacheEntry>();

/** 归一搜索词：trim + 小写 + 连续空白（含全角/换行）压单空格；空串调用方拒绝写。 */
export function normalizeSearchQuery(query: string): string {
  if (typeof query !== 'string') return '';
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizePage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
}

function sanitizePerPage(perPage: number): number {
  return Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 1;
}

/** 归一键：词归一 + 页码/页大小钳制。 */
export function sanitizeSearchListKey(key: SearchListKey): {
  norm: string;
  page: number;
  perPage: number;
} {
  return {
    norm: normalizeSearchQuery(key.query),
    page: sanitizePage(key.page),
    perPage: sanitizePerPage(key.perPage),
  };
}

/** 缓存键 = search + 归一词 + 页码 + 页大小（翻页不串；大小写/多空格同键）。 */
export function buildSearchListCacheKey(key: SearchListKey): string {
  const { norm, page, perPage } = sanitizeSearchListKey(key);
  return `search|${norm}|${page}|${perPage}`;
}

/** 读搜索列表缓存。 */
export function readSearchListCache(key: SearchListKey): AppSummary[] | undefined {
  const { norm } = sanitizeSearchListKey(key);
  if (!norm) return undefined;
  const cacheKey = buildSearchListCacheKey(key);
  const hit = searchListCache.get(cacheKey);
  if (!hit) return undefined;
  // 时钟钳制：elapsed<0（系统时钟回拨/未来戳）按过期处理，不返回 stale。
  const elapsed = Date.now() - hit.at;
  if (elapsed < 0) {
    searchListCache.delete(cacheKey);
    return undefined;
  }
  if (elapsed >= SEARCH_LIST_TTL_MS) {
    searchListCache.delete(cacheKey);
    return undefined;
  }
  return hit.rows;
}

/** 写搜索列表缓存。 */
export function writeSearchListCache(key: SearchListKey, rows: AppSummary[]): void {
  const { norm } = sanitizeSearchListKey(key);
  if (!norm) return;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const cacheKey = buildSearchListCacheKey(key);
  // 字节预检超限放弃写。
  try {
    const payloadJson = JSON.stringify(rows);
    if (utf8ByteLength(payloadJson) > TREND_DB_PAYLOAD_MAX_BYTES) return;
  } catch {
    return;
  }
  // 刷新写序：已存在先删再插，使其成为最新；新插入触发 FIFO 裁剪时删最旧。
  if (searchListCache.has(cacheKey)) searchListCache.delete(cacheKey);
  const ids = normalizeIdSet(rows.map((r) => r?.id));
  searchListCache.set(cacheKey, { at: Date.now(), ids, rows });
  while (searchListCache.size > SEARCH_LIST_MAX_ENTRIES) {
    const oldest = searchListCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === cacheKey) break;
    searchListCache.delete(oldest);
  }
}

/** sweep 过期。 */
export function sweepExpiredSearchListCache(): void {
  const now = Date.now();
  for (const [k, v] of searchListCache) {
    const elapsed = now - v.at;
    if (elapsed < 0 || elapsed >= SEARCH_LIST_TTL_MS) searchListCache.delete(k);
  }
}

/** 清空搜索列表缓存。 */
export function clearSearchListCache(): void {
  searchListCache.clear();
}
