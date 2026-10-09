import type { AppSummary } from '../../types';
import { TREND_DB_PAYLOAD_MAX_BYTES, utf8ByteLength } from '../trends/cache';

/**
 * 搜索 L1 列表缓存（含平台+图标，纯前端内存）：
 * - 独立 Map，不共用 trendsCache 实例（防 key 串、TTL 串）；
 * - key=`search|normQuery|page|perPage`（normQuery=trim 小写连续空白压单空格，空串拒绝写）；
 * - value=`{at, ids, rows}`（rows 为当次页 rows，非累计；pending 空平台可存列表）；
 * - TTL 30min；空结果不存（与 saveDbTrendCache 空榜不污染 L2 同思想，二选一写死为“不存”）；
 * - 上限 50 条 FIFO（写时删最旧，不加 timer）；
 * - sweep 由 handleSearchSubmit/handleOnlineLoadMore 入口顺手调用
 *  （抄 services/trends/boards.ts:357 fetchTrendsResult，不加 setInterval timer）；
 * - 字节预检复用 services/trends/cache.ts utf8ByteLength + 256KB 阈值思想
 *  （TREND_DB_PAYLOAD_MAX_BYTES），超限放弃写。
 * - 不碰 L2（board='search' 灰度另议），不碰 iconStore/AppIcon/TrendsView。
 */

/** 搜索 L1 列表 TTL：30min（非空结果）。 */
export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;
/** 搜索 L1 内存有界：至多 50 条，写时 FIFO 删最旧。 */
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

/** 读 L1：命中且未过期返回 rows；过期/时钟回拨按 miss（删键返回 undefined，调用方保留旧列表）。 */
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

/**
 * 写 L1：仅当次页 rows（非累计）；空 norm/空 rows 拒绝写（空结果不存，二选一写死）；
 * 写前 JSON 字节预检超 256KB 放弃写；刷新写序 + FIFO 裁剪至 50 条。
 */
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
  // 字节预检（抄 saveDbTrendCache FE 预检思想）：超限放弃写，不抛错。
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

/**
 * 切搜/翻页顺手 sweep 过期（handleSearchSubmit/handleOnlineLoadMore 入口调用，不加 timer）。
 * elapsed<0（时钟回拨）按过期。
 */
export function sweepExpiredSearchListCache(): void {
  const now = Date.now();
  for (const [k, v] of searchListCache) {
    const elapsed = now - v.at;
    if (elapsed < 0 || elapsed >= SEARCH_LIST_TTL_MS) searchListCache.delete(k);
  }
}

/** 仅供测试：清空搜索 L1。 */
export function clearSearchListCache(): void {
  searchListCache.clear();
}
