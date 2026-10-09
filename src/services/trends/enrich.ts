import type { AppDetail, AppSummary, TrendRepo } from '../../types';
import { tauriApi } from '../api';
import { getBufferedIcon, mergeStickyIcon } from '../iconStore';

/** enrich 派生缓存 TTL：12h（坐标元数据日内几乎不变，与 DOFORCE 快照同口径）。 */
export const TREND_ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** trendEnrichCache 至多 500 条。 */
export const TREND_ENRICH_CACHE_MAX_ENTRIES = 500;
/** 分片 20/片×2 片=40 上限。 */
export const TREND_ENRICH_SHARD_SIZE = 20;
/** 单次 enrich 最多 40 仓。 */
export const TREND_ENRICH_MAX_TOTAL = 40;

/**
 * 已确认 Other 标记 TTL：12h（与 enrich 同口径，到期重验）。
 * settle 兜底 / lite 空非 stale 确认的 Other 经此集合记忆，具平台到达即覆盖升级（put 具平台自动移除），
 * pending 空平台永不覆盖已具平台值（mark 前检查 enrich 已具平台则跳过）。
 */
export const TREND_CONFIRMED_OTHER_TTL_MS = TREND_ENRICH_CACHE_TTL_MS;
/** 已确认 Other 标记内存有界：至多 500 条，FIFO 裁剪（与 enrich 同口径）。 */
export const TREND_CONFIRMED_OTHER_MAX_ENTRIES = 500;

/**
 * 具平台判定（pending-never-overwrites-concrete 守卫的唯一口径）：
 * platforms 非空数组即具平台；空/缺失一律 pending（调用点均已保证数组形状）。
 */
function hasConcretePlatforms(platforms: unknown): boolean {
  return Array.isArray(platforms) && platforms.length > 0;
}

const trendConfirmedOtherCache = new Map<string, number>();

function putTrendConfirmedOtherEntry(key: string, timestamp: number): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  if (trendConfirmedOtherCache.has(k)) trendConfirmedOtherCache.delete(k);
  trendConfirmedOtherCache.set(k, timestamp);
  while (trendConfirmedOtherCache.size > TREND_CONFIRMED_OTHER_MAX_ENTRIES) {
    const oldest = trendConfirmedOtherCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === k) break;
    trendConfirmedOtherCache.delete(oldest);
  }
}

/** 标记单键为已确认 Other（已具平台则跳过，禁 pending 覆盖具平台）。 */
export function markTrendConfirmedOther(key: string): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  const cur = trendEnrichCache.get(k);
  if (cur && hasConcretePlatforms(cur.data.platforms)) return;
  putTrendConfirmedOtherEntry(k, Date.now());
}

/** 批量标记已确认 Other（空键/已具平台逐项跳过）。 */
export function markTrendConfirmedOthers(keys: readonly string[]): void {
  if (!keys) return;
  for (const raw of keys) {
    if (typeof raw !== 'string') continue;
    markTrendConfirmedOther(raw);
  }
}

/** 移除单键已确认标记（具平台升级覆盖时调用；put 具平台已自动移除，此处供显式别名清理）。 */
export function unmarkTrendConfirmedOther(key: string): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  trendConfirmedOtherCache.delete(k);
}

/** 批量移除已确认标记。 */
export function unmarkTrendConfirmedOthers(keys: readonly string[]): void {
  if (!keys) return;
  for (const raw of keys) {
    if (typeof raw !== 'string') continue;
    unmarkTrendConfirmedOther(raw);
  }
}

/**
 * 单键是否为已确认 Other（运行时派生优先，derive wins）：
 * - 派生口径：内存 enrich 条目存在时，以条目状态为准——具平台一律不是 Other
 *   （到场即驱逐，残留标记同步清除）；空平台 + 新鲜（12h 内，非 stale）即 Other；
 *   空平台 + stale 即非 Other（到期重验，不再由旧标记直展）；
 * - 无内存条目时回退独立标记集。
 */
export function isTrendConfirmedOtherFresh(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  const cur = trendEnrichCache.get(k);
  if (cur) {
    if (hasConcretePlatforms(cur.data.platforms)) {
      if (trendConfirmedOtherCache.has(k)) trendConfirmedOtherCache.delete(k);
      return false;
    }
    const elapsed = Date.now() - cur.timestamp;
    if (elapsed >= 0 && elapsed < TREND_ENRICH_CACHE_TTL_MS) return true;
    return false;
  }
  const ts = trendConfirmedOtherCache.get(k);
  if (ts === undefined) return false;
  const elapsed = Date.now() - ts;
  if (elapsed < 0 || elapsed >= TREND_CONFIRMED_OTHER_TTL_MS) {
    trendConfirmedOtherCache.delete(k);
    return false;
  }
  return true;
}

/**
 * 已确认 Other 快照：
 * - 派生优先：新鲜（12h 内）空平台 enrich 条目一律视为 Other（运行时派生，
 *   不再依赖是否曾被单独标记）；具平台键一律排除（禁 pending 覆盖具平台，
 *   升级后不再视同 Other）；stale 空平台条目排除（到期重验）；
 * - 独立标记集新鲜键一并返回；
 * - 可选传入 repos 时仅返回仍属本榜的键（坐标键 + id 键，小写）。
 */
export function snapshotTrendConfirmedOthers(repos?: TrendRepo[]): string[] {
  const now = Date.now();
  const fresh = new Set<string>();
  for (const [k, hit] of trendEnrichCache) {
    const elapsed = now - hit.timestamp;
    if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) continue;
    if (hasConcretePlatforms(hit.data.platforms)) continue;
    fresh.add(k);
  }
  for (const [k, ts] of trendConfirmedOtherCache) {
    const elapsed = now - ts;
    if (elapsed < 0 || elapsed >= TREND_CONFIRMED_OTHER_TTL_MS) {
      trendConfirmedOtherCache.delete(k);
      continue;
    }
    const cur = trendEnrichCache.get(k);
    if (cur && hasConcretePlatforms(cur.data.platforms)) {
      trendConfirmedOtherCache.delete(k);
      continue;
    }
    fresh.add(k);
  }
  const out = [...fresh];
  if (!repos || repos.length === 0) return out;
  const wanted = new Set<string>();
  for (const r of repos) {
    if (r.owner && r.repo) {
      wanted.add(`${r.owner.trim().toLowerCase()}/${r.repo.trim().toLowerCase()}`);
    }
    if (r.id) wanted.add(r.id.trim().toLowerCase());
  }
  return out.filter((k) => wanted.has(k));
}

/**
 * 确认标记回填：
 * - 仅收非空小写键；已具平台键跳过（禁 pending 覆盖具平台）；
 * - 时间戳取 now。
 */
export function hydrateTrendConfirmedOtherCache(keys?: readonly string[] | null): void {
  if (!keys) return;
  const now = Date.now();
  for (const raw of keys) {
    if (typeof raw !== 'string') continue;
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const cur = trendEnrichCache.get(k);
    if (cur && hasConcretePlatforms(cur.data.platforms)) continue;
    putTrendConfirmedOtherEntry(k, now);
  }
}

/** 仅供测试/榜单切换：清空已确认 Other 标记。 */
export function clearTrendConfirmedOtherCache(): void {
  trendConfirmedOtherCache.clear();
}

/** 切榜顺手 sweep 已确认过期（与 enrich 同入口调用，不加 timer）。 */
export function sweepExpiredTrendConfirmedOtherCache(): void {
  const now = Date.now();
  for (const [k, ts] of trendConfirmedOtherCache) {
    const elapsed = now - ts;
    if (elapsed < 0 || elapsed >= TREND_CONFIRMED_OTHER_TTL_MS) trendConfirmedOtherCache.delete(k);
  }
}

const trendEnrichCache = new Map<string, { timestamp: number; data: AppSummary }>();

/**
 * icon 粘性 supersede-only 合并（per-field 新鲜度的 icon 半区）：
 * 旧图标非空 + 回填图标空 → 沿用旧图标；其余一律采用回填值（含新图标覆盖旧图标）。
 * put 入口与回填 out 组装共用，保证内存与本次返回值一致。
 *
 * 图标合并走 iconStore 缓冲。
 *
 * @deprecated P1 已收敛至 `services/iconStore.mergeStickyIcon`，此处仅转调；
 *   SHARD/平台逻辑与趋势等齐语义一律不动。
 */
function stickyIconFor(cur: AppSummary | undefined, incoming: AppSummary): AppSummary {
  const merged = mergeStickyIcon(cur, incoming);
  // 竞态补齐。
  // 合并与入库一并沿用缓冲实图（内存与本次返回值一致）。
  if (typeof merged.icon === 'string' && merged.icon.trim() === '') {
    const coordKey =
      incoming.owner && incoming.repo
        ? `${incoming.owner.trim().toLowerCase()}/${incoming.repo.trim().toLowerCase()}`
        : '';
    const idKey = typeof incoming.id === 'string' ? incoming.id.trim().toLowerCase() : '';
    const buffered =
      (coordKey ? getBufferedIcon(coordKey) : undefined) ??
      (idKey ? getBufferedIcon(idKey) : undefined);
    if (buffered && buffered.trim() !== '') {
      return { ...merged, icon: buffered };
    }
  }
  return merged;
}

/**
 * trendEnrichCache 唯一写入口。
 */
function putTrendEnrichCache(key: string, entry: { timestamp: number; data: AppSummary }): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  const cur = trendEnrichCache.get(k);
  // 图标回填只做升级不做准入（stickyIconFor）：已有真实图标（非空）不被空图标覆盖；
  // 有/无图标一视同仁进富卡，首字母兜底在渲染侧生成，不影响持久化。
  const data = stickyIconFor(cur?.data, entry.data);
  if (trendEnrichCache.has(k)) trendEnrichCache.delete(k);
  trendEnrichCache.set(k, { timestamp: entry.timestamp, data });
  // 具平台到达即覆盖升级： concrete 入库同步移除已确认 Other 标记（pending 永不覆盖具平台的另一半）。
  if (hasConcretePlatforms(data.platforms)) {
    trendConfirmedOtherCache.delete(k);
  }
  while (trendEnrichCache.size > TREND_ENRICH_CACHE_MAX_ENTRIES) {
    const oldest = trendEnrichCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === k) break;
    trendEnrichCache.delete(oldest);
  }
}

/**
 * 切榜 sweep 过期。
 */
export function sweepExpiredTrendEnrichCache(): void {
  const now = Date.now();
  for (const [k, v] of trendEnrichCache) {
    const elapsed = now - v.timestamp;
    if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) trendEnrichCache.delete(k);
  }
  sweepExpiredTrendConfirmedOtherCache();
}

function trendEnrichKey(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export function clearTrendEnrichCache(): void {
  trendEnrichCache.clear();
  trendConfirmedOtherCache.clear();
}

/**
 * 向内存 `trendEnrichCache` 回填：
 * - SWR 直展：具真实平台与 pending 空平台均可入内存（pending 卡首屏直展，Other 待确认语义）；
 * - 准入只看三件套：id/owner/repo 非空必填（有/无图标一视同仁，icon 空也保留）；
 * - 约束：不存 dataURI（若 icon 是 data: 开头则跳过）；
 * - 不用旧 pending 覆盖内存中已具平台值（详情治愈/新值优先；图标合并在 put 入口统一升级）。
 * - 键统一转为小写 `owner/repo`。
 */
export function hydrateTrendEnrichCache(
  map?: Record<string, AppSummary> | Map<string, AppSummary> | null,
): void {
  if (!map) return;
  const entries = map instanceof Map ? map.entries() : Object.entries(map);
  const now = Date.now();
  for (const [rawKey, summary] of entries) {
    if (!summary || typeof summary !== 'object') continue;
    if (typeof summary.id !== 'string' || summary.id.trim() === '') continue;
    if (typeof summary.owner !== 'string' || summary.owner.trim() === '') continue;
    if (typeof summary.repo !== 'string' || summary.repo.trim() === '') continue;
    if (!Array.isArray(summary.platforms)) continue;
    if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) continue;
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const cur = trendEnrichCache.get(key);
    if (cur && hasConcretePlatforms(cur.data.platforms)) {
      const incomingEmpty = !hasConcretePlatforms(summary.platforms);
      if (incomingEmpty) continue;
    }
    putTrendEnrichCache(key, { timestamp: now, data: summary });
    if (summary.owner && summary.repo) {
      const coordKey = trendEnrichKey(summary.owner, summary.repo);
      if (coordKey !== key) {
        const curCoord = trendEnrichCache.get(coordKey);
        if (curCoord && hasConcretePlatforms(curCoord.data.platforms)) {
          const incomingEmpty = !hasConcretePlatforms(summary.platforms);
          if (incomingEmpty) continue;
        }
        putTrendEnrichCache(coordKey, { timestamp: now, data: summary });
      }
    }
  }
}

/**
 * 内存快照：
 * - 可选传入 repos：若传入则仅提取属于这些 repos 的条目，否则提取全部；
 * - 仅提取未过期条目（elapsed<0 按过期；elapsed>=12h 按过期），具真实平台与 pending 空平台均收录（SWR 直展）；
 * - 约束：跳过 dataURI（pending 空平台保留，Other 待确认语义）。
 */
export function snapshotTrendEnrichCache(repos?: TrendRepo[]): Record<string, AppSummary> {
  const now = Date.now();
  const out: Record<string, AppSummary> = {};
  if (repos && repos.length > 0) {
    for (const r of repos) {
      const coordKey = r.owner && r.repo ? trendEnrichKey(r.owner, r.repo) : '';
      const idKey = r.id ? r.id.trim().toLowerCase() : '';
      const hit =
        (coordKey ? trendEnrichCache.get(coordKey) : undefined) ??
        (idKey ? trendEnrichCache.get(idKey) : undefined);
      if (!hit) continue;
      const elapsed = now - hit.timestamp;
      if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) continue;
      if (!Array.isArray(hit.data.platforms)) continue;
      if (typeof hit.data.icon === 'string' && hit.data.icon.startsWith('data:')) continue;
      const targetKey = coordKey || idKey;
      if (targetKey) {
        out[targetKey] = hit.data;
      }
    }
    return out;
  }
  for (const [key, hit] of trendEnrichCache.entries()) {
    const elapsed = now - hit.timestamp;
    if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) continue;
    if (!Array.isArray(hit.data.platforms)) continue;
    if (typeof hit.data.icon === 'string' && hit.data.icon.startsWith('data:')) continue;
    out[key] = hit.data;
  }
  return out;
}

/**
 * Enrich 未收录 TrendRepo → AppSummary（Map 键为小写 `owner/repo`）。
 * 缓存命中直接返回；缺失批量走 Rust 命令；失败/空项缺席（调用方保留旧小行，榜单永不因此变空）。
 * 本函数永不抛错：传输层异常一律吞为“全部缺席”。
 *
 * 平台语义：`fallback_summary` 恒为 `[]`（后端不打标，other 纯前端虚拟），
 * 空 platforms 为“待确认 pending”：本次返回并进 12h 内存（SWR 首屏直展 pending 卡），
 * 后续具平台值到达即覆盖治愈；调用方与 hydrate 永不用空值覆盖已具平台值，
 * 避免 stale [] 锁死榜单行（VoiceStudio 类 bug）。
 *
 * Phase2治理分片：FE 分片串行 20/片 × 2 片 = 40 上限（BE take(40)+buffered(5) 保序不变）；
 * 超 40 的仓留占位（out 缺席，调用方保留旧小行），榜单永不置空；单片失败仅该片缺席，继续下片。
 *
 * per-field 新鲜度（本函数读路径）：
 * - icon 粘性 supersede-only：永不过期，只被非空新图标替换（stickyIconFor，put 与 out 同语义）；
 * - summary/desc 12h：到期重拉，但旧条目保留供图标合并（快照/sweep 仍视其过期）；
 * - platforms 沿详情等价新鲜度：pending 空平台永不覆盖具平台值，具平台到达即覆盖治愈，
 *   空非 stale 由 lite/详情确认链裁决（本函数不另设平台 TTL）。
 */
export async function enrichTrendRepos(repos: TrendRepo[]): Promise<Map<string, AppSummary>> {
  const out = new Map<string, AppSummary>();
  const missing: TrendRepo[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const r of repos) {
    const key = trendEnrichKey(r.owner, r.repo);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = trendEnrichCache.get(key);
    if (hit) {
      const elapsed = now - hit.timestamp;
      // 时钟钳制：elapsed<0 按过期
      if (elapsed < 0) {
        trendEnrichCache.delete(key);
      } else if (elapsed < TREND_ENRICH_CACHE_TTL_MS) {
        out.set(key, hit.data);
        continue;
      } else {
        // summary/desc 12h 到期 → 重拉；旧条目保留供图标粘性合并，
        // 重拉成功即刷新时间戳，失败则下次再验（不删旧图标）。
      }
    }
    missing.push(r);
  }
  if (missing.length === 0) return out;
  // 分片串行：20/片 × 最多 2 片 = 40 上限，超 40 留占位
  const capped = missing.slice(0, TREND_ENRICH_MAX_TOTAL);
  for (let start = 0; start < capped.length; start += TREND_ENRICH_SHARD_SIZE) {
    const shard = capped.slice(start, start + TREND_ENRICH_SHARD_SIZE);
    let summaries: (AppSummary | null)[];
    try {
      summaries = await tauriApi.enrichTrendRepos(
        shard.map((r) => ({ owner: r.owner, repo: r.repo })),
      );
    } catch {
      continue;
    }
    const at = Date.now();
    shard.forEach((r, i) => {
      let s = summaries[i];
      if (!s) return;
      if (!Array.isArray(s.platforms)) return;
      if (typeof s.icon === 'string' && s.icon.startsWith('data:')) {
        // data: 永不进内存。
        const key = trendEnrichKey(r.owner, r.repo);
        out.set(key, s);
        return;
      }
      const key = trendEnrichKey(r.owner, r.repo);
      // SWR：具平台与 pending 均进 12h 内存（首屏直展）；内存已有具平台值时不被 pending 覆盖。
      const cur = trendEnrichCache.get(key);
      if (cur && hasConcretePlatforms(cur.data.platforms)) {
        const incomingEmpty = !hasConcretePlatforms(s.platforms);
        if (incomingEmpty) {
          out.set(key, s);
          return;
        }
      }
      // icon 粘性 supersede-only：旧图标非空 + 回填空 → out 与入库一并沿用旧图标。
      s = stickyIconFor(cur?.data, s);
      putTrendEnrichCache(key, { timestamp: at, data: s });
      out.set(key, s);
    });
  }
  return out;
}

/**
 * 详情治愈榜单行的跨组件通道（App → TrendsView）。
 * 详情成功带回真实平台时，App 派发此事件，TrendsView 即时补齐其 `enrichedApps`，
 * 行内从 pending 占位一次落定为 OS 图标（VoiceStudio 类 bug 的治愈路径）。
 */
export const DETAIL_PLATFORMS_HEAL_EVENT = 'zstore:detail-platforms-healed';

export interface DetailPlatformsHealPayload {
  /** 全小写匹配键：id / owner-repo / github 前缀等（调用方据此命中本地行）。 */
  keys: string[];
  platforms: string[];
  /** 由详情构造的完整摘要（TrendsView 可直接 upsert，无需二次取数）。 */
  summary: AppSummary;
}

/** 归一 enrich 键（小写 `owner/repo`），供详情治愈与缓存驱逐复用。 */
export function buildTrendEnrichKey(owner: string, repo: string): string {
  return trendEnrichKey(owner, repo);
}

/** 按归一键驱逐单条 enrich 缓存（详情治愈前先清 stale []，避免旧快照覆盖）。 */
export function evictTrendEnrichCacheByKey(key: string): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  trendEnrichCache.delete(k);
}

/** 按坐标驱逐 enrich 缓存。 */
export function evictTrendEnrichCache(owner: string, repo: string): void {
  evictTrendEnrichCacheByKey(trendEnrichKey(owner, repo));
}

/** 详情治愈的缓存驱逐全集：id / owner-repo / github 前缀一并清除。 */
export function evictTrendEnrichCachesForDetail(id: string, owner: string, repo: string): void {
  const keys = new Set<string>();
  if (id) keys.add(id.trim().toLowerCase());
  if (owner && repo) keys.add(trendEnrichKey(owner, repo));
  for (const k of keys) evictTrendEnrichCacheByKey(k);
}

/** 详情治愈的匹配键全集（App 派发、TrendsView 命中同一口径）。 */
export function detailHealKeysFor(id: string, owner: string, repo: string): string[] {
  const out = new Set<string>();
  if (id) out.add(id.trim().toLowerCase());
  if (owner && repo) out.add(trendEnrichKey(owner, repo));
  return [...out].filter((k) => k.length > 0);
}

/** 由详情构造榜单可用的摘要（仅平台治愈场景，调用方保证 platforms 非空且非 stale）。
 * Rust 合成占位简介（未收录 external_synth 等）只剥占位→''，不动其它字段。 */
export function appSummaryFromDetail(detail: AppDetail): AppSummary {
  const description = isPlaceholderDescription(detail.description) ? '' : detail.description;
  const descriptionEn =
    typeof detail.description_en === 'string' && isPlaceholderDescription(detail.description_en)
      ? ''
      : detail.description_en;
  return {
    id: detail.id,
    name: detail.name,
    description_en: descriptionEn,
    owner: detail.owner,
    repo: detail.repo,
    icon: detail.icon,
    icon_bg: detail.icon_bg,
    description,
    stars: detail.stars,
    forks: detail.forks,
    license: detail.license,
    latest_version: detail.latest_version,
    category: detail.category,
    category_name: detail.category_name,
    is_verified: detail.is_verified,
    forge: detail.forge,
    forge_host: detail.forge_host,
    homepage: detail.homepage,
    platforms: [...(detail.platforms ?? [])],
  };
}

/**
 * 详情治愈写入 enrich 长缓存：仅非空平台写入（空不写，保持 pending），
 * 后续同坐标 enrich 直接命中治愈值，不再回退 `[]`。
 * 图标回填只做升级不做准入：详情弹窗特供的 data: 内联大图不进内存
 * （快照恒禁 data:，存了也落不了盘）；空图标不覆盖已有真实图标（put 入口合并）。
 * stale 详情一律不调用（调用方把关）。
 */
export function upsertTrendEnrichFromDetail(detail: AppDetail): void {
  if (!hasConcretePlatforms(detail.platforms)) return;
  if (detail.is_stale) return;
  const summary = appSummaryFromDetail(detail);
  if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) {
    summary.icon = '';
  }
  const at = Date.now();
  for (const k of detailHealKeysFor(detail.id, detail.owner, detail.repo)) {
    putTrendEnrichCache(k, { timestamp: at, data: summary });
  }
}

/**
 * 富卡全字段更新检测：比较 prev（内存旧值）与 next（详情派生摘要），返回脏字段名。
 * - string 系 trim 比对，空 next 不覆盖实（不脏）；
 * - homepage '' 归一 null 后比对，next 为空不脏；
 * - latest_version 原样比对（不 trim），'latest'/'...' 占位不脏；
 * - stars/forks Number 比对（减少亦脏）；
 * - is_verified 布尔全量比对；
 * - platforms 排除在 dirty 外（平台通道另行治愈）；
 * - description/description_en 取 detail 非空优先（空不脏）；
 * - license 新值恰为 "OpenSource" 且 forge 非 github 时不脏（占位）；
 * - category 占位名单 external/dev/system/'' 不覆盖实（不脏）；
 * - name 过滤 '加载中...' 占位（不脏）；
 * - icon/icon_bg 剔除出 dirty（归 icon 通道）。
 */
const RICH_CATEGORY_PLACEHOLDERS = new Set(['', 'external', 'dev', 'system']);
const RICH_VERSION_PLACEHOLDERS = new Set(['latest', '...']);
/**
 * 富卡简介占位名单：Rust 合成回退（未收录 external_synth / 在线搜索空描述）
 * 与前端展示兜底的默认文案，diff/merge/patch 一律视为空（不脏、不覆盖、不进盘）；
 * 展示兜底只留在渲染侧（TrendsView displayApp 的 no_desc 逻辑）。
 */
const RICH_DESCRIPTION_PLACEHOLDERS = new Set([
  'GitHub 社区开源项目',
  '开源软件项目',
  '跨平台开源项目',
  '暂无简介',
  'No description',
]);

export function isPlaceholderDescription(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return RICH_DESCRIPTION_PLACEHOLDERS.has(v.trim());
}

function richStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isAvatarLike(url: unknown): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false;
  const u = url.trim().toLowerCase();
  return (
    u.includes('avatars.githubusercontent.com') ||
    u.includes('identicons.github.com') ||
    (u.startsWith('https://github.com/') && u.endsWith('.png') && !u.includes('/raw/'))
  );
}

export function diffRichSummary(prev: AppSummary, next: AppSummary): string[] {
  const dirty: string[] = [];
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return dirty;
  // name：过滤 '加载中...' 占位，空不覆盖实
  {
    const a = richStr(prev.name);
    const b = richStr(next.name);
    if (b !== '' && b !== '加载中...' && a !== b) dirty.push('name');
  }
  // description / description_en：detail 非空优先，占位文案视为空（不脏）
  for (const f of ['description', 'description_en'] as const) {
    const a = richStr((prev as unknown as Record<string, unknown>)[f]);
    const b = richStr((next as unknown as Record<string, unknown>)[f]);
    if (b !== '' && !isPlaceholderDescription(b) && a !== b) dirty.push(f);
  }
  // stars / forks：Number 比对，减少亦脏
  for (const f of ['stars', 'forks'] as const) {
    if (Number((prev as unknown as Record<string, unknown>)[f]) !== Number((next as unknown as Record<string, unknown>)[f])) {
      dirty.push(f);
    }
  }
  // license：新值恰为 "OpenSource" 且 forge 非 github 则不脏
  {
    const a = richStr(prev.license);
    const b = richStr(next.license);
    if (b !== '' && a !== b) {
      const forge = richStr(next.forge).toLowerCase();
      if (!(b === 'OpenSource' && forge !== 'github')) dirty.push('license');
    }
  }
  // latest_version：原样比对，'latest'/'...' 占位不脏
  {
    const a = prev.latest_version as unknown;
    const b = next.latest_version as unknown;
    if (a !== b && !RICH_VERSION_PLACEHOLDERS.has(b as string)) dirty.push('latest_version');
  }
  // category：占位名单不覆盖实
  {
    const a = richStr(prev.category);
    const b = richStr(next.category);
    if (b !== '' && !RICH_CATEGORY_PLACEHOLDERS.has(b.toLowerCase()) && a !== b) {
      dirty.push('category');
    }
  }
  // 其余 string 系 trim 比对，空不覆盖实
  for (const f of ['category_name', 'forge', 'forge_host', 'owner', 'repo'] as const) {
    const a = richStr((prev as unknown as Record<string, unknown>)[f]);
    const b = richStr((next as unknown as Record<string, unknown>)[f]);
    if (b !== '' && a !== b) dirty.push(f);
  }
  // is_verified：布尔全量
  if (Boolean(prev.is_verified) !== Boolean(next.is_verified)) dirty.push('is_verified');
  // homepage：'' 归一 null，next 为空不脏
  {
    const norm = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t === '' ? null : t;
    };
    const a = norm(prev.homepage);
    const b = norm(next.homepage);
    if (b !== null && a !== b) dirty.push('homepage');
  }
  return dirty;
}

/**
 * 富卡治愈跨组件通道（App → TrendsView，与平台治愈并行）。
 * 详情成功返回（非 stale）时，App 经 diff→upsert 落 enrich 后派发此事件，
 * TrendsView 字段级 merge 写透。
 */
export const DETAIL_RICHCARD_HEAL_EVENT = 'zstore:detail-richcard-healed';

export interface DetailRichcardHealPayload {
  /** 全小写匹配键：id / owner-repo 等（与平台治愈同口径）。 */
  keys: string[];
  /** upsert 后的完整摘要（空已回填旧值，data:/avatar 已剥离）。 */
  summary: AppSummary;
  /** 脏字段名（见 diffRichSummary，icon/platforms 永不在内）。 */
  dirtyFields: string[];
  /** 仅详情具真实平台时携带（TrendsView 据此补平台，不觸平台确认逻辑）。 */
  platforms?: string[];
  /** 详情非 stale 且平台为空时为 true（已确认 other，落定用）。 */
  confirmedOther?: boolean;
}

function emptyRichBaseline(): AppSummary {
  return {
    id: '',
    name: '',
    owner: '',
    repo: '',
    icon: '',
    icon_bg: '',
    description: '',
    stars: 0,
    forks: 0,
    license: '',
    latest_version: '',
    category: '',
    category_name: '',
    is_verified: false,
    forge: '',
    forge_host: '',
    homepage: null,
    platforms: [],
  };
}

/**
 * 富卡治愈写入 enrich 长缓存（平台治愈的姊妹入口，处理全字段）：
 * - stale 详情整单丢弃，返回 null；
 * - icon data: 剥成 ''，avatar 剥离保留旧（无旧则 ''），空图标保留旧；
 * - 其余 string 空/占位不覆盖实（name '加载中...'、category 占位、license OpenSource 非 github、
 *   latest_version 占位、homepage 空均保留旧）；
 * - 平台空不覆盖已具平台值（pending 永不覆盖具平台）；
 * - put 后返回 { summary, dirtyFields }（无旧值时以空基线求 dirty；put 本体守卫不动）。
 */
export function upsertTrendEnrichRichcard(
  detail: AppDetail,
  prevLookup?: (key: string) => AppSummary | undefined,
): { summary: AppSummary; dirtyFields: string[] } | null {
  if (!detail || typeof detail !== 'object') return null;
  if (detail.is_stale) return null;
  if (typeof detail.id !== 'string' || detail.id.trim() === '') return null;
  const keys = detailHealKeysFor(detail.id, detail.owner, detail.repo);
  if (keys.length === 0) return null;
  // 内存旧值：优先内部 enrich 实态，调用方列表快照兜底
  let prev: AppSummary | undefined;
  for (const k of keys) {
    const hit = trendEnrichCache.get(k)?.data;
    if (hit) {
      prev = hit;
      break;
    }
  }
  if (!prev && typeof prevLookup === 'function') {
    for (const k of keys) {
      try {
        const hit = prevLookup(k);
        if (hit) {
          prev = hit;
          break;
        }
      } catch {
        // 查找失败继续下键
      }
    }
  }
  const merged = appSummaryFromDetail(detail);
  // icon：data: 剥成 ''；avatar 剥离保留旧；空保留旧（put 入口亦有合并，此处先行保证 diff 准确）
  const incomingIcon = richStr(merged.icon);
  const prevIcon = prev ? richStr(prev.icon) : '';
  const prevIconUsable = prevIcon !== '' && !prevIcon.startsWith('data:') && !isAvatarLike(prevIcon);
  if (incomingIcon === '' || incomingIcon.startsWith('data:') || isAvatarLike(incomingIcon)) {
    merged.icon = prevIconUsable && prev ? prev.icon : '';
  }
  if (prev) {
    // 空/占位不覆盖实
    if (richStr(merged.name) === '' || richStr(merged.name) === '加载中...') merged.name = prev.name;
    for (const f of ['description', 'description_en'] as const) {
      const bv = richStr((merged as unknown as Record<string, unknown>)[f]);
      if (bv === '' || isPlaceholderDescription(bv)) {
        (merged as unknown as Record<string, unknown>)[f] = (prev as unknown as Record<string, unknown>)[f];
      }
    }
    if (richStr(merged.license) === '') {
      merged.license = prev.license;
    } else if (richStr(merged.license) === 'OpenSource' && richStr(merged.forge).toLowerCase() !== 'github' && richStr(prev.license) !== '') {
      merged.license = prev.license;
    }
    if (richStr(merged.latest_version) === '' || RICH_VERSION_PLACEHOLDERS.has(merged.latest_version as string)) {
      merged.latest_version = prev.latest_version;
    }
    const mc = richStr(merged.category);
    if (mc === '' || RICH_CATEGORY_PLACEHOLDERS.has(mc.toLowerCase())) {
      if (richStr(prev.category) !== '' && !RICH_CATEGORY_PLACEHOLDERS.has(richStr(prev.category).toLowerCase())) {
        merged.category = prev.category;
      } else if (mc === '') {
        merged.category = prev.category;
      }
    }
    for (const f of ['category_name', 'forge', 'forge_host', 'owner', 'repo'] as const) {
      if (richStr((merged as unknown as Record<string, unknown>)[f]) === '') {
        (merged as unknown as Record<string, unknown>)[f] = (prev as unknown as Record<string, unknown>)[f];
      }
    }
    if (merged.homepage === null || (typeof merged.homepage === 'string' && merged.homepage.trim() === '')) {
      merged.homepage = prev.homepage;
    }
    // 平台空不覆盖已具平台值
    if (!hasConcretePlatforms(merged.platforms) && hasConcretePlatforms(prev.platforms)) {
      merged.platforms = [...prev.platforms];
    }
  }
  const at = Date.now();
  for (const k of keys) {
    putTrendEnrichCache(k, { timestamp: at, data: merged });
  }
  const dirtyFields = prev ? diffRichSummary(prev, merged) : diffRichSummary(emptyRichBaseline(), merged);
  return { summary: merged, dirtyFields };
}

/**
 * 格式化星数显示（与 AppCard 规范对齐）。
 * SSOT：全仓唯一 `formatStars` 实现，其余文件禁止本地复刻，一律从此处导入。
 */
export function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * 跨源匹配 catalog.json 本地应用。
 * P1正确性（C1 owner佐证）：仅当 owner 佐证时才命中，跨 owner 永不命中——
 * - aId === tId（canonical id 全等），或
 * - 归一 fullName 相等（`owner/repo` 小写全等，含 tId 本身即 fullName 的情形），或
 * - owner 与 repo 同时相等；
 * repo 单字段 / name 模糊分支已删除（同名不同 owner 如 `acme/atlas` vs `evil/atlas`
 * 绝不互命中，避免错绑卡片与平台误判）。
 */
export function matchCatalogApp(trend: TrendRepo, catalogApps: AppSummary[]): AppSummary | undefined {
  const tId = (trend.id || '').trim().toLowerCase();
  const tOwner = (trend.owner || '').trim().toLowerCase();
  const tRepo = (trend.repo || '').trim().toLowerCase();

  const tFullName = tOwner && tRepo ? `${tOwner}/${tRepo}` : '';

  return catalogApps.find((app) => {
    const aId = (app.id || '').trim().toLowerCase();
    const aOwner = (app.owner || '').trim().toLowerCase();
    const aRepo = (app.repo || '').trim().toLowerCase();
    const aFullName = aOwner && aRepo ? `${aOwner}/${aRepo}` : '';

    // 1. canonical id 全等
    if (tId && aId && aId === tId) return true;
    // 2. 归一 fullName 相等（tId 本身即 fullName 的情形 + owner/repo 拼出的 fullName）
    if (tId && aFullName && aFullName === tId) return true;
    if (tFullName && aFullName && aFullName === tFullName) return true;
    // 3. owner + repo 同时相等（与 2 同构，显式保留作 owner 佐证主口径）
    if (tOwner && tRepo && aOwner === tOwner && aRepo === tRepo) return true;

    return false;
  });
}
