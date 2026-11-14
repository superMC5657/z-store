import type { AppSummary } from '../../types';
import { TREND_DB_PAYLOAD_MAX_BYTES, utf8ByteLength } from '../trends';
import { normalizeId } from '../normalizeId';

/**
 * 分页列表缓存：M1 内存。按命名空间分桶（缺省 `search`，Star 列表用 `starred`），
 * 桶内 key=`namespace|norm|page|perPage`，各桶独立 50 条 FIFO，互不挤占；
 * 写入后 5min 内为新鲜（调用方可零网络直出），5–30min 为可用但需后台重验，30min 起过期。
 * 无 timer（提交/翻页时 sweep）。
 */

/** 新鲜窗口：5min 内命中可零网络直出。 */
export const SEARCH_LIST_FRESH_MS = 5 * 60 * 1000;
/** 列表缓存总生存期 30min（超出即驱逐）。 */
export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;
/** 每个命名空间至多 50 条。 */
export const SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE = 50;

const DEFAULT_NAMESPACE = 'search';

interface SearchListCacheEntry {
  at: number;
  rows: AppSummary[];
}

/** 搜索列表键：归一词 + 页码 + 页大小，可选命名空间。 */
export interface SearchListKey {
  query: string;
  page: number;
  perPage: number;
  namespace?: string;
}

/** 带新鲜度的命中结果。 */
export interface SearchListCacheHit {
  rows: AppSummary[];
  at: number;
  isFresh: boolean;
}

/** 命名空间 → 桶（桶内 Map 保持写序，首键即最旧）。 */
const buckets = new Map<string, Map<string, SearchListCacheEntry>>();

function namespaceOf(ns: string | undefined): string {
  return typeof ns === 'string' && ns.trim() ? ns.trim() : DEFAULT_NAMESPACE;
}

function bucketFor(ns: string, create: boolean): Map<string, SearchListCacheEntry> | undefined {
  let b = buckets.get(ns);
  if (!b && create) {
    b = new Map();
    buckets.set(ns, b);
  }
  return b;
}

function* allEntries(): Generator<[string, SearchListCacheEntry, Map<string, SearchListCacheEntry>]> {
  for (const bucket of buckets.values()) {
    for (const [k, v] of bucket) yield [k, v, bucket];
  }
}

/** 归一搜索词：trim + 小写 + 连续空白（含全角/换行）压单空格；空串调用方拒绝写。 */
function normalizeSearchQuery(query: string): string {
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
function sanitizeSearchListKey(key: SearchListKey): {
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

/** 缓存键 = 命名空间 + 归一词 + 页码 + 页大小（翻页不串；大小写/多空格同键）。 */
function buildSearchListCacheKey(key: SearchListKey): string {
  const { norm, page, perPage } = sanitizeSearchListKey(key);
  return `${namespaceOf(key.namespace)}|${norm}|${page}|${perPage}`;
}

/** 在未过期的分页列表缓存中按归一 id 查找摘要（供详情弹窗首帧兜底）。 */
export function findInSearchListCache(id: string, namespace?: string): AppSummary | undefined {
  const target = normalizeId(id);
  if (!target) return undefined;
  const scoped =
    typeof namespace === 'string' && namespace.trim() ? bucketFor(namespace.trim(), false) : undefined;
  if (typeof namespace === 'string' && namespace.trim() && !scoped) return undefined;
  const now = Date.now();
  let match: AppSummary | undefined;
  const scan = (bucket: Map<string, SearchListCacheEntry>): void => {
    for (const entry of bucket.values()) {
      const elapsed = now - entry.at;
      if (elapsed < 0 || elapsed >= SEARCH_LIST_TTL_MS) continue;
      const hit = entry.rows.find((r) => normalizeId(r?.id) === target);
      if (hit) match = hit;
    }
  };
  if (scoped) scan(scoped);
  else for (const bucket of buckets.values()) scan(bucket);
  return match;
}

/**
 * 读列表缓存并给出新鲜度：时钟回拨（elapsed<0）或超 30min 即驱逐并返回 `undefined`；
 * 5min 内 `isFresh=true`。
 */
export function readSearchListCacheEntry(key: SearchListKey): SearchListCacheHit | undefined {
  const { norm } = sanitizeSearchListKey(key);
  if (!norm) return undefined;
  const bucket = bucketFor(namespaceOf(key.namespace), false);
  if (!bucket) return undefined;
  const cacheKey = buildSearchListCacheKey(key);
  const hit = bucket.get(cacheKey);
  if (!hit) return undefined;
  const elapsed = Date.now() - hit.at;
  if (elapsed < 0 || elapsed >= SEARCH_LIST_TTL_MS) {
    bucket.delete(cacheKey);
    return undefined;
  }
  return { rows: hit.rows, at: hit.at, isFresh: elapsed < SEARCH_LIST_FRESH_MS };
}

/** 读列表缓存（不区分新鲜度）。 */
export function readSearchListCache(key: SearchListKey): AppSummary[] | undefined {
  return readSearchListCacheEntry(key)?.rows;
}

/** 写列表缓存（同键刷新写序；超出本命名空间上限时淘汰本桶最旧条目）。 */
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
  const bucket = bucketFor(namespaceOf(key.namespace), true)!;
  if (bucket.has(cacheKey)) bucket.delete(cacheKey);
  bucket.set(cacheKey, { at: Date.now(), rows });
  while (bucket.size > SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE) {
    const oldest = bucket.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === cacheKey) break;
    bucket.delete(oldest);
  }
}

/** 后台重验确认内容未变时续期：`at` 刷新为当前时刻（未命中即无操作）。 */
export function touchSearchListCache(key: SearchListKey): void {
  const { norm } = sanitizeSearchListKey(key);
  if (!norm) return;
  const hit = bucketFor(namespaceOf(key.namespace), false)?.get(buildSearchListCacheKey(key));
  if (hit) hit.at = Date.now();
}

/** sweep 过期。 */
export function sweepExpiredSearchListCache(): void {
  const now = Date.now();
  for (const [k, v, bucket] of allEntries()) {
    const elapsed = now - v.at;
    if (elapsed < 0 || elapsed >= SEARCH_LIST_TTL_MS) bucket.delete(k);
  }
}

/** 清空全部命名空间。 */
export function clearSearchListCache(): void {
  buckets.clear();
}

/**
 * 清空一个命名空间；给出 `queryPrefix` 时只删归一词以该前缀开头的条目
 * （如登出时清 `starred` 下的 `@me:` 私有列表）。
 */
export function clearSearchListCacheNamespace(namespace: string, queryPrefix?: string): void {
  const ns = namespaceOf(namespace);
  const bucket = buckets.get(ns);
  if (!bucket) return;
  const prefix = typeof queryPrefix === 'string' ? normalizeSearchQuery(queryPrefix) : '';
  if (!prefix) {
    buckets.delete(ns);
    return;
  }
  const keyPrefix = `${ns}|${prefix}`;
  for (const k of [...bucket.keys()]) {
    if (k.startsWith(keyPrefix)) bucket.delete(k);
  }
}

/**
 * 图标就绪写透搜索列表缓存行（翻页一致性）：
 * 按归一规范应用标识更新全部缓存条目中同 id 行的图标（大小写归一），
 * 使翻页回访/重搜命中即新图，不出现翻页丢图；
 * 条目 `at` 不续期（图标更新不代表数据新鲜，TTL 仍按写入时刻计）。
 * L5 显式空（`icon:''`）亦写透（用户切徽章后回访同页即徽章，不复活旧图）；
 * 未命中 id 即无操作。
 */
export function patchSearchListCacheIcon(targetIdLower: string, icon: string): void {
  const norm = normalizeId(targetIdLower);
  if (!norm) return;
  if (typeof icon !== 'string') return;
  for (const [, entry] of allEntries()) {
    let changed = false;
    const rows = entry.rows.map((r) => {
      if (!r || normalizeId(r?.id) !== norm) return r;
      if (r.icon === icon) return r;
      changed = true;
      return { ...r, icon };
    });
    if (changed) entry.rows = rows;
  }
}

type SearchListPatchSubscriber = (patcher: (rows: AppSummary[]) => AppSummary[]) => void;
const searchListPatchSubscribers = new Set<SearchListPatchSubscriber>();

/**
 * 订阅详情/平台回填对分页缓存行的写透补丁：
 * 持有独立本地列表状态的分页视图（如 StarredFeed）据此同步刷新当前已挂载行。
 */
export function subscribeSearchListCachePatches(fn: SearchListPatchSubscriber): () => void {
  searchListPatchSubscribers.add(fn);
  return () => {
    searchListPatchSubscribers.delete(fn);
  };
}

/**
 * 详情更新写透搜索列表缓存行：
 * 当用户在搜索结果或其他列表打开应用详情拿到最新星数、版本、描述、协议、平台、主页等字段时，
 * 同步更新搜索列表缓存中的所有匹配行（不续期 `at`），并通知已订阅的活跃分页列表。
 */
export function patchSearchListCacheRows(
  patcher: (rows: AppSummary[]) => AppSummary[],
): void {
  if (typeof patcher !== 'function') return;
  for (const [, entry] of allEntries()) {
    const next = patcher(entry.rows);
    if (next !== entry.rows && Array.isArray(next)) {
      entry.rows = next;
    }
  }
  if (searchListPatchSubscribers.size > 0) {
    for (const fn of [...searchListPatchSubscribers]) {
      try {
        fn(patcher);
      } catch {
        // 单订阅者失败不阻塞其余缓存同步
      }
    }
  }
}
