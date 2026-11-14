/**
 * Star 同步快照（L2，SQLite `starred_feed_cache`）与查询目标记忆（localStorage）。
 *
 * - 快照信封 `{ v: 1, rows, pages, hasMore, emptyPages?, confirmedOther? }`：至多 3 页 / 60 条，
 *   入盘前剥离 `data:` 图标与收录态标注；超 256KB 先截长文本，再退到第 1 页，仍超即不写；
 * - 新鲜度由本模块判定：12h 内为新鲜；更旧的快照（后端保留 7 天）只作离线兜底与 SWR 首绘；
 * - `localStorage['zstore.starred.opts']` 只记查询模式与公开用户名，永不存仓库数据。
 */
import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import { TREND_DB_PAYLOAD_MAX_BYTES, utf8ByteLength } from '../trends';
import { stripCatalogAnnotations } from '../trends/enrich';

export const STARRED_OPTS_STORAGE_KEY = 'zstore.starred.opts';
/** 快照新鲜期：12h（与趋势榜 L2 同口径）。 */
export const STARRED_L2_TTL_MS = 12 * 60 * 60 * 1000;
export const STARRED_L2_MAX_PERSISTED_PAGES = 3;
export const STARRED_L2_MAX_PERSISTED_ROWS = 60;
const STARRED_L2_PAGE_ROWS = 20;
const TEXT_TRUNCATE_CHARS = 500;

export interface StarredCacheEnvelope {
  v: 1;
  rows: AppSummary[];
  pages: number;
  hasMore: boolean;
  emptyPages?: number[];
  confirmedOther?: string[];
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

function sanitizeRow(row: AppSummary): AppSummary {
  const clean = stripCatalogAnnotations(row);
  return typeof clean.icon === 'string' && clean.icon.startsWith('data:') ? { ...clean, icon: '' } : clean;
}

function truncateText(row: AppSummary): AppSummary {
  const cut = (v: string | null | undefined): string | null | undefined =>
    typeof v === 'string' && v.length > TEXT_TRUNCATE_CHARS ? v.slice(0, TEXT_TRUNCATE_CHARS) : v;
  return {
    ...row,
    description: cut(row.description) ?? '',
    description_en: cut(row.description_en) as AppSummary['description_en'],
    homepage: cut(row.homepage) as AppSummary['homepage'],
  };
}

/**
 * 入盘信封整形：截前 3 页 / 60 条（截断时 `hasMore` 置真，续拉从 `pages + 1` 接上），
 * 剥离 `data:` 与收录标注，并按 256KB 逐级降级；放弃写盘时返回 `undefined`。
 */
export function buildStarredEnvelopeJson(envelope: StarredCacheEnvelope): string | undefined {
  if (!Array.isArray(envelope.rows) || envelope.rows.length === 0) return undefined;
  const pages = Math.max(1, Math.min(Math.floor(envelope.pages) || 1, STARRED_L2_MAX_PERSISTED_PAGES));
  const truncatedByPages = envelope.pages > pages || envelope.rows.length > STARRED_L2_MAX_PERSISTED_ROWS;
  const rows = envelope.rows.slice(0, STARRED_L2_MAX_PERSISTED_ROWS).map(sanitizeRow);
  const ids = new Set(rows.map((r) => (r.id || '').toLowerCase()));
  const base: StarredCacheEnvelope = {
    v: 1,
    rows,
    pages,
    hasMore: envelope.hasMore || truncatedByPages,
  };
  const emptyPages = (envelope.emptyPages ?? []).filter((p) => Number.isInteger(p) && p >= 1 && p <= pages);
  if (emptyPages.length > 0) base.emptyPages = emptyPages;
  const confirmedOther = (envelope.confirmedOther ?? []).filter((k) => ids.has((k || '').toLowerCase()));
  if (confirmedOther.length > 0) base.confirmedOther = confirmedOther;

  const fits = (e: StarredCacheEnvelope): string | undefined => {
    const json = JSON.stringify(e);
    return utf8ByteLength(json) <= TREND_DB_PAYLOAD_MAX_BYTES ? json : undefined;
  };
  const full = fits(base);
  if (full) return full;
  const trimmed: StarredCacheEnvelope = { ...base, rows: base.rows.map(truncateText) };
  const shortText = fits(trimmed);
  if (shortText) return shortText;
  const firstPage: StarredCacheEnvelope = {
    ...trimmed,
    rows: trimmed.rows.slice(0, STARRED_L2_PAGE_ROWS),
    pages: 1,
    hasMore: true,
  };
  delete firstPage.emptyPages;
  return fits(firstPage);
}

function parseEnvelope(json: string): StarredCacheEnvelope | undefined {
  try {
    const parsed = JSON.parse(json) as Partial<StarredCacheEnvelope>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.rows) || parsed.rows.length === 0) return undefined;
    const rows = parsed.rows.filter(
      (r): r is AppSummary => !!r && typeof r === 'object' && typeof (r as AppSummary).id === 'string',
    );
    if (rows.length === 0) return undefined;
    return {
      v: 1,
      rows,
      pages: Math.max(1, Math.floor(Number(parsed.pages) || 1)),
      hasMore: parsed.hasMore === true,
      emptyPages: Array.isArray(parsed.emptyPages) ? parsed.emptyPages.filter(Number.isInteger) : undefined,
      confirmedOther: Array.isArray(parsed.confirmedOther)
        ? parsed.confirmedOther.filter((k): k is string => typeof k === 'string')
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface StarredL2Hit {
  envelope: StarredCacheEnvelope;
  cachedAt: number;
  isFresh: boolean;
}

/**
 * 读快照：形态不符或时钟回拨返回 `undefined`；超 12h 时仅在 `allowStale` 下返回（`isFresh=false`）。
 * 后端不可用/出错一律按未命中。
 */
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
