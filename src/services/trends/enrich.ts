import type { AppDetail, AppSummary, TrendRepo } from '../../types';
import { tauriApi } from '../api';

/** enrich 派生缓存 TTL：12h（坐标元数据日内几乎不变，与 DOFORCE 快照同口径）。 */
export const TREND_ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Phase2治理内存有界：trendEnrichCache 至多 500 条，经单一 put 入口 FIFO 裁剪。 */
export const TREND_ENRICH_CACHE_MAX_ENTRIES = 500;
/** Phase2治理分片：FE 分片串行 20/片 × 2 片 = 40 上限（BE buffered(5) 不变，见 catalog_search.rs）。 */
export const TREND_ENRICH_SHARD_SIZE = 20;
/** Phase2治理分片：单次 enrich 最多 40 仓，超 40 留占位不置空榜。 */
export const TREND_ENRICH_MAX_TOTAL = 40;

const trendEnrichCache = new Map<string, { timestamp: number; data: AppSummary }>();

/**
 * Phase2治理单一 put 入口：trendEnrichCache 唯一写入口，写时 FIFO 裁剪至 500 条。
 * 调用方禁止直调 trendEnrichCache.set，一律经此入口，保证内存有界。
 * 图标回填只做升级不做准入：已有真实图标（非空）不被空图标覆盖；
 * 有/无图标一视同仁进富卡，首字母兜底在渲染侧生成，不影响持久化。
 */
function putTrendEnrichCache(key: string, entry: { timestamp: number; data: AppSummary }): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  let data = entry.data;
  const cur = trendEnrichCache.get(k);
  const curIcon = cur && typeof cur.data.icon === 'string' ? cur.data.icon : '';
  const incomingIcon = typeof entry.data.icon === 'string' ? entry.data.icon : '';
  if (cur && curIcon.trim() !== '' && incomingIcon.trim() === '') {
    data = { ...entry.data, icon: cur.data.icon };
  }
  if (trendEnrichCache.has(k)) trendEnrichCache.delete(k);
  trendEnrichCache.set(k, { timestamp: entry.timestamp, data });
  while (trendEnrichCache.size > TREND_ENRICH_CACHE_MAX_ENTRIES) {
    const oldest = trendEnrichCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    if (oldest === k) break;
    trendEnrichCache.delete(oldest);
  }
}

/**
 * Phase2治理：切榜顺手 sweep 过期（fetchTrendsResult 入口调用，不加 setInterval timer）。
 * elapsed<0（时钟回拨）按过期。
 */
export function sweepExpiredTrendEnrichCache(): void {
  const now = Date.now();
  for (const [k, v] of trendEnrichCache) {
    const elapsed = now - v.timestamp;
    if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) trendEnrichCache.delete(k);
  }
}

function trendEnrichKey(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export function clearTrendEnrichCache(): void {
  trendEnrichCache.clear();
}

/**
 * 从 DB L2 缓存向内存 `trendEnrichCache` 回填（hydrate）：
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
    if (cur && cur.data.platforms && cur.data.platforms.length > 0) {
      const incomingEmpty = !summary.platforms || summary.platforms.length === 0;
      if (incomingEmpty) continue;
    }
    putTrendEnrichCache(key, { timestamp: now, data: summary });
    if (summary.owner && summary.repo) {
      const coordKey = trendEnrichKey(summary.owner, summary.repo);
      if (coordKey !== key) {
        const curCoord = trendEnrichCache.get(coordKey);
        if (curCoord && curCoord.data.platforms && curCoord.data.platforms.length > 0) {
          const incomingEmpty = !summary.platforms || summary.platforms.length === 0;
          if (incomingEmpty) continue;
        }
        putTrendEnrichCache(coordKey, { timestamp: now, data: summary });
      }
    }
  }
}

/**
 * 将内存中的有效 `trendEnrichCache` 转为可存入 L2 DB 的快照（Record<小写owner/repo, AppSummary>）：
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
        trendEnrichCache.delete(key);
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
      const s = summaries[i];
      if (!s) return;
      if (!Array.isArray(s.platforms)) return;
      if (typeof s.icon === 'string' && s.icon.startsWith('data:')) {
        // data: URI 永不进内存/L2，但本次仍可返回占位由调用方保留旧小行。
        const key = trendEnrichKey(r.owner, r.repo);
        out.set(key, s);
        return;
      }
      const key = trendEnrichKey(r.owner, r.repo);
      // SWR：具平台与 pending 均进 12h 内存（首屏直展）；内存已有具平台值时不被 pending 覆盖。
      const cur = trendEnrichCache.get(key);
      if (cur && cur.data.platforms && cur.data.platforms.length > 0) {
        const incomingEmpty = !s.platforms || s.platforms.length === 0;
        if (incomingEmpty) {
          out.set(key, s);
          return;
        }
      }
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

/** 由详情构造榜单可用的摘要（仅平台治愈场景，调用方保证 platforms 非空且非 stale）。 */
export function appSummaryFromDetail(detail: AppDetail): AppSummary {
  return {
    id: detail.id,
    name: detail.name,
    description_en: detail.description_en,
    owner: detail.owner,
    repo: detail.repo,
    icon: detail.icon,
    icon_bg: detail.icon_bg,
    description: detail.description,
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
  if (!detail.platforms || detail.platforms.length === 0) return;
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
