/**
 * Star 同步快照（SQLite `starred_feed_cache`）与查询目标记忆。
 * 快照仅保存前 3 页 / 60 个规范 id（12h 新鲜期），卡片经 `hydrateCardsByIds` 水合。
 */
import { tauriApi } from '../api';
import { normalizeId } from '../normalizeId';
import { utf8ByteLength } from '../trends';

export const STARRED_OPTS_STORAGE_KEY = 'zstore.starred.opts';
/** 快照新鲜期：12h（与趋势榜 L2 同口径）。 */
export const STARRED_L2_TTL_MS = 12 * 60 * 60 * 1000;
export const STARRED_L2_MAX_PERSISTED_PAGES = 3;
export const STARRED_L2_MAX_PERSISTED_ROWS = 60;
/** 快照前端预检上限 32 KiB（后端硬上限 64 KiB）。 */
export const STARRED_L2_MAX_BYTES = 32 * 1024;

export interface StarredPageIds {
  page: number;
  ids: string[];
}

export interface StarredCacheEnvelope {
  v: 2;
  pages: StarredPageIds[];
  hasMore: boolean;
}

export type StarredOpts = { mode: 'self' } | { mode: 'user'; username: string };

export function loadPersistedStarredOpts(): StarredOpts | null {
  try {
    const raw = window.localStorage.getItem(STARRED_OPTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ mode: string; username: string }>;
    if (parsed?.mode === 'self') return { mode: 'self' };
    if (parsed?.mode === 'user' && typeof parsed.username === 'string' && parsed.username.trim()) {
      return { mode: 'user', username: parsed.username.trim() };
    }
  } catch {
    // 隐私模式/存储不可用：按无记忆处理
  }
  return null;
}

export function persistStarredOpts(opts: StarredOpts): void {
  try {
    window.localStorage.setItem(STARRED_OPTS_STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // 配额/隐私模式：记忆是便利项，失败忽略
  }
}

/** 按页去重并截断为合法快照 JSON；空结果或超上限返回 `undefined`。 */
export function buildStarredEnvelopeJson(envelope: StarredCacheEnvelope): string | undefined {
  if (!envelope || !Array.isArray(envelope.pages)) return undefined;
  const sorted = envelope.pages
    .filter((p) => p && Number.isInteger(p.page) && p.page >= 1 && Array.isArray(p.ids))
    .sort((a, b) => a.page - b.page);
  const seen = new Set<string>();
  const pages: StarredPageIds[] = [];
  let total = 0;
  let truncated = false;
  for (const p of sorted) {
    if (pages.some((x) => x.page === p.page)) continue;
    if (p.page > STARRED_L2_MAX_PERSISTED_PAGES) {
      truncated = true;
      break;
    }
    const ids: string[] = [];
    for (const raw of p.ids) {
      const id = typeof raw === 'string' ? normalizeId(raw) : '';
      if (!id || seen.has(id)) continue;
      if (total >= STARRED_L2_MAX_PERSISTED_ROWS) {
        truncated = true;
        break;
      }
      seen.add(id);
      ids.push(id);
      total += 1;
    }
    pages.push({ page: p.page, ids });
    if (truncated) break;
  }
  if (total === 0) return undefined;
  const out: StarredCacheEnvelope = { v: 2, pages, hasMore: envelope.hasMore === true || truncated };
  const json = JSON.stringify(out);
  return utf8ByteLength(json) <= STARRED_L2_MAX_BYTES ? json : undefined;
}

function parseEnvelope(json: string): StarredCacheEnvelope | undefined {
  try {
    const parsed = JSON.parse(json) as Partial<StarredCacheEnvelope>;
    if (parsed?.v !== 2 || !Array.isArray(parsed.pages)) return undefined;
    const pages: StarredPageIds[] = [];
    let total = 0;
    for (const raw of parsed.pages) {
      if (!raw || typeof raw !== 'object') continue;
      const page = Number((raw as StarredPageIds).page);
      const rawIds = (raw as StarredPageIds).ids;
      if (!Number.isInteger(page) || page < 1 || !Array.isArray(rawIds)) continue;
      if (pages.some((p) => p.page === page)) continue;
      const ids = rawIds
        .map((id) => (typeof id === 'string' ? normalizeId(id) : ''))
        .filter((id) => id !== '');
      total += ids.length;
      pages.push({ page, ids });
    }
    if (total === 0) return undefined;
    pages.sort((a, b) => a.page - b.page);
    return { v: 2, pages, hasMore: parsed.hasMore === true };
  } catch {
    return undefined;
  }
}

export interface StarredL2Hit {
  envelope: StarredCacheEnvelope;
  cachedAt: number;
  isFresh: boolean;
}

/** 读 L2 快照（格式不符、时钟回拨或后端异常返回 `undefined`）。 */
export async function readDbStarredCache(
  cacheKey: string,
  opts?: { allowStale?: boolean; now?: number },
): Promise<StarredL2Hit | undefined> {
  const key = cacheKey.trim();
  if (!key) return undefined;
  let row: Awaited<ReturnType<typeof tauriApi.getStarredFeedCache>>;
  try {
    row = await tauriApi.getStarredFeedCache(key);
  } catch {
    return undefined;
  }
  if (!row) return undefined;
  const envelope = parseEnvelope(row.payload_json);
  if (!envelope) return undefined;
  const cachedAtMs = row.cached_at * 1000;
  const elapsed = (opts?.now ?? Date.now()) - cachedAtMs;
  if (elapsed < 0) return undefined;
  const isFresh = elapsed < STARRED_L2_TTL_MS;
  if (!isFresh && !opts?.allowStale) return undefined;
  return { envelope, cachedAt: cachedAtMs, isFresh };
}

const saveChains = new Map<string, Promise<void>>();

/** 写快照：同键串行（后写不被先写覆盖），失败静默。 */
export function saveDbStarredCache(
  cacheKey: string,
  ownerScope: string,
  envelope: StarredCacheEnvelope,
): Promise<void> {
  const key = cacheKey.trim();
  const scope = ownerScope.trim();
  if (!key || !scope) return Promise.resolve();
  const json = buildStarredEnvelopeJson(envelope);
  if (!json) return Promise.resolve();
  const prev = saveChains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => tauriApi.saveStarredFeedCache(key, scope, json))
    .catch(() => undefined);
  saveChains.set(key, next);
  void next.finally(() => {
    if (saveChains.get(key) === next) saveChains.delete(key);
  });
  return next;
}
