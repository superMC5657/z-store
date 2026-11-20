import type { AppDetail, AppSummary, TrendRepo } from '../../types';
import { tauriApi } from '../api';
import { admitIconHit, resolveIconWithBuffer } from '../iconStore';
import { normalizeId } from '../normalizeId';

/** enrich 派生缓存 TTL：12h（坐标元数据日内几乎不变，与 DOFORCE 快照同口径）。 */
export const TREND_ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** trendEnrichCache 至多 600 条（与 iconStore 同容量；趋势、在线搜索与 Star 列表共用此池）。 */
export const TREND_ENRICH_CACHE_MAX_ENTRIES = 600;
/** 单次 enrich 最多 40 仓一次取回。 */
export const TREND_ENRICH_MAX_TOTAL = 40;

/** 已确认 Other 标记 TTL；到期后重验，具平台到达时自动覆盖。 */
const TREND_CONFIRMED_OTHER_TTL_MS = TREND_ENRICH_CACHE_TTL_MS;
/** 已确认 Other 标记内存有界：至多 600 条，FIFO 裁剪（与 enrich 同口径）。 */
const TREND_CONFIRMED_OTHER_MAX_ENTRIES = 600;

/**
 * 具平台判定（loading-never-overwrites-concrete 守卫的唯一口径）：
 * platforms 非空数组即具平台；空/缺失一律 loading（调用点均已保证数组形状）。
 */
function hasConcretePlatforms(platforms: unknown): boolean {
  return Array.isArray(platforms) && platforms.length > 0;
}

/** 读取动态对象字段。 */
function readLoose(obj: object, key: string): unknown {
  return (obj as Record<string, unknown>)[key];
}

/** 写入动态对象字段。 */
function writeLoose(obj: object, key: string, value: unknown): void {
  (obj as Record<string, unknown>)[key] = value;
}

/** 剥离运行时目录标注（`source`/`status`/`is_cataloged`），避免写入共享富卡池。 */
function stripCatalogAnnotations(summary: AppSummary): AppSummary {
  if (
    summary.source === undefined &&
    summary.status === undefined &&
    summary.is_cataloged === undefined
  ) {
    return summary;
  }
  const { source: _source, status: _status, is_cataloged: _cataloged, ...rest } = summary;
  return rest as AppSummary;
}

const trendConfirmedOtherCache = new Map<string, number>();

function putTrendConfirmedOtherEntry(key: string, timestamp: number): void {
  const k = normalizeId(key);
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

/** 标记单键为已确认 Other（已具平台则跳过，禁 loading 覆盖具平台）。 */
export function markTrendConfirmedOther(key: string): void {
  const k = normalizeId(key);
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
  const k = normalizeId(key);
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
 * 判断该键是否为新鲜（12h 内）已确认 Other。
 * 若缓存已到达具平台条目，同步清理确认标记并返回 false。
 */
export function isTrendConfirmedOtherFresh(key: string): boolean {
  const k = normalizeId(key);
  if (!k) return false;
  const cur = trendEnrichCache.get(k);
  if (cur && hasConcretePlatforms(cur.data.platforms)) {
    trendConfirmedOtherCache.delete(k);
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
 * 导出当前新鲜（12h 内）已确认 Other 键列表；可选传入 repos 时仅返回属本榜的键。
 */
export function snapshotTrendConfirmedOthers(repos?: TrendRepo[]): string[] {
  const now = Date.now();
  const fresh = new Set<string>();
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
      wanted.add(`${normalizeId(r.owner)}/${normalizeId(r.repo)}`);
    }
    if (r.id) wanted.add(normalizeId(r.id));
  }
  return out.filter((k) => wanted.has(k));
}

/**
 * 确认标记回填：
 * - 仅收非空小写键；已具平台键跳过（禁 loading 覆盖具平台）；
 * - 时间戳取 now。
 */
export function markConfirmedOthersFreshNow(keys?: readonly string[] | null): void {
  if (!keys) return;
  const now = Date.now();
  for (const raw of keys) {
    if (typeof raw !== 'string') continue;
    const k = normalizeId(raw);
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
function sweepExpiredTrendConfirmedOtherCache(): void {
  const now = Date.now();
  for (const [k, ts] of trendConfirmedOtherCache) {
    const elapsed = now - ts;
    if (elapsed < 0 || elapsed >= TREND_CONFIRMED_OTHER_TTL_MS) trendConfirmedOtherCache.delete(k);
  }
}

/** M1 内存富卡池（12h TTL / 600 条 FIFO）。 */
const trendEnrichCache = new Map<string, { timestamp: number; data: AppSummary }>();

/** 写入富卡池：非破坏字段合并、`data:` 图标剥空、具平台自动移除已确认 Other 标记。 */
function putTrendEnrichCache(key: string, entry: { timestamp: number; data: AppSummary }): void {
  const k = normalizeId(key);
  if (!k) return;
  // is_stale 透出：stale 条目永不进内存（调用方可据 TrendsResult.stale 区分真零与失败空）。
  if (readLoose(entry.data, 'is_stale') === true) return;
  const cur = trendEnrichCache.get(k);
  const merged = fillMissingFromPrev(cur?.data, { ...stripCatalogAnnotations(entry.data) });
  const resolved = stripCatalogAnnotations(resolveIconWithBuffer(cur?.data, merged));
  const data =
    typeof resolved.icon === 'string' && resolved.icon.startsWith('data:')
      ? { ...resolved, icon: '' }
      : resolved;
  const timestamp = cur ? Math.max(cur.timestamp, entry.timestamp) : entry.timestamp;
  if (trendEnrichCache.has(k)) trendEnrichCache.delete(k);
  trendEnrichCache.set(k, { timestamp, data });
  // 具平台到达即移除已确认 Other 标记。
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
  return `${normalizeId(owner)}/${normalizeId(repo)}`;
}

export function clearTrendEnrichCache(): void {
  trendEnrichCache.clear();
  trendConfirmedOtherCache.clear();
}

/** 批量回填未收录富卡至 M1 内存池（`data:` 图标先注入 iconStore 缓冲并在池内剥空）。 */
export function putTrendEnrichMemory(
  map?: Record<string, AppSummary> | Map<string, AppSummary> | null,
  opts?: { timestamp?: number },
): void {
  if (!map) return;
  const entries = map instanceof Map ? map.entries() : Object.entries(map);
  const at =
    typeof opts?.timestamp === 'number' && Number.isFinite(opts.timestamp)
      ? opts.timestamp
      : Date.now();
  for (const [rawKey, summary] of entries) {
    if (!summary || typeof summary !== 'object') continue;
    if (readLoose(summary, 'is_stale') === true) continue;
    if (summary.is_cataloged === true) continue;
    if (typeof summary.id !== 'string' || summary.id.trim() === '') continue;
    if (typeof summary.owner !== 'string' || summary.owner.trim() === '') continue;
    if (typeof summary.repo !== 'string' || summary.repo.trim() === '') continue;
    if (!Array.isArray(summary.platforms)) continue;
    const key = normalizeId(rawKey);
    if (!key) continue;
    if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) {
      admitIconHit({ id: key, icon: summary.icon, via: 'm2' });
    }
    putTrendEnrichCache(key, { timestamp: at, data: summary });
    if (summary.owner && summary.repo) {
      const coordKey = trendEnrichKey(summary.owner, summary.repo);
      if (coordKey !== key) {
        putTrendEnrichCache(coordKey, { timestamp: at, data: summary });
      }
    }
  }
}

/** 读取池内 12h 内新鲜的单仓富卡（不限平台落定状态）。 */
export function peekFreshRepoCard(key: string, now = Date.now()): AppSummary | undefined {
  const k = normalizeId(key);
  if (!k) return undefined;
  const hit = trendEnrichCache.get(k);
  if (!hit) return undefined;
  if (readLoose(hit.data, 'is_stale') === true) return undefined;
  const elapsed = now - hit.timestamp;
  if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) return undefined;
  return hit.data;
}

/** 按键驱逐池内富卡与已确认 Other 标记（登出清理私有仓库用）。 */
export function evictTrendEnrichKeys(keys: Iterable<string>): void {
  for (const raw of keys) {
    const k = normalizeId(raw);
    if (!k) continue;
    trendEnrichCache.delete(k);
    trendConfirmedOtherCache.delete(k);
  }
}

/** 导出未过期的已落定富卡快照（具平台或已确认 Other，跳过 `data:` 图标）。 */
export function snapshotTrendEnrichCache(repos?: TrendRepo[]): Record<string, AppSummary> {
  const now = Date.now();
  const out: Record<string, AppSummary> = {};
  const confirmed = new Set(snapshotTrendConfirmedOthers());
  if (repos && repos.length > 0) {
    for (const r of repos) {
      const coordKey = r.owner && r.repo ? trendEnrichKey(r.owner, r.repo) : '';
      const idKey = r.id ? normalizeId(r.id) : '';
      const coordHit = coordKey ? trendEnrichCache.get(coordKey) : undefined;
      const idHit = idKey ? trendEnrichCache.get(idKey) : undefined;
      const hit = coordHit ?? idHit;
      if (!hit) continue;
      if (readLoose(hit.data, 'is_stale') === true) continue;
      const storedKey = coordHit ? coordKey : idKey;
      const elapsed = now - hit.timestamp;
      if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) continue;
      if (!hasConcretePlatforms(hit.data.platforms)) {
        const targetKey = coordKey || idKey;
        if (!confirmed.has(storedKey) && (!targetKey || !confirmed.has(targetKey))) continue;
      }
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
    if (readLoose(hit.data, 'is_stale') === true) continue;
    if (!hasConcretePlatforms(hit.data.platforms) && !confirmed.has(key)) continue;
    if (typeof hit.data.icon === 'string' && hit.data.icon.startsWith('data:')) continue;
    out[key] = hit.data;
  }
  return out;
}

/** 导出榜单可展示的 12h 内非 stale 卡片快照（跳过 `data:` 图标）。 */
export function snapshotTrendRepoCards(repos: readonly TrendRepo[]): Record<string, AppSummary> {
  const now = Date.now();
  const out: Record<string, AppSummary> = {};
  for (const r of repos ?? []) {
    const coordKey = r.owner && r.repo ? trendEnrichKey(r.owner, r.repo) : '';
    const idKey = r.id ? normalizeId(r.id) : '';
    const targetKey = coordKey || idKey;
    if (!targetKey) continue;
    const hit = (coordKey ? trendEnrichCache.get(coordKey) : undefined) ?? (idKey ? trendEnrichCache.get(idKey) : undefined);
    if (!hit || readLoose(hit.data, 'is_stale') === true) continue;
    const elapsed = now - hit.timestamp;
    if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) continue;
    if (typeof hit.data.icon === 'string' && hit.data.icon.startsWith('data:')) continue;
    out[targetKey] = hit.data;
  }
  return out;
}

/** 只读读取 12h 内且平台已落定的新鲜富卡（具平台，或空平台且已确认 Other）。 */
export function peekFreshTrendEnrich(key: string, now = Date.now()): AppSummary | undefined {
  const k = normalizeId(key);
  if (!k) return undefined;
  const hit = trendEnrichCache.get(k);
  if (!hit) return undefined;
  if (readLoose(hit.data, 'is_stale') === true) return undefined;
  const elapsed = now - hit.timestamp;
  if (elapsed < 0 || elapsed >= TREND_ENRICH_CACHE_TTL_MS) return undefined;
  if (!hasConcretePlatforms(hit.data.platforms)) {
    const ts = trendConfirmedOtherCache.get(k);
    if (ts === undefined) return undefined;
    const e = now - ts;
    if (e < 0 || e >= TREND_CONFIRMED_OTHER_TTL_MS) return undefined;
  }
  return hit.data;
}

/** 判断 enrich 缓存条目是否仍在 12h 新鲜期；空平台条目过期即驱逐，具平台条目保留供图标合并。 */
export function takeFreshEnrichEntry(key: string, now = Date.now(), force = false): boolean {
  if (force) return false;
  const hit = trendEnrichCache.get(key);
  if (!hit) return false;
  if (!hasConcretePlatforms(hit.data.platforms)) {
    const elapsed = now - hit.timestamp;
    if (elapsed >= 0 && elapsed < TREND_ENRICH_CACHE_TTL_MS) return true;
    trendEnrichCache.delete(key);
    return false;
  }
  const elapsed = now - hit.timestamp;
  // 时钟钳制：elapsed<0 按过期
  if (elapsed < 0) {
    trendEnrichCache.delete(key);
    return false;
  }
  if (elapsed < TREND_ENRICH_CACHE_TTL_MS) return true;
  // summary/desc 12h 到期 → 重拉；旧条目保留供图标粘性合并。
  return false;
}

/** 图标粘性合并：`data:` 原样透出，其余经 `resolveIconWithBuffer` 合并。 */
export function mergeIconSticky(
  prev: AppSummary | undefined,
  next: AppSummary,
): AppSummary {
  if (typeof next.icon === 'string' && next.icon.startsWith('data:')) return next;
  return resolveIconWithBuffer(prev, next);
}

/** 批量补全未收录 `TrendRepo` 摘要（单次最多 40 条）；传输失败静默返回已命中部分。 */
async function enrichTrendReposCore(
  repos: TrendRepo[],
  force: boolean,
): Promise<Map<string, AppSummary>> {
  const out = new Map<string, AppSummary>();
  const missing: TrendRepo[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const r of repos) {
    const key = trendEnrichKey(r.owner, r.repo);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!force) {
      const hit = trendEnrichCache.get(key);
      if (hit && takeFreshEnrichEntry(key, now)) {
        out.set(key, hit.data);
        continue;
      }
    }
    // 缺席（含 force 直取、未确认 loading、stale）：本次走重拉。
    // 刷新链 force：内存命中同样重拉（落定后写透刷新时间戳）。
    missing.push(r);
  }
  if (missing.length === 0) return out;
  // 单次批量：最多 40 仓一次取回，超 40 留占位
  const capped = missing.slice(0, TREND_ENRICH_MAX_TOTAL);
  let summaries: (AppSummary | null)[];
  try {
    summaries = await tauriApi.enrichTrendRepos(
      capped.map((r) => ({ owner: r.owner, repo: r.repo })),
      force,
    );
  } catch {
    return out;
  }
  const at = Date.now();
  capped.forEach((r, i) => {
    let s = summaries[i];
    if (!s) return;
    if (!Array.isArray(s.platforms)) return;
    const key = trendEnrichKey(r.owner, r.repo);
    const cur = trendEnrichCache.get(key);
    // 确认图标（含 data: 本地缓存与远端 URL）同步注入 iconStore M1 缓冲（via=m2），
    // 确保后续 lite/settle 将持久化副本的 data: 剥空为 '' 后，resolveIconWithBuffer 仍能从 M1 回读直显。
    const rawIcon = typeof s.icon === 'string' ? s.icon.trim() : '';
    if (rawIcon !== '') {
      admitIconHit({ id: key, icon: rawIcon, via: 'm2' });
      const idKey = typeof s.id === 'string' ? normalizeId(s.id) : '';
      if (idKey && idKey !== key) {
        admitIconHit({ id: idKey, icon: rawIcon, via: 'm2' });
      }
    }
    // 图标单口：data: 原样透出供当次 out 直显；putTrendEnrichCache 内部会自动剥离 data: 为 '' 存入缓存，不丢弃富卡本身。
    s = mergeIconSticky(cur?.data, s);
    out.set(key, s);
    // 收录卡不入未收录富卡池；其余三态富卡均写入（池内 data: 剥空、空平台不覆盖具平台）。
    if (s.is_cataloged === true) return;
    putTrendEnrichCache(key, { timestamp: at, data: s });
  });
  return out;
}

export async function enrichTrendRepos(
  repos: TrendRepo[],
  opts?: { forceRefresh?: boolean },
): Promise<Map<string, AppSummary>> {
  return enrichTrendReposCore(repos, opts?.forceRefresh === true);
}

/** 详情带回真实平台时向榜单派发的治愈事件。 */
export const DETAIL_PLATFORMS_HEAL_EVENT = 'zstore:detail-platforms-healed';

export interface DetailPlatformsHealPayload {
  /** 全小写匹配键：id / owner-repo / github 前缀等（调用方据此命中本地行）。 */
  keys: string[];
  platforms: string[];
  /** 由详情构造的完整摘要（TrendsView 可直接 upsert，无需二次取数）。 */
  summary: AppSummary;
}

/** 按归一键驱逐单条 enrich 缓存（详情治愈前先清 stale []，避免旧快照覆盖）。 */
function evictTrendEnrichCacheByKey(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  trendEnrichCache.delete(k);
}

/** 详情治愈的缓存驱逐全集：id / owner-repo / github 前缀一并清除。 */
export function evictTrendEnrichCachesForDetail(id: string, owner: string, repo: string): void {
  const keys = new Set<string>();
  if (id) keys.add(normalizeId(id));
  if (owner && repo) keys.add(trendEnrichKey(owner, repo));
  for (const k of keys) evictTrendEnrichCacheByKey(k);
}

/** 详情治愈的匹配键全集（App 派发、TrendsView 命中同一口径）。 */
export function detailHealKeysFor(id: string, owner: string, repo: string): string[] {
  const out = new Set<string>();
  if (id) out.add(normalizeId(id));
  if (owner && repo) out.add(trendEnrichKey(owner, repo));
  return [...out].filter((k) => k.length > 0);
}

/** 由详情构造榜单可用的摘要（剥离占位简介，保留真实字段）。 */
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

/** 详情具平台时写入 enrich 长缓存（跳过 stale 详情，并剥离 `data:` 图标）。 */
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

const RICH_CATEGORY_PLACEHOLDERS = new Set(['', 'external', 'dev', 'system']);
const RICH_VERSION_PLACEHOLDERS = new Set(['latest', '...']);
/** 富卡简介占位文案名单（与后端 `detail_fetch.rs` 对齐，保留 `'No description'` 供展示兜底）。 */
const RICH_DESCRIPTION_PLACEHOLDERS: readonly string[] = [
  'GitHub 社区开源项目',
  '开源软件项目',
  '跨平台开源项目',
  '暂无简介',
  '暂无描述',
  'No description available',
  'No description',
];

export function isPlaceholderDescription(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '') return false;
  if (RICH_DESCRIPTION_PLACEHOLDERS.some((p) => t.includes(p))) return true;
  // 英文占位大小写不敏感兜底（与后端同形）。
  return t.toLowerCase().includes('no description available');
}

function richStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
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
    const a = richStr(readLoose(prev, f));
    const b = richStr(readLoose(next, f));
    if (b !== '' && !isPlaceholderDescription(b) && a !== b) dirty.push(f);
  }
  // stars / forks：Number 比对，减少亦脏
  for (const f of ['stars', 'forks'] as const) {
    if (Number(readLoose(prev, f)) !== Number(readLoose(next, f))) {
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
    const a = readLoose(prev, 'latest_version');
    const b = readLoose(next, 'latest_version');
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
    const a = richStr(readLoose(prev, f));
    const b = richStr(readLoose(next, f));
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

/** 详情更新后向榜单派发的富卡治愈事件。 */
export const DETAIL_RICHCARD_HEAL_EVENT = 'zstore:detail-richcard-healed';

export interface DetailRichcardHealPayload {
  /** 全小写匹配键：id / owner-repo 等（与平台治愈同口径）。 */
  keys: string[];
  /** upsert 后的完整摘要（空已回填旧值，data: 已剥离）。 */
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

/** 用已有富卡 `prev` 回填 `merged` 中的空值与占位字段（`data:` 图标剥为空串，空平台不覆盖具平台）。 */
export function fillMissingFromPrev(
  prev: AppSummary | undefined,
  merged: AppSummary,
): AppSummary {
  if (!prev) return merged;
  // icon：data: 剥成 ''；空保留旧（put 入口亦有合并，此处先行保证 diff 准确）
  const incomingIcon = richStr(merged.icon);
  const prevIcon = richStr(prev.icon);
  const prevIconUsable = prevIcon !== '' && !prevIcon.startsWith('data:');
  if (incomingIcon === '' || incomingIcon.startsWith('data:')) {
    merged.icon = prevIconUsable ? prev.icon : '';
  }
  // 空/占位不覆盖实
  if (richStr(merged.name) === '' || richStr(merged.name) === '加载中...') merged.name = prev.name;
  for (const f of ['description', 'description_en'] as const) {
    const bv = richStr(readLoose(merged, f));
    if (bv === '' || isPlaceholderDescription(bv)) {
      writeLoose(merged, f, readLoose(prev, f));
    }
  }
  if (richStr(merged.license) === '') {
    merged.license = prev.license;
  } else if (
    richStr(merged.license) === 'OpenSource' &&
    richStr(merged.forge).toLowerCase() !== 'github' &&
    richStr(prev.license) !== ''
  ) {
    merged.license = prev.license;
  }
  if (
    richStr(merged.latest_version) === '' ||
    RICH_VERSION_PLACEHOLDERS.has(merged.latest_version as string)
  ) {
    merged.latest_version = prev.latest_version;
  }
  const mc = richStr(merged.category);
  if (mc === '' || RICH_CATEGORY_PLACEHOLDERS.has(mc.toLowerCase())) {
    if (
      richStr(prev.category) !== '' &&
      !RICH_CATEGORY_PLACEHOLDERS.has(richStr(prev.category).toLowerCase())
    ) {
      merged.category = prev.category;
    } else if (mc === '') {
      merged.category = prev.category;
    }
  }
  for (const f of ['category_name', 'forge', 'forge_host', 'owner', 'repo'] as const) {
    if (richStr(readLoose(merged, f)) === '') {
      writeLoose(merged, f, readLoose(prev, f));
    }
  }
  if (
    merged.homepage === null ||
    (typeof merged.homepage === 'string' && merged.homepage.trim() === '')
  ) {
    merged.homepage = prev.homepage;
  }
  // 平台空不覆盖已具平台值
  if (!hasConcretePlatforms(merged.platforms) && hasConcretePlatforms(prev.platforms)) {
    merged.platforms = [...prev.platforms];
  }
  return merged;
}

/** 将非 stale 详情合并写入富卡池并返回更新后的摘要与变更字段列表。 */
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
  fillMissingFromPrev(prev, merged);
  const at = Date.now();
  for (const k of keys) {
    putTrendEnrichCache(k, { timestamp: at, data: merged });
  }
  const dirtyFields = prev ? diffRichSummary(prev, merged) : diffRichSummary(emptyRichBaseline(), merged);
  return { summary: merged, dirtyFields };
}

/** 格式化星数显示（>=1000 显示为 `k`）。 */
export function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/** 按 canonical id 或 `owner/repo` 匹配本地收录应用（需 owner 一致，避免同名仓库误匹配）。 */
export function matchCatalogApp(trend: TrendRepo, catalogApps: AppSummary[]): AppSummary | undefined {
  const tId = normalizeId(trend.id);
  const tOwner = normalizeId(trend.owner);
  const tRepo = normalizeId(trend.repo);

  const tFullName = tOwner && tRepo ? `${tOwner}/${tRepo}` : '';

  return catalogApps.find((app) => {
    const aId = normalizeId(app.id);
    const aOwner = normalizeId(app.owner);
    const aRepo = normalizeId(app.repo);
    const aFullName = aOwner && aRepo ? `${aOwner}/${aRepo}` : '';

    // 1. canonical id 全等
    if (tId && aId && aId === tId) return true;
    // 2. 归一 fullName 相等（tId 本身即 fullName 的情形 + owner/repo 拼出的 fullName）
    if (tId && aFullName && aFullName === tId) return true;
    if (tFullName && aFullName && aFullName === tFullName) return true;
    // 3. owner + repo 同时相等（owner 佐证）
    if (tOwner && tRepo && aOwner === tOwner && aRepo === tRepo) return true;

    return false;
  });
}
