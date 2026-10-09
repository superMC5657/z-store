import type { AppSummary } from '../../types';
import { TREND_DB_PAYLOAD_MAX_BYTES, utf8ByteLength } from '../trends/cache';

/** 搜缓存。 */

/** 搜缓存 TTL 30min。 */
export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;
/** 搜缓存至多 50 条。 */
export const SEARCH_LIST_MAX_ENTRIES = 50;

export interface SearchListCacheEntry {
  at: number;
  ids: string[];
  rows: AppSummary[];
}

const searchListCache = new Map<string, SearchListCacheEntry>();

/** 归一搜索词：trim + 小写 + 连续空白（含全角/换行）压单空格；空串调用方拒绝写。 */
export function normalizeSearchQuery(query: string): string {
  if (typeof query !== 'string') return '';
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 缓存键 = search + 归一词 + 页码 + 页大小（翻页不串；大小写/多空格同键）。 */
export function buildSearchListCacheKey(query: string, page: number, perPage: number): string {
  const norm = normalizeSearchQuery(query);
  const p = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const pp = Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 1;
  return `search|${norm}|${p}|${pp}`;
}

function sanitizePage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
}

function sanitizePerPage(perPage: number): number {
  return Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 1;
}

/** 读搜缓存。 */
export function readSearchListCache(
  query: string,
  page: number,
  perPage: number,
): AppSummary[] | undefined {
  const norm = normalizeSearchQuery(query);
  if (!norm) return undefined;
  const key = buildSearchListCacheKey(query, sanitizePage(page), sanitizePerPage(perPage));
  const hit = searchListCache.get(key);
  if (!hit) return undefined;
  // 时钟钳制：elapsed<0（系统时钟回拨/未来戳）按过期处理，不返回 stale。
  const elapsed = Date.now() - hit.at;
  if (elapsed < 0) {
    searchListCache.delete(key);
    return undefined;
  }
  if (elapsed >= SEARCH_LIST_TTL_MS) {
    searchListCache.delete(key);
    return undefined;
  }
  return hit.rows;
}

/** 写搜缓存。 */
export function writeSearchListCache(
  query: string,
  page: number,
  perPage: number,
  rows: AppSummary[],
): void {
  const norm = normalizeSearchQuery(query);
  if (!norm) return;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const key = buildSearchListCacheKey(query, sanitizePage(page), sanitizePerPage(perPage));
  // 字节预检超限放弃写。
  try {
    const payloadJson = JSON.stringify(rows);
    if (utf8ByteLength(payloadJson) > TREND_DB_PAYLOAD_MAX_BYTES) return;
  } catch {
    return;
  }
  // 刷新写序：已存在先删再插，使其成为最新；新插入触发 FIFO 裁剪时删最旧。
  if (searchListCache.has(key)) searchListCache.delete(key);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = typeof r?.id === 'string' ? r.id.trim().toLowerCase() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  searchListCache.set(key, { at: Date.now(), ids, rows });
  while (searchListCache.size > SEARCH_LIST_MAX_ENTRIES) {
    const oldest = searchListCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === key) break;
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

/** 清空搜缓存。 */
export function clearSearchListCache(): void {
  searchListCache.clear();
}
