import type { AppDetail, AppSummary, TrendRepo } from '../../types';
import { tauriApi } from '../api';

/** enrich 派生缓存 TTL：12h（坐标元数据日内几乎不变，与 DOFORCE 快照同口径）。 */
export const TREND_ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const trendEnrichCache = new Map<string, { timestamp: number; data: AppSummary }>();

function trendEnrichKey(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export function clearTrendEnrichCache(): void {
  trendEnrichCache.clear();
}

/**
 * 从 DB L2 缓存向内存 `trendEnrichCache` 回填（hydrate）：
 * - 复用 hasPlatforms 语义：仅 platforms.length > 0 的条目才存入内存，pending / 空 platforms 绝不进缓存；
 * - 约束：不存 dataURI（若 icon 是 data: 开头则跳过）；
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
    if (!Array.isArray(summary.platforms) || summary.platforms.length === 0) continue;
    if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) continue;
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    trendEnrichCache.set(key, { timestamp: now, data: summary });
    if (summary.owner && summary.repo) {
      const coordKey = trendEnrichKey(summary.owner, summary.repo);
      if (coordKey !== key) {
        trendEnrichCache.set(coordKey, { timestamp: now, data: summary });
      }
    }
  }
}

/**
 * 将内存中的有效 `trendEnrichCache` 转为可存入 L2 DB 的快照（Record<小写owner/repo, AppSummary>）：
 * - 可选传入 repos：若传入则仅提取属于这些 repos 的条目，否则提取全部；
 * - 仅提取未过期且具真实平台（platforms.length > 0）的条目；
 * - 约束：跳过 dataURI / pending 空平台。
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
      if (now - hit.timestamp >= TREND_ENRICH_CACHE_TTL_MS) continue;
      if (!Array.isArray(hit.data.platforms) || hit.data.platforms.length === 0) continue;
      if (typeof hit.data.icon === 'string' && hit.data.icon.startsWith('data:')) continue;
      const targetKey = coordKey || idKey;
      if (targetKey) {
        out[targetKey] = hit.data;
      }
    }
    return out;
  }
  for (const [key, hit] of trendEnrichCache.entries()) {
    if (now - hit.timestamp >= TREND_ENRICH_CACHE_TTL_MS) continue;
    if (!Array.isArray(hit.data.platforms) || hit.data.platforms.length === 0) continue;
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
 * 因此空 platforms 的 enrich 结果一律视为“待确认 pending”，绝不写入 12h 长缓存——
 * 仅具真实平台的结果才可长缓存，避免会话级 stuck Other（VoiceStudio 类 bug）。
 * 空结果仍会本次返回（调用方以 pending 卡展示），下次挂载重查，给详情治愈留出机会。
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
      if (now - hit.timestamp < TREND_ENRICH_CACHE_TTL_MS) {
        out.set(key, hit.data);
        continue;
      }
      trendEnrichCache.delete(key);
    }
    missing.push(r);
  }
  if (missing.length === 0) return out;
  let summaries: (AppSummary | null)[];
  try {
    summaries = await tauriApi.enrichTrendRepos(
      missing.map((r) => ({ owner: r.owner, repo: r.repo })),
    );
  } catch {
    return out;
  }
  const at = Date.now();
  missing.forEach((r, i) => {
    const s = summaries[i];
    if (!s) return;
    const key = trendEnrichKey(r.owner, r.repo);
    const hasPlatforms = Array.isArray(s.platforms) && s.platforms.length > 0;
    // 空 platforms = 待确认 pending：本次返回但不进 12h 长缓存，避免 stale [] 锁死榜单行。
    if (hasPlatforms) {
      trendEnrichCache.set(key, { timestamp: at, data: s });
    }
    out.set(key, s);
  });
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
 * stale 详情一律不调用（调用方把关）。
 */
export function upsertTrendEnrichFromDetail(detail: AppDetail): void {
  if (!detail.platforms || detail.platforms.length === 0) return;
  if (detail.is_stale) return;
  const summary = appSummaryFromDetail(detail);
  const at = Date.now();
  for (const k of detailHealKeysFor(detail.id, detail.owner, detail.repo)) {
    trendEnrichCache.set(k, { timestamp: at, data: summary });
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
 * 支持 id/全路径/名称等模糊与精确比对。
 */
export function matchCatalogApp(trend: TrendRepo, catalogApps: AppSummary[]): AppSummary | undefined {
  const tId = (trend.id || '').trim().toLowerCase();
  const tOwner = (trend.owner || '').trim().toLowerCase();
  const tRepo = (trend.repo || '').trim().toLowerCase();
  const tName = (trend.name || '').trim().toLowerCase();

  return catalogApps.find((app) => {
    const aId = (app.id || '').trim().toLowerCase();
    const aOwner = (app.owner || '').trim().toLowerCase();
    const aRepo = (app.repo || '').trim().toLowerCase();
    const aName = (app.name || '').trim().toLowerCase();
    const aFullName = `${aOwner}/${aRepo}`;

    // 1. 完全匹配 ID 或 owner/repo
    if (tId && (aId === tId || aFullName === tId)) return true;
    if (tOwner && tRepo && aOwner === tOwner && aRepo === tRepo) return true;
    // 2. 匹配 repo 名称
    if (tRepo && aRepo === tRepo) return true;
    // 3. 匹配 app name
    if (tName && (aName === tName || aRepo === tName || aFullName === tName)) return true;

    return false;
  });
}
