import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo } from '../../types';
import { isTauri, tauriInvoke } from '../api/client';
import {
  clearTrendEnrichCache,
  hydrateTrendConfirmedOtherCache,
  hydrateTrendEnrichCache,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
} from './enrich';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 默认内存缓存回落（未知榜；daily/weekly/monthly/new 均为显式分档见 trendsBoardTtlMs；仅成功结果写入；rising/healthy 除外，见下）
/**
 * doforce 源数据共享缓存 TTL：12h。
 * 日榜粒度数据日内几乎不变，长缓存 + 两榜共享把远端命中压到最低。
 */
export const DOFORCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 榜缓存二级落盘默认 TTL：12h。 */
export const TREND_DB_TTL_MS = 12 * 60 * 60 * 1000;
/** 榜缓存二级落盘 daily 榜 TTL：1h。 */
export const TREND_DB_DAILY_TTL_MS = 60 * 60 * 1000;
/** 429 单次重试的最大等待：60s；超过即直接 error，不再等待。 */
export const DOFORCE_RETRY_MAX_WAIT_MS = 60_000;
/** 429 错误串无 Retry-After 可用时的默认等待（Rust 侧当前仅回传状态码）。 */
export const DOFORCE_RETRY_DEFAULT_WAIT_MS = 5_000;
export const TRENDING_TIMEOUT_MS = 10_000; // github.com/trending HTML 抓取 10s 熔断
export const DOFORCE_TIMEOUT_MS = 10_000; // doforce API 10s 熔断（Rust 侧执行）
export const GITHUB_SEARCH_TIMEOUT_MS = 10_000; // GitHub Search 主源 10s 熔断

/** 榜缓存一级内存至多 200 条，写时 FIFO 删最旧。 */
export const TRENDS_CACHE_MAX_ENTRIES = 200;
/** 写盘前 UTF-8 预检上限 256KB。 */
export const TREND_DB_PAYLOAD_MAX_BYTES = 256 * 1024;
/** 榜缓存二级落盘读错峰抖动上限 30s。 */
export const TREND_L2_JITTER_MAX_MS = 30_000;

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

/** 缓存键 = board + language + category（P1 要求，统一口径；C3：三段归一 trim().toLowerCase()，读写同源）。 */
export function buildTrendsCacheKey(board: TrendBoardId, opts: FetchTrendsOptions = {}): string {
  const language = (opts.language ?? '').trim().toLowerCase();
  const category = (opts.category ?? '').trim().toLowerCase();
  return `${board}|${language}|${category}`;
}

/** 旧 key 兼容读一次。 */
export function buildLegacyTrendsCacheKey(board: TrendBoardId, opts: FetchTrendsOptions = {}): string {
  return `${board}|${opts.language ?? ''}|${opts.category ?? ''}`;
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
  // Phase2治理时钟钳制：elapsed<0（系统时钟回拨/未来戳）按过期处理，不返回 stale。
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
  const language = (opts.language ?? '').trim().toLowerCase();
  const category = (opts.category ?? '').trim().toLowerCase();
  return `doforce|${language}|${category}`;
}

export const DOFORCE_SHARED_CACHE_KEY = buildDoforceCacheKey();

export const CMD_GET_TREND_BOARD_CACHE = 'get_trend_board_cache';
export const CMD_SAVE_TREND_BOARD_CACHE = 'save_trend_board_cache';

/**
 * 榜单持久化信封 v1：
 * 包装榜单裸仓列表与对应的坐标 enrich 派生摘要。
 * enrich 键为小写 `owner/repo`，收录具真实平台与 pending 空平台条目（SWR 首屏直展，Other 待确认语义）；
 * 仅禁 dataURI（图标 data: 开头一律不进盘）。
 * confirmedOther 为已确认 Other 键集。
 * 新鲜度复用 `cached_at` + 按榜 TTL。
 */
export interface TrendCacheEnvelopeV1 {
  v: 1;
  repos: TrendRepo[];
  enrich?: Record<string, AppSummary>;
  confirmedOther?: string[];
}

interface DbTrendBoardCacheRow {
  payload_json?: string;
  cached_at?: number;
}

/**
 * 榜缓存二级落盘读：
 * - 双形状解析：
 *   1) 纯数组 Array → 旧格式兼容，直接返回 TrendRepo[]；
 *   2) { v: 1, repos, enrich } 信封 → 新格式，repos 必须非空数组，enrich 逐项守卫后调 hydrateTrendEnrichCache 载入内存，并返回 repos；
 * - 命中且未过期返回解析后的 TrendRepo[]；过期判定含 Phase2 错峰抖动（见下）；
 * - 命令未就绪 / DB 损坏 / 反序列化失败 / 已过期一律降级返回 undefined（视为 miss 走网络）。
 * Phase2治理：
 * - 时钟钳制 elapsed<0 按过期；
 * - 读抖动 0-30s，只扣减不延长。
 */
export async function getDbTrendCache(key: string, board?: string): Promise<TrendRepo[] | undefined> {
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

    const elapsedMs = Date.now() - cachedAtSec * 1000;
    if (elapsedMs < 0) return undefined;
    const resolvedBoard = board ?? key.split('|')[0] ?? '';
    if (elapsedMs >= trendL2EffectiveTtlMs(trendDbTtlMs(resolvedBoard), key)) {
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

      // enrich 逐项守卫：id/owner/repo 非空即保留（无 token 时慢探不跑，enrich 常无图标，
      // 重启直展要求 pending 允许 icon 空）；仅禁 dataURI；platforms 仅要求为数组。
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
            !(
              typeof candidate.icon === 'string' &&
              candidate.icon.startsWith('data:')
            ) &&
            Array.isArray(candidate.platforms)
          ) {
            guardedEnrich[rawKey.trim().toLowerCase()] = item as AppSummary;
          }
        }
      }

      hydrateTrendEnrichCache(guardedEnrich);
      // 已确认 Other 回填：与 enrich 同 key 落盘，data 禁入已由 enrich 守卫保证；
      // 此处仅收非空小写键并 hydrate 进内存（具平台键由 hydrate 侧跳过，到期由 TTL 重验）。
      const rawConfirmed = (envelope as { confirmedOther?: unknown }).confirmedOther;
      let guardedConfirmed: string[] = [];
      if (Array.isArray(rawConfirmed)) {
        const seen = new Set<string>();
        for (const raw of rawConfirmed) {
          if (typeof raw !== 'string') continue;
          const k = raw.trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          guardedConfirmed.push(k);
        }
        if (guardedConfirmed.length > 0) {
          hydrateTrendConfirmedOtherCache(guardedConfirmed);
        }
      }
      const repos = envelope.repos as TrendRepo[] & {
        enrich?: Record<string, AppSummary>;
        confirmedOther?: string[];
      };
      if (Object.keys(guardedEnrich).length > 0) {
        repos.enrich = guardedEnrich;
      }
      if (guardedConfirmed.length > 0) {
        repos.confirmedOther = guardedConfirmed;
      }
      return repos;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 榜缓存二级落盘写。
 * - 第 4 参 enrich 可选：无参保持旧数组 JSON 写入；有参且合法时写入 { v: 1, repos, enrich } 信封。
 * - 第 5 参 confirmedOther 可选：已确认 Other 键集（小写），与 enrich 同 key 落盘（data 仍禁由 enrich 守卫保证）；
 *   具平台键调用方已过滤，此处再做一次去重归一；为空即省略字段（旧盘兼容）。
 * - SWR 富信封：pending 空平台随信封落盘（首屏直展 pending 卡，Other 待确认语义）；仅禁 dataURI。
 * - 已确认 Other 同信封落盘：settle 兜底 / lite 空非 stale 确认后按正常 enrich 同 key 写透，重挂免验直展 Other 卡；
 *   具平台到达即移除（可覆盖升级），按榜窗口（daily 1h，其余 12h）由 cached_at + 按榜 TTL 把关，到期重验。
 * - Phase2治理字节上限：FE utf8ByteLength 预检 256KB；超限先丢 confirmed 再降级裸榜，仍超限放弃写盘。
 *   BE 512KiB 硬拒绝保持（见 db/cache.rs TREND_BOARD_CACHE_MAX_BYTES），FE 预检避免无谓 invoke。
 * - 空榜不写盘。
 */
export async function saveDbTrendCache(
  key: string,
  board: string,
  repos: TrendRepo[],
  enrich?: Record<string, AppSummary>,
  confirmedOther?: readonly string[],
): Promise<void> {
  if (!isTauri || !Array.isArray(repos) || repos.length === 0) return;
  try {
    let payloadJson: string;
    if (enrich !== undefined) {
      const sanitizedEnrich: Record<string, AppSummary> = {};
      for (const [k, summary] of Object.entries(enrich)) {
        if (!summary || typeof summary !== 'object') continue;
        // 准入只看三件套：id/owner/repo 非空必填（有/无图标一视同仁，icon 空也保留）；仅禁 dataURI。
        const s = summary as Partial<AppSummary>;
        if (typeof s.id !== 'string' || s.id.trim() === '') continue;
        if (typeof s.owner !== 'string' || s.owner.trim() === '') continue;
        if (typeof s.repo !== 'string' || s.repo.trim() === '') continue;
        if (!Array.isArray(summary.platforms)) continue;
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
      if (confirmedOther !== undefined) {
        const seen = new Set<string>();
        const cleanConfirmed: string[] = [];
        for (const raw of confirmedOther) {
          if (typeof raw !== 'string') continue;
          const k = raw.trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          cleanConfirmed.push(k);
        }
        if (cleanConfirmed.length > 0) {
          envelope.confirmedOther = cleanConfirmed;
        }
      }
      payloadJson = JSON.stringify(envelope);
      if (utf8ByteLength(payloadJson) > TREND_DB_PAYLOAD_MAX_BYTES) {
        // 超限先丢 confirmed（enrich 富卡优先），再试裸榜
        const slim: TrendCacheEnvelopeV1 = { v: 1, repos, enrich: sanitizedEnrich };
        const slimJson = JSON.stringify(slim);
        if (utf8ByteLength(slimJson) <= TREND_DB_PAYLOAD_MAX_BYTES) {
          payloadJson = slimJson;
        } else {
          // 仍超则富卡长文本截断：description(_en) 各截 500 字符，homepage 截 500
          const truncated: Record<string, AppSummary> = {};
          for (const [k, s] of Object.entries(sanitizedEnrich)) {
            const c: AppSummary = { ...s };
            if (typeof c.description === 'string' && c.description.length > 500) {
              c.description = c.description.slice(0, 500);
            }
            if (typeof c.description_en === 'string' && c.description_en.length > 500) {
              c.description_en = c.description_en.slice(0, 500);
            }
            if (typeof c.homepage === 'string' && c.homepage.length > 500) {
              c.homepage = c.homepage.slice(0, 500);
            }
            truncated[k] = c;
          }
          const truncJson = JSON.stringify({ v: 1, repos, enrich: truncated } as TrendCacheEnvelopeV1);
          if (utf8ByteLength(truncJson) <= TREND_DB_PAYLOAD_MAX_BYTES) {
            payloadJson = truncJson;
          } else {
            // 仍超则丢 pending 空平台条（具平台优先），最后才降裸榜
            const concrete: Record<string, AppSummary> = {};
            for (const [k, s] of Object.entries(truncated)) {
              if (Array.isArray(s.platforms) && s.platforms.length > 0) concrete[k] = s;
            }
            const concreteJson = JSON.stringify({ v: 1, repos, enrich: concrete } as TrendCacheEnvelopeV1);
            if (utf8ByteLength(concreteJson) <= TREND_DB_PAYLOAD_MAX_BYTES) {
              payloadJson = concreteJson;
            } else {
              const bare = JSON.stringify(repos);
              if (utf8ByteLength(bare) > TREND_DB_PAYLOAD_MAX_BYTES) return;
              payloadJson = bare;
            }
          }
        }
      }
    } else {
      payloadJson = JSON.stringify(repos);
      if (utf8ByteLength(payloadJson) > TREND_DB_PAYLOAD_MAX_BYTES) return;
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

/** 榜单 enrich 键全集。 */
function wantedEnrichKeys(repos: TrendRepo[]): Set<string> {
  const out = new Set<string>();
  for (const r of repos) {
    if (r.owner && r.repo) {
      out.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
    }
    if (r.id) out.add(r.id.trim().toLowerCase());
  }
  return out;
}

/**
 * 榜单写盘合并口（先读后写，防裸覆盖富）。
 * - 已确认 Other 同 key 合并。
 * - 合并后有富条目即存富信封（含确认集），否则存裸数组；空榜直接返回不写盘。
 * boards 主体落盘与 TrendsView 写透统一走此口，关闭前丢失/裸存覆盖即被堵住。
 */
export async function saveBoardCacheMerged(
  key: string,
  board: string,
  repos: TrendRepo[],
): Promise<void> {
  if (!isTauri || !Array.isArray(repos) || repos.length === 0) return;
  const wanted = wantedEnrichKeys(repos);
  const merged: Record<string, AppSummary> = { ...snapshotTrendEnrichCache(repos) };
  // 内存已确认快照（仍属本榜 + 新鲜 + 非具平台由 snapshot 保证）。
  let mergedConfirmed: string[] = snapshotTrendConfirmedOthers(repos).filter((k) => wanted.has(k));
  try {
    const prev = await getDbTrendCache(key, board);
    const prevEnrich = (prev as { enrich?: Record<string, AppSummary> } | undefined)?.enrich;
    if (prevEnrich) {
      for (const [k, v] of Object.entries(prevEnrich)) {
        if (!wanted.has(k)) continue;
        const cur = merged[k];
        if (!cur) {
          merged[k] = v;
          continue;
        }
        const curHas = Array.isArray(cur.platforms) && cur.platforms.length > 0;
        const prevHas = Array.isArray(v.platforms) && v.platforms.length > 0;
        if (!curHas && prevHas) merged[k] = v;
      }
    }
    // 确认集合并。
    const prevConfirmed = (prev as { confirmedOther?: unknown } | undefined)?.confirmedOther;
    if (Array.isArray(prevConfirmed)) {
      const seen = new Set(mergedConfirmed);
      for (const raw of prevConfirmed) {
        if (typeof raw !== 'string') continue;
        const k = raw.trim().toLowerCase();
        if (!k || !wanted.has(k) || seen.has(k)) continue;
        mergedConfirmed.push(k);
        seen.add(k);
      }
    }
  } catch {
    // 读旧失败即按内存快照落盘，不阻塞
  }
  // 禁 pending/确认覆盖具平台：合并后为具平台的键一律移出确认集（升级覆盖）。
  if (mergedConfirmed.length > 0) {
    mergedConfirmed = mergedConfirmed.filter((k) => {
      const hit = merged[k];
      if (hit && Array.isArray(hit.platforms) && hit.platforms.length > 0) return false;
      return true;
    });
  }
  if (Object.keys(merged).length > 0) {
    await saveDbTrendCache(
      key,
      board,
      repos,
      merged,
      mergedConfirmed.length > 0 ? mergedConfirmed : undefined,
    );
  } else {
    await saveDbTrendCache(key, board, repos);
  }
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
