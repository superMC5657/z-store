import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import { utf8ByteLength } from '../trends';
import { normalizeId } from '../normalizeId';
import { recordSharedRepoCards } from '../repoEnrichCache';
import { createSerializedKeyWriter } from '../../lib/serializedKeyWriter';

/**
 * 分页列表缓存（L1 内存按命名空间分桶存 id 索引 + 共享卡片表；L2 SQLite 存 `search_list_cache` 快照）。
 * 写入后 5min 内为新鲜，30min 起过期；含私有仓库条目随登出清除。
 */

/** 新鲜窗口：5min 内命中可零网络直出。 */
export const SEARCH_LIST_FRESH_MS = 5 * 60 * 1000;
/** 列表缓存总生存期 30min（超出即驱逐）。 */
export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;
/** 每个命名空间至多 50 条。 */
export const SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE = 50;
/** L2 快照前端预检上限 32 KiB（后端硬上限 64 KiB）。 */
const SEARCH_LIST_DB_MAX_BYTES = 32 * 1024;

const DEFAULT_NAMESPACE = 'search';

interface SearchListIndexEntry {
  at: number;
  ids: string[];
  hasMore: boolean;
  hasPrivate?: boolean;
}

/** 搜索列表键：归一词 + 页码 + 页大小，可选命名空间。 */
interface SearchListKey {
  query: string;
  page: number;
  perPage: number;
  namespace?: string;
}

/** 带新鲜度的命中结果（`rows` 由 `ids` 经卡片表解析）。 */
interface SearchListCacheHit {
  rows: AppSummary[];
  ids: string[];
  hasMore: boolean;
  hasPrivate: boolean;
  at: number;
  isFresh: boolean;
}

/** 命名空间 → 桶（桶内 Map 保持写序，首键即最旧）。 */
const buckets = new Map<string, Map<string, SearchListIndexEntry>>();
/** 归一 id → 卡片（全部命名空间共享一份；无条目引用的 id 随 GC 移除）。 */
const cardStore = new Map<string, AppSummary>();

function namespaceOf(ns: string | undefined): string {
  return typeof ns === 'string' && ns.trim() ? ns.trim() : DEFAULT_NAMESPACE;
}

function bucketFor(ns: string, create: boolean): Map<string, SearchListIndexEntry> | undefined {
  let b = buckets.get(ns);
  if (!b && create) {
    b = new Map();
    buckets.set(ns, b);
  }
  return b;
}

function* allEntries(): Generator<[string, SearchListIndexEntry, Map<string, SearchListIndexEntry>]> {
  for (const bucket of buckets.values()) {
    for (const [k, v] of bucket) yield [k, v, bucket];
  }
}

/** 移除不再被任何条目引用的卡片。 */
function gcCardStore(): void {
  if (cardStore.size === 0) return;
  const referenced = new Set<string>();
  for (const [, entry] of allEntries()) {
    for (const id of entry.ids) referenced.add(id);
  }
  for (const id of [...cardStore.keys()]) {
    if (!referenced.has(id)) cardStore.delete(id);
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

function resolveRows(ids: readonly string[]): AppSummary[] {
  const rows: AppSummary[] = [];
  for (const id of ids) {
    const row = cardStore.get(id);
    if (row) rows.push(row);
  }
  return rows;
}

function isLive(entry: SearchListIndexEntry, now: number): boolean {
  const elapsed = now - entry.at;
  return elapsed >= 0 && elapsed < SEARCH_LIST_TTL_MS;
}

/** 在未过期的分页列表缓存中按归一 id 查找摘要（供详情弹窗首帧兜底）。 */
export function findInSearchListCache(id: string, namespace?: string): AppSummary | undefined {
  const target = normalizeId(id);
  if (!target) return undefined;
  const card = cardStore.get(target);
  if (!card) return undefined;
  const scoped =
    typeof namespace === 'string' && namespace.trim() ? bucketFor(namespace.trim(), false) : undefined;
  if (typeof namespace === 'string' && namespace.trim() && !scoped) return undefined;
  const now = Date.now();
  const referencedIn = (bucket: Map<string, SearchListIndexEntry>): boolean => {
    for (const entry of bucket.values()) {
      if (isLive(entry, now) && entry.ids.includes(target)) return true;
    }
    return false;
  };
  if (scoped) return referencedIn(scoped) ? card : undefined;
  for (const bucket of buckets.values()) {
    if (referencedIn(bucket)) return card;
  }
  return undefined;
}

/** 读列表缓存并附带新鲜度；时钟回拨或超时驱逐并返回 `undefined`。 */
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
    gcCardStore();
    return undefined;
  }
  return {
    rows: resolveRows(hit.ids),
    ids: [...hit.ids],
    hasMore: hit.hasMore,
    hasPrivate: hit.hasPrivate === true,
    at: hit.at,
    isFresh: elapsed < SEARCH_LIST_FRESH_MS,
  };
}

interface WriteSearchListOptions {
  /** 缺省按「本页行数 ≥ 页大小」推断。 */
  hasMore?: boolean;
  /** 本页含私有仓库（登出时清除）。 */
  hasPrivate?: boolean;
}

/** 写列表缓存（卡片存入共享表并同步 `repoEnrichCache`），超限时淘汰同桶最旧条目。 */
export function writeSearchListCache(
  key: SearchListKey,
  rows: AppSummary[],
  opts?: WriteSearchListOptions,
): void {
  const { norm, perPage } = sanitizeSearchListKey(key);
  if (!norm) return;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const ids: string[] = [];
  const cards: AppSummary[] = [];
  for (const row of rows) {
    const id = normalizeId(row?.id);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    cards.push(row);
  }
  if (ids.length === 0) return;
  // 字节预检超限放弃写。
  if (utf8ByteLength(JSON.stringify(ids)) > SEARCH_LIST_DB_MAX_BYTES) return;
  ids.forEach((id, i) => cardStore.set(id, cards[i]));
  recordSharedRepoCards(cards);
  const cacheKey = buildSearchListCacheKey(key);
  const bucket = bucketFor(namespaceOf(key.namespace), true)!;
  if (bucket.has(cacheKey)) bucket.delete(cacheKey);
  bucket.set(cacheKey, {
    at: Date.now(),
    ids,
    hasMore: typeof opts?.hasMore === 'boolean' ? opts.hasMore : rows.length >= perPage,
    ...(opts?.hasPrivate === true ? { hasPrivate: true } : {}),
  });
  let evicted = false;
  while (bucket.size > SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE) {
    const oldest = bucket.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === cacheKey) break;
    bucket.delete(oldest);
    evicted = true;
  }
  if (evicted) gcCardStore();
}

/** sweep 过期。 */
export function sweepExpiredSearchListCache(): void {
  const now = Date.now();
  let removed = false;
  for (const [k, v, bucket] of allEntries()) {
    if (!isLive(v, now)) {
      bucket.delete(k);
      removed = true;
    }
  }
  if (removed) gcCardStore();
}

/** 清空全部命名空间。 */
export function clearSearchListCache(): void {
  buckets.clear();
  cardStore.clear();
}

/** 清空指定命名空间（传入 `queryPrefix` 时仅删匹配前缀的条目）。 */
export function clearSearchListCacheNamespace(namespace: string, queryPrefix?: string): void {
  const ns = namespaceOf(namespace);
  const bucket = buckets.get(ns);
  if (!bucket) return;
  const prefix = typeof queryPrefix === 'string' ? normalizeSearchQuery(queryPrefix) : '';
  if (!prefix) {
    buckets.delete(ns);
  } else {
    const keyPrefix = `${ns}|${prefix}`;
    for (const k of [...bucket.keys()]) {
      if (k.startsWith(keyPrefix)) bucket.delete(k);
    }
  }
  gcCardStore();
}

/** 登出：清除在线搜索命名空间中含私有仓库的条目。 */
export function clearPrivateSearchListCacheEntries(): void {
  const bucket = buckets.get(DEFAULT_NAMESPACE);
  if (!bucket) return;
  for (const [k, entry] of [...bucket]) {
    if (entry.hasPrivate) bucket.delete(k);
  }
  gcCardStore();
}

/** 将就绪图标写入共享卡片表（不续期条目 `at`）。 */
export function patchSearchListCacheIcon(targetIdLower: string, icon: string): void {
  const norm = normalizeId(targetIdLower);
  if (!norm) return;
  if (typeof icon !== 'string') return;
  const row = cardStore.get(norm);
  if (!row || row.icon === icon) return;
  cardStore.set(norm, { ...row, icon });
}

type SearchListPatchSubscriber = (patcher: (rows: AppSummary[]) => AppSummary[]) => void;
const searchListPatchSubscribers = new Set<SearchListPatchSubscriber>();

/** 订阅分页缓存行的写透补丁通知。 */
export function subscribeSearchListCachePatches(fn: SearchListPatchSubscriber): () => void {
  searchListPatchSubscribers.add(fn);
  return () => {
    searchListPatchSubscribers.delete(fn);
  };
}

/**
 * 详情/平台更新写透卡片表：补丁对全部卡片执行一次（不续期 `at`），并通知已订阅的活跃分页列表。
 */
export function patchSearchListCacheRows(
  patcher: (rows: AppSummary[]) => AppSummary[],
): void {
  if (typeof patcher !== 'function') return;
  if (cardStore.size > 0) {
    const ids = [...cardStore.keys()];
    const before = ids.map((id) => cardStore.get(id)!);
    const after = patcher(before);
    if (after !== before && Array.isArray(after)) {
      for (const row of after) {
        const id = normalizeId(row?.id);
        if (id && cardStore.has(id)) cardStore.set(id, row);
      }
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

/** L2 快照信封（`search_list_cache.payload_json`）。 */
interface SearchListIndexEnvelope {
  v: 2;
  ids: string[];
  hasMore: boolean;
}

/** L2 键：`"{normQuery}|{page}|{perPage}"`。 */
export function buildSearchListDbKey(
  query: string,
  page: number,
  perPage: number,
): { cacheKey: string; normQuery: string } {
  const normQuery = normalizeSearchQuery(query);
  return {
    cacheKey: `${normQuery}|${sanitizePage(page)}|${sanitizePerPage(perPage)}`,
    normQuery,
  };
}

function parseSearchListEnvelope(json: string): SearchListIndexEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const env = parsed as Partial<SearchListIndexEnvelope>;
  if (env.v !== 2 || !Array.isArray(env.ids)) return undefined;
  const ids: string[] = [];
  for (const raw of env.ids) {
    const id = typeof raw === 'string' ? normalizeId(raw) : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return undefined;
  return { v: 2, ids, hasMore: env.hasMore === true };
}

interface SearchListDbHit {
  ids: string[];
  hasMore: boolean;
  /** 快照含私有仓库：回填 L1 时须带上，否则登出清不掉。 */
  hasPrivate: boolean;
  /** 落库时刻（毫秒）。 */
  cachedAt: number;
  /** 5min 内：可零网络直出。 */
  isFresh: boolean;
  /** 30min 内：可作翻页/首绘快照（之后需后台重验）。 */
  withinTtl: boolean;
}

/** 读 L2 快照（拒绝非 `v: 2`、空 id 或时钟回拨；缺省仅返回 TTL 内快照）。 */
export async function readDbSearchListCache(
  key: SearchListKey,
  opts?: { allowStale?: boolean; now?: number },
): Promise<SearchListDbHit | undefined> {
  const { cacheKey, normQuery } = buildSearchListDbKey(key.query, key.page, key.perPage);
  if (!normQuery) return undefined;
  let row: Awaited<ReturnType<typeof tauriApi.getSearchListCache>>;
  try {
    row = await tauriApi.getSearchListCache(cacheKey);
  } catch {
    return undefined;
  }
  if (!row) return undefined;
  const env = parseSearchListEnvelope(row.payload_json);
  if (!env) return undefined;
  const cachedAt = row.cached_at * 1000;
  const elapsed = (opts?.now ?? Date.now()) - cachedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const withinTtl = elapsed < SEARCH_LIST_TTL_MS;
  if (!withinTtl && opts?.allowStale !== true) return undefined;
  return {
    ids: env.ids,
    hasMore: env.hasMore,
    hasPrivate: row.has_private === true,
    cachedAt,
    isFresh: elapsed < SEARCH_LIST_FRESH_MS,
    withinTtl,
  };
}

/** 同键 L2 写入串行（后写覆盖先写，避免乱序落盘）。 */
const writeDbSerialized = createSerializedKeyWriter();

/** 写 L2 快照 `{ v: 2, ids, hasMore }`：空 id 或超 32 KiB 跳过；失败静默（下次搜索重写）。 */
export function saveDbSearchListCache(
  key: SearchListKey,
  ids: readonly string[],
  hasMore: boolean,
  hasPrivate = false,
): Promise<void> {
  const { cacheKey, normQuery } = buildSearchListDbKey(key.query, key.page, key.perPage);
  const clean: string[] = [];
  for (const raw of ids ?? []) {
    const id = typeof raw === 'string' ? normalizeId(raw) : '';
    if (id && !clean.includes(id)) clean.push(id);
  }
  if (!normQuery || clean.length === 0) return Promise.resolve();
  const envelope: SearchListIndexEnvelope = { v: 2, ids: clean, hasMore: hasMore === true };
  const payloadJson = JSON.stringify(envelope);
  if (utf8ByteLength(payloadJson) > SEARCH_LIST_DB_MAX_BYTES) return Promise.resolve();
  return writeDbSerialized(cacheKey, () =>
    tauriApi.saveSearchListCache(cacheKey, normQuery, payloadJson, hasPrivate),
  );
}
