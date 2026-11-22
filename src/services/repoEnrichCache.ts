/**
 * 单仓富卡共享缓存（`Repo Enrich Cache`）：SQLite `repo_card_cache` 的前端 M1 镜像，
 * 搜索、趋势、Star 列表与应用详情共用同一池。
 *
 * - 卡片表 12h TTL / 600 条 FIFO；已确认 Other 表同口径；
 * - 写入按字段非破坏合并，空平台不覆盖具平台，具平台到达即撤销已确认 Other；
 * - `data:` 图标仅转交 iconStore M1 缓冲（`via: 'm2'`），池内剥空；
 * - 详情落定经 `upsertRepoCardFromDetail` 单点合入并向 `subscribeRepoCardHeals` 订阅方扇出；
 * - 登出时按记录的私有仓库 id 清池。
 */
import type { AppDetail, AppSummary, HydratedRepoCard, TrendRepo } from '../types';
import { tauriApi } from './api';
import { admitIconHit, resolveIconWithBuffer } from './iconStore';
import { normalizeId } from './normalizeId';

/* ------------------------------------------------------------------ */
/* A. 容量、口径与字段判定                                             */
/* ------------------------------------------------------------------ */

/** 富卡池 TTL：12h（坐标元数据日内几乎不变，与 DOFORCE 快照同口径）。 */
export const REPO_ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 富卡池至多 600 条（与 iconStore 同容量）。 */
export const REPO_ENRICH_CACHE_MAX_ENTRIES = 600;

/** 已确认 Other 标记 TTL；到期后重验，具平台到达时自动覆盖。 */
const CONFIRMED_OTHER_TTL_MS = REPO_ENRICH_CACHE_TTL_MS;
/** 已确认 Other 标记至多 600 条，FIFO 裁剪。 */
const CONFIRMED_OTHER_MAX_ENTRIES = 600;

const RICH_CATEGORY_PLACEHOLDERS = new Set(['', 'external', 'dev', 'system']);
const RICH_VERSION_PLACEHOLDERS = new Set(['latest', '...']);
/** 简介占位文案名单（与后端 `detail_fetch.rs` 对齐）。 */
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
  return t.toLowerCase().includes('no description available');
}

/** 具平台判定：platforms 非空数组即具平台；空/缺失一律 loading。 */
function hasConcretePlatforms(platforms: unknown): boolean {
  return Array.isArray(platforms) && platforms.length > 0;
}

function readLoose(obj: object, key: string): unknown {
  return (obj as Record<string, unknown>)[key];
}

function writeLoose(obj: object, key: string, value: unknown): void {
  (obj as Record<string, unknown>)[key] = value;
}

function richStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

function isPlaceholderText(v: unknown): boolean {
  return isBlank(v) || isPlaceholderDescription(v);
}

function isPlaceholderVersion(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return t === '' || t === 'latest' || t === '...';
}

function isPlaceholderLicense(v: unknown): boolean {
  if (isBlank(v)) return true;
  const t = (v as string).trim();
  return t === '...' || t === 'OpenSource' || /^(unknown|noassertion)$/i.test(t);
}

function isDataIcon(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('data:');
}

function coordKeyOf(owner: unknown, repo: unknown): string {
  if (typeof owner !== 'string' || typeof repo !== 'string') return '';
  const o = owner.trim();
  const r = repo.trim();
  return o && r ? `${normalizeId(o)}/${normalizeId(r)}` : '';
}

function isFresh(timestamp: number, now: number, ttl: number): boolean {
  const elapsed = now - timestamp;
  return elapsed >= 0 && elapsed < ttl;
}

/** 剥离运行时目录标注（`source`/`status`/`is_cataloged`），避免写入共享池。 */
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

/* ------------------------------------------------------------------ */
/* B. M1 卡片表与已确认 Other 表                                       */
/* ------------------------------------------------------------------ */

const cardPool = new Map<string, { timestamp: number; data: AppSummary }>();
const confirmedOtherPool = new Map<string, number>();

function putConfirmedOtherEntry(key: string, timestamp: number): void {
  if (confirmedOtherPool.has(key)) confirmedOtherPool.delete(key);
  confirmedOtherPool.set(key, timestamp);
  while (confirmedOtherPool.size > CONFIRMED_OTHER_MAX_ENTRIES) {
    const oldest = confirmedOtherPool.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) break;
    confirmedOtherPool.delete(oldest);
  }
}

/** 写入卡片表：非破坏字段合并、`data:` 图标剥空、具平台自动撤销已确认 Other。 */
function putCard(key: string, timestamp: number, incoming: AppSummary): void {
  const k = normalizeId(key);
  if (!k) return;
  if (readLoose(incoming, 'is_stale') === true) return;
  const cur = cardPool.get(k);
  const merged = fillMissingFromPrev(cur?.data, { ...stripCatalogAnnotations(incoming) });
  const resolved = stripCatalogAnnotations(resolveIconWithBuffer(cur?.data, merged));
  const data = isDataIcon(resolved.icon) ? { ...resolved, icon: '' } : resolved;
  const ts = cur ? Math.max(cur.timestamp, timestamp) : timestamp;
  if (cur) cardPool.delete(k);
  cardPool.set(k, { timestamp: ts, data });
  if (hasConcretePlatforms(data.platforms)) confirmedOtherPool.delete(k);
  while (cardPool.size > REPO_ENRICH_CACHE_MAX_ENTRIES) {
    const oldest = cardPool.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === k) break;
    cardPool.delete(oldest);
  }
}

/** 卡片表原始读取（不判新鲜度，供 enrich 粘性合并）。 */
export function peekRepoCardEntry(key: string): AppSummary | undefined {
  const k = normalizeId(key);
  return k ? cardPool.get(k)?.data : undefined;
}

/** 单键写入卡片表（供批处理写透；收录卡由调用方跳过）。 */
export function putRepoCard(key: string, data: AppSummary, timestamp = Date.now()): void {
  putCard(key, timestamp, data);
}

/** 标记单键为已确认 Other（已具平台则跳过）。 */
export function markRepoConfirmedOther(key: string): void {
  const k = normalizeId(key);
  if (!k) return;
  const cur = cardPool.get(k);
  if (cur && hasConcretePlatforms(cur.data.platforms)) return;
  putConfirmedOtherEntry(k, Date.now());
}

/** 批量标记已确认 Other（空键/已具平台逐项跳过）。 */
export function markRepoConfirmedOthers(keys: readonly string[]): void {
  if (!keys) return;
  for (const raw of keys) {
    if (typeof raw === 'string') markRepoConfirmedOther(raw);
  }
}

/** 与 `markRepoConfirmedOthers` 同义（容忍空入参），时间戳取 now。 */
export function markConfirmedOthersFreshNow(keys?: readonly string[] | null): void {
  if (keys) markRepoConfirmedOthers(keys);
}

/** 移除单键已确认标记。 */
export function unmarkRepoConfirmedOther(key: string): void {
  const k = normalizeId(key);
  if (k) confirmedOtherPool.delete(k);
}

/** 批量移除已确认标记。 */
export function unmarkRepoConfirmedOthers(keys: readonly string[]): void {
  if (!keys) return;
  for (const raw of keys) {
    if (typeof raw === 'string') unmarkRepoConfirmedOther(raw);
  }
}

/** 该键是否为新鲜（12h 内）已确认 Other；已到达具平台条目时同步清理标记。 */
export function isRepoConfirmedOtherFresh(key: string): boolean {
  const k = normalizeId(key);
  if (!k) return false;
  const cur = cardPool.get(k);
  if (cur && hasConcretePlatforms(cur.data.platforms)) {
    confirmedOtherPool.delete(k);
    return false;
  }
  const ts = confirmedOtherPool.get(k);
  if (ts === undefined) return false;
  if (!isFresh(ts, Date.now(), CONFIRMED_OTHER_TTL_MS)) {
    confirmedOtherPool.delete(k);
    return false;
  }
  return true;
}

/** 导出新鲜已确认 Other 键；传入 repos 时仅返回属该序列的键。 */
export function snapshotRepoConfirmedOthers(repos?: TrendRepo[]): string[] {
  const now = Date.now();
  const fresh: string[] = [];
  for (const [k, ts] of confirmedOtherPool) {
    const cur = cardPool.get(k);
    if (!isFresh(ts, now, CONFIRMED_OTHER_TTL_MS) || (cur && hasConcretePlatforms(cur.data.platforms))) {
      confirmedOtherPool.delete(k);
      continue;
    }
    fresh.push(k);
  }
  if (!repos || repos.length === 0) return fresh;
  const wanted = new Set<string>();
  for (const r of repos) {
    const ck = coordKeyOf(r.owner, r.repo);
    if (ck) wanted.add(ck);
    if (r.id) wanted.add(normalizeId(r.id));
  }
  return fresh.filter((k) => wanted.has(k));
}

/** 仅供测试/列表切换：清空已确认 Other 标记。 */
export function clearRepoConfirmedOtherCache(): void {
  confirmedOtherPool.clear();
}

/** 清空卡片表与已确认 Other 表。 */
export function clearRepoEnrichCache(): void {
  cardPool.clear();
  confirmedOtherPool.clear();
}

/** 切表顺手 sweep 过期条目（不加 timer）。 */
export function sweepExpiredRepoEnrichCache(): void {
  const now = Date.now();
  for (const [k, v] of cardPool) {
    if (!isFresh(v.timestamp, now, REPO_ENRICH_CACHE_TTL_MS)) cardPool.delete(k);
  }
  for (const [k, ts] of confirmedOtherPool) {
    if (!isFresh(ts, now, CONFIRMED_OTHER_TTL_MS)) confirmedOtherPool.delete(k);
  }
}

/** 按键驱逐卡片与已确认 Other 标记。 */
export function evictRepoEnrichKeys(keys: Iterable<string>): void {
  for (const raw of keys) {
    const k = normalizeId(raw);
    if (!k) continue;
    cardPool.delete(k);
    confirmedOtherPool.delete(k);
  }
}

/** 批量回填未收录富卡（`data:` 图标先注入 iconStore 缓冲并在池内剥空；收录卡与 stale 跳过）。 */
export function putRepoEnrichMemory(
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
    if (isBlank(summary.id) || isBlank(summary.owner) || isBlank(summary.repo)) continue;
    if (!Array.isArray(summary.platforms)) continue;
    const key = normalizeId(rawKey);
    if (!key) continue;
    if (isDataIcon(summary.icon)) {
      admitIconHit({ id: key, icon: summary.icon, via: 'm2' });
    }
    putCard(key, at, summary);
    const ck = coordKeyOf(summary.owner, summary.repo);
    if (ck && ck !== key) putCard(ck, at, summary);
  }
}

/** 读池内新鲜（12h 内）的单仓富卡，三态均返回（卡片存在性）。 */
export function peekFreshRepoCard(key: string, now = Date.now()): AppSummary | undefined {
  const k = normalizeId(key);
  if (!k) return undefined;
  const hit = cardPool.get(k);
  if (!hit || readLoose(hit.data, 'is_stale') === true) return undefined;
  return isFresh(hit.timestamp, now, REPO_ENRICH_CACHE_TTL_MS) ? hit.data : undefined;
}

/** 读新鲜且平台已落定的富卡：具平台，或空平台且已确认 Other。 */
export function peekFreshSettledRepoCard(key: string, now = Date.now()): AppSummary | undefined {
  const hit = peekFreshRepoCard(key, now);
  if (!hit) return undefined;
  if (hasConcretePlatforms(hit.platforms)) return hit;
  const ts = confirmedOtherPool.get(normalizeId(key));
  return ts !== undefined && isFresh(ts, now, CONFIRMED_OTHER_TTL_MS) ? hit : undefined;
}

/** 卡片元数据是否仍在 12h 新鲜期；空平台条目过期即驱逐，具平台条目保留供图标粘性合并。 */
export function takeFreshEnrichEntry(key: string, now = Date.now(), force = false): boolean {
  if (force) return false;
  const hit = cardPool.get(key);
  if (!hit) return false;
  const elapsed = now - hit.timestamp;
  if (!hasConcretePlatforms(hit.data.platforms)) {
    if (elapsed >= 0 && elapsed < REPO_ENRICH_CACHE_TTL_MS) return true;
    cardPool.delete(key);
    return false;
  }
  if (elapsed < 0) {
    cardPool.delete(key);
    return false;
  }
  return elapsed < REPO_ENRICH_CACHE_TTL_MS;
}

/** 导出未过期且已落定的富卡快照（具平台或已确认 Other，跳过 `data:` 图标）。 */
export function snapshotSettledRepoCards(repos?: TrendRepo[]): Record<string, AppSummary> {
  const now = Date.now();
  const out: Record<string, AppSummary> = {};
  const confirmed = new Set(snapshotRepoConfirmedOthers());
  const usable = (hit: { timestamp: number; data: AppSummary } | undefined): boolean =>
    !!hit &&
    readLoose(hit.data, 'is_stale') !== true &&
    isFresh(hit.timestamp, now, REPO_ENRICH_CACHE_TTL_MS) &&
    !isDataIcon(hit.data.icon);
  if (repos && repos.length > 0) {
    for (const r of repos) {
      const ck = coordKeyOf(r.owner, r.repo);
      const idKey = r.id ? normalizeId(r.id) : '';
      const coordHit = ck ? cardPool.get(ck) : undefined;
      const hit = coordHit ?? (idKey ? cardPool.get(idKey) : undefined);
      if (!hit || !usable(hit)) continue;
      const storedKey = coordHit ? ck : idKey;
      const targetKey = ck || idKey;
      if (!hasConcretePlatforms(hit.data.platforms)) {
        if (!confirmed.has(storedKey) && (!targetKey || !confirmed.has(targetKey))) continue;
      }
      if (targetKey) out[targetKey] = hit.data;
    }
    return out;
  }
  for (const [key, hit] of cardPool.entries()) {
    if (!usable(hit)) continue;
    if (!hasConcretePlatforms(hit.data.platforms) && !confirmed.has(key)) continue;
    out[key] = hit.data;
  }
  return out;
}

/** 导出给定仓库集合中可展示的 12h 内非 stale 卡片快照（三态，跳过 `data:` 图标）。 */
export function snapshotRepoCardsForRepos(repos: readonly TrendRepo[]): Record<string, AppSummary> {
  const now = Date.now();
  const out: Record<string, AppSummary> = {};
  for (const r of repos ?? []) {
    const ck = coordKeyOf(r.owner, r.repo);
    const idKey = r.id ? normalizeId(r.id) : '';
    const targetKey = ck || idKey;
    if (!targetKey) continue;
    const hit = (ck ? cardPool.get(ck) : undefined) ?? (idKey ? cardPool.get(idKey) : undefined);
    if (!hit || readLoose(hit.data, 'is_stale') === true) continue;
    if (!isFresh(hit.timestamp, now, REPO_ENRICH_CACHE_TTL_MS)) continue;
    if (isDataIcon(hit.data.icon)) continue;
    out[targetKey] = hit.data;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* C. 字段合并与 diff                                                  */
/* ------------------------------------------------------------------ */

/** 图标粘性合并：`data:` 原样透出，其余经 `resolveIconWithBuffer` 合并。 */
export function mergeIconSticky(prev: AppSummary | undefined, next: AppSummary): AppSummary {
  if (isDataIcon(next.icon)) return next;
  return resolveIconWithBuffer(prev, next);
}

/** 用已有富卡 `prev` 回填 `merged` 中的空值与占位字段（就地修改并返回 `merged`）。 */
export function fillMissingFromPrev(prev: AppSummary | undefined, merged: AppSummary): AppSummary {
  if (!prev) return merged;
  const incomingIcon = richStr(merged.icon);
  const prevIcon = richStr(prev.icon);
  if (incomingIcon === '' || incomingIcon.startsWith('data:')) {
    merged.icon = prevIcon !== '' && !prevIcon.startsWith('data:') ? prev.icon : '';
  }
  if (richStr(merged.name) === '' || richStr(merged.name) === '加载中...') merged.name = prev.name;
  for (const f of ['description', 'description_en'] as const) {
    const bv = richStr(readLoose(merged, f));
    if (bv === '' || isPlaceholderDescription(bv)) writeLoose(merged, f, readLoose(prev, f));
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
    const pc = richStr(prev.category);
    if ((pc !== '' && !RICH_CATEGORY_PLACEHOLDERS.has(pc.toLowerCase())) || mc === '') {
      merged.category = prev.category;
    }
  }
  for (const f of ['category_name', 'forge', 'forge_host', 'owner', 'repo'] as const) {
    if (richStr(readLoose(merged, f)) === '') writeLoose(merged, f, readLoose(prev, f));
  }
  if (isBlank(merged.homepage)) merged.homepage = prev.homepage;
  if (!hasConcretePlatforms(merged.platforms) && hasConcretePlatforms(prev.platforms)) {
    merged.platforms = [...prev.platforms];
  }
  return merged;
}

/** `next` 相对 `prev` 的实质变更字段（空/占位不算变更；icon/platforms 永不在内）。 */
export function diffRichSummary(prev: AppSummary, next: AppSummary): string[] {
  const dirty: string[] = [];
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return dirty;
  {
    const a = richStr(prev.name);
    const b = richStr(next.name);
    if (b !== '' && b !== '加载中...' && a !== b) dirty.push('name');
  }
  for (const f of ['description', 'description_en'] as const) {
    const a = richStr(readLoose(prev, f));
    const b = richStr(readLoose(next, f));
    if (b !== '' && !isPlaceholderDescription(b) && a !== b) dirty.push(f);
  }
  for (const f of ['stars', 'forks'] as const) {
    if (Number(readLoose(prev, f)) !== Number(readLoose(next, f))) dirty.push(f);
  }
  {
    const a = richStr(prev.license);
    const b = richStr(next.license);
    if (b !== '' && a !== b) {
      const forge = richStr(next.forge).toLowerCase();
      if (!(b === 'OpenSource' && forge !== 'github')) dirty.push('license');
    }
  }
  {
    const a = readLoose(prev, 'latest_version');
    const b = readLoose(next, 'latest_version');
    if (a !== b && !RICH_VERSION_PLACEHOLDERS.has(b as string)) dirty.push('latest_version');
  }
  {
    const a = richStr(prev.category);
    const b = richStr(next.category);
    if (b !== '' && !RICH_CATEGORY_PLACEHOLDERS.has(b.toLowerCase()) && a !== b) dirty.push('category');
  }
  for (const f of ['category_name', 'forge', 'forge_host', 'owner', 'repo'] as const) {
    const a = richStr(readLoose(prev, f));
    const b = richStr(readLoose(next, f));
    if (b !== '' && a !== b) dirty.push(f);
  }
  if (Boolean(prev.is_verified) !== Boolean(next.is_verified)) dirty.push('is_verified');
  {
    const a = richStr(prev.homepage) || null;
    const b = richStr(next.homepage) || null;
    if (b !== null && a !== b) dirty.push('homepage');
  }
  return dirty;
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

/* ------------------------------------------------------------------ */
/* D. 行水合与占位治愈                                                 */
/* ------------------------------------------------------------------ */

function lookupPooledCard(keys: readonly string[]): AppSummary | undefined {
  for (const k of keys) {
    const hit = k ? peekFreshRepoCard(k) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function rowKeys(
  row: { id?: unknown; owner?: unknown; repo?: unknown },
  extraKeys?: readonly string[],
): string[] {
  const out: string[] = [];
  const push = (k: string): void => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const k of extraKeys ?? []) push(typeof k === 'string' ? normalizeId(k) : '');
  push(typeof row.id === 'string' ? normalizeId(row.id) : '');
  push(coordKeyOf(row.owner, row.repo));
  return out;
}

/** 读池内新鲜（12h 内）且平台已落定的富卡。 */
export function readSharedRepoEnrich(idOrCoord: string): AppSummary | undefined {
  return peekFreshSettledRepoCard(idOrCoord);
}

/** 该仓库平台是否已落定（具平台或已确认 Other）。 */
export function hasSettledRepoPlatforms(idOrCoord: string): boolean {
  return readSharedRepoEnrich(idOrCoord) !== undefined;
}

/** 该仓库是否已在任一视图被确认为 Other（无可安装资产）。 */
export function isSharedRepoConfirmedOther(idOrCoord: string): boolean {
  return isRepoConfirmedOtherFresh(idOrCoord);
}

type HealableRow = {
  id?: unknown;
  owner?: unknown;
  repo?: unknown;
  description?: unknown;
  description_en?: unknown;
  homepage?: unknown;
};

/**
 * 用共享池的实质值治愈行内占位/空白的 `description`、`description_en` 与 `homepage`。
 * 无可改进时返回原引用；`extraKeys` 供详情 id 与行 id 不一致时补充查找键。
 */
export function healSummaryPlaceholders<T extends HealableRow>(
  row: T,
  opts?: { extraKeys?: readonly string[] },
): T {
  if (!row) return row;
  const needDesc = isPlaceholderText(row.description);
  const needDescEn = isPlaceholderText(row.description_en);
  const needHomepage = isBlank(row.homepage);
  if (!needDesc && !needDescEn && !needHomepage) return row;
  const patch: Partial<HealableRow> = {};
  for (const k of rowKeys(row, opts?.extraKeys)) {
    const hit = peekFreshRepoCard(k);
    if (!hit) continue;
    if (needDesc && patch.description === undefined && !isPlaceholderText(hit.description)) {
      patch.description = hit.description;
    }
    if (needDescEn && patch.description_en === undefined && !isPlaceholderText(hit.description_en)) {
      patch.description_en = hit.description_en;
    }
    if (needHomepage && patch.homepage === undefined && !isBlank(hit.homepage)) {
      patch.homepage = hit.homepage;
    }
  }
  return Object.keys(patch).length > 0 ? { ...row, ...patch } : row;
}

/** 从共享池回填首绘缺省字段（平台、简介、协议、主页、图标）；无可改进时返回原引用。 */
export function hydrateRowFromSharedEnrich(row: AppSummary): AppSummary {
  if (!row) return row;
  const hit = lookupPooledCard(rowKeys(row));
  if (!hit) return row;
  const healed = healSummaryPlaceholders(row);
  const patch: Partial<AppSummary> = {};
  if (!hasConcretePlatforms(row.platforms) && hasConcretePlatforms(hit.platforms)) {
    patch.platforms = [...hit.platforms];
    if (isPlaceholderVersion(row.latest_version) && !isPlaceholderVersion(hit.latest_version)) {
      patch.latest_version = hit.latest_version;
    }
  }
  if (isPlaceholderLicense(row.license) && !isPlaceholderLicense(hit.license)) {
    patch.license = hit.license;
  }
  if (isBlank(row.icon) && !isBlank(hit.icon)) patch.icon = hit.icon;
  if (Object.keys(patch).length === 0) return healed;
  return { ...healed, ...patch };
}

/* ------------------------------------------------------------------ */
/* E. 视图写回                                                         */
/* ------------------------------------------------------------------ */

/** 写入卡片（任意平台态）；收录卡由池入口跳过。 */
export function recordSharedRepoCards(rows: readonly AppSummary[]): void {
  if (!rows || rows.length === 0) return;
  const out = new Map<string, AppSummary>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const key = normalizeId(row.id);
    if (key) out.set(key, row);
  }
  if (out.size > 0) putRepoEnrichMemory(out);
}

/** 写回具平台信息（优先取 `patched`），并撤销对应仓库的已确认 Other 标记。 */
export function recordSharedRepoPlatforms(
  rows: readonly AppSummary[],
  patched?: ReadonlyMap<string, string[]>,
): void {
  if (!rows || rows.length === 0) return;
  const out = new Map<string, AppSummary>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const key = normalizeId(row.id);
    if (!key) continue;
    const fromPatch = patched?.get(key);
    const platforms =
      fromPatch && fromPatch.length > 0
        ? fromPatch
        : hasConcretePlatforms(row.platforms)
          ? row.platforms
          : undefined;
    if (!platforms) continue;
    out.set(key, { ...row, platforms: [...platforms] });
  }
  if (out.size > 0) putRepoEnrichMemory(out);
}

/** 写回已确认 Other（已具平台的仓库跳过）。 */
export function recordSharedConfirmedOthers(ids: readonly string[]): void {
  if (!ids || ids.length === 0) return;
  markRepoConfirmedOthers(ids);
}

/** 本会话见到的私有仓库规范 id（登出时据此清池）。 */
const privateRepoIds = new Set<string>();

/** 记录私有仓库 id（来自后端 `private_ids` / `is_private`）。 */
export function recordSharedPrivateRepos(ids: readonly string[]): void {
  if (!ids) return;
  for (const raw of ids) {
    const k = typeof raw === 'string' ? normalizeId(raw) : '';
    if (k) privateRepoIds.add(k);
  }
}

/** 登出：从共享池清除全部私有仓库富卡与其已确认 Other 标记。 */
export function clearPrivateSharedRepoCards(): void {
  if (privateRepoIds.size === 0) return;
  evictRepoEnrichKeys(privateRepoIds);
  privateRepoIds.clear();
}

/* ------------------------------------------------------------------ */
/* F. 详情落定合入与治愈扇出                                           */
/* ------------------------------------------------------------------ */

/** 详情匹配键全集（id / owner-repo 归一）。 */
export function detailHealKeysFor(id: string, owner: string, repo: string): string[] {
  const out = new Set<string>();
  if (id) out.add(normalizeId(id));
  const ck = coordKeyOf(owner, repo);
  if (ck) out.add(ck);
  return [...out].filter((k) => k.length > 0);
}

/** 由详情构造卡片摘要（剥离占位简介，保留真实字段）。 */
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

/** 详情落定后向订阅方扇出的已计算补丁。 */
export interface RepoCardHeal {
  /** 归一匹配键：id / owner-repo 及调用方别名。 */
  keys: string[];
  /** 合并后的池内摘要（占位与空值已由旧值回填，`data:` 图标剥空）。 */
  summary: AppSummary;
  /** 相对池内旧值的实质变更字段（见 `diffRichSummary`）。 */
  dirtyFields: string[];
  /** 详情具平台时携带（订阅方据此补平台并撤销已确认 Other）。 */
  platforms?: string[];
  /** 详情非 stale 且平台为空：已确认 Other。 */
  confirmedOther?: boolean;
}

export interface UpsertRepoCardOptions {
  /** 池内缺席时的旧值兜底（如列表快照）。 */
  prevLookup?: (key: string) => AppSummary | undefined;
  /** 额外匹配键（详情 id 与打开时 id 不一致时）。 */
  aliases?: readonly string[];
}

const healListeners = new Set<(heal: RepoCardHeal) => void>();

/** 订阅详情落定补丁；返回退订函数。 */
export function subscribeRepoCardHeals(listener: (heal: RepoCardHeal) => void): () => void {
  healListeners.add(listener);
  return () => {
    healListeners.delete(listener);
  };
}

/**
 * 将非 stale 详情合入富卡池并扇出补丁：具平台撤销已确认 Other，空平台记为已确认 Other
 * （池内已具平台时保持具平台，单调不回退）。stale 或无效详情返回 null 且不写池。
 */
export function upsertRepoCardFromDetail(
  detail: AppDetail,
  opts?: UpsertRepoCardOptions,
): RepoCardHeal | null {
  if (!detail || typeof detail !== 'object' || detail.is_stale) return null;
  if (isBlank(detail.id)) return null;
  const keys = detailHealKeysFor(detail.id, detail.owner, detail.repo);
  for (const raw of opts?.aliases ?? []) {
    const k = typeof raw === 'string' ? normalizeId(raw) : '';
    if (k && !keys.includes(k)) keys.push(k);
  }
  let prev: AppSummary | undefined;
  for (const k of keys) {
    prev = cardPool.get(k)?.data;
    if (prev) break;
  }
  if (!prev && typeof opts?.prevLookup === 'function') {
    for (const k of keys) {
      try {
        prev = opts.prevLookup(k);
      } catch {
        prev = undefined;
      }
      if (prev) break;
    }
  }
  const merged = fillMissingFromPrev(prev, appSummaryFromDetail(detail));
  if (isDataIcon(merged.icon)) merged.icon = '';
  const at = Date.now();
  for (const k of keys) putCard(k, at, merged);
  const concrete = hasConcretePlatforms(merged.platforms);
  if (!concrete) markRepoConfirmedOthers(keys);
  const heal: RepoCardHeal = {
    keys,
    summary: merged,
    dirtyFields: diffRichSummary(prev ?? emptyRichBaseline(), merged),
    ...(concrete ? { platforms: [...merged.platforms] } : { confirmedOther: true }),
  };
  for (const fn of [...healListeners]) {
    try {
      fn(heal);
    } catch {
      // 单个订阅方失败不阻塞其余
    }
  }
  return heal;
}

/* ------------------------------------------------------------------ */
/* G. 批量水合                                                         */
/* ------------------------------------------------------------------ */

export interface HydrateCardsOptions {
  catalogApps?: readonly AppSummary[];
  localApps?: readonly AppSummary[];
  /** 仅水合未收录项（如趋势榜已在本地匹配目录）：跳过本地目录数组扫描。 */
  uncatalogedOnly?: boolean;
}

export interface HydrateCardsResult {
  /** 按入参有序返回已水合的卡片（缺失 id 跳过）。 */
  rows: AppSummary[];
  /** 归一小写 id → 已水合卡片（图标已过 M1 缓冲合并）。 */
  byId: Map<string, AppSummary>;
  /** 本批命中已确认 Other 的归一小写 id。 */
  confirmedOtherIds: string[];
  /** 卡片元数据仍在 12h 新鲜窗口内的归一小写 id（供趋势榜跳过重复 enrich）。 */
  freshCardIds: Set<string>;
}

function buildCatalogIndex(opts: HydrateCardsOptions | undefined): Map<string, AppSummary> {
  const index = new Map<string, AppSummary>();
  if (!opts || opts.uncatalogedOnly) return index;
  for (const list of [opts.catalogApps, opts.localApps]) {
    for (const app of list ?? []) {
      if (!app || typeof app.id !== 'string') continue;
      const k = normalizeId(app.id);
      if (k && !index.has(k)) index.set(k, app);
      const ck = coordKeyOf(app.owner, app.repo);
      if (ck && !index.has(ck)) index.set(ck, app);
    }
  }
  return index;
}

/** 按有序 id 批量水合卡片（目录 → M1 共享池 → `get_repo_cards_batch`），并叠加缓冲图标。 */
export async function hydrateCardsByIds(
  ids: readonly string[],
  opts?: HydrateCardsOptions,
): Promise<HydrateCardsResult> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const k = typeof raw === 'string' ? normalizeId(raw) : '';
    if (!k || seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
  const byId = new Map<string, AppSummary>();
  const confirmedOther = new Set<string>();
  const freshCardIds = new Set<string>();
  const catalogIndex = buildCatalogIndex(opts);
  const missing: string[] = [];
  const now = Date.now();

  for (const id of order) {
    const cataloged = catalogIndex.get(id);
    if (cataloged) {
      byId.set(id, resolveIconWithBuffer(undefined, cataloged));
      continue;
    }
    const pooled = peekFreshRepoCard(id);
    if (pooled) {
      byId.set(id, resolveIconWithBuffer(undefined, pooled));
      freshCardIds.add(id);
      if (!hasConcretePlatforms(pooled.platforms) && isRepoConfirmedOtherFresh(id)) confirmedOther.add(id);
      continue;
    }
    missing.push(id);
  }

  if (missing.length > 0) {
    let cards: (HydratedRepoCard | null)[] = [];
    try {
      cards = await tauriApi.getRepoCardsBatch(missing);
    } catch {
      cards = [];
    }
    missing.forEach((id, i) => {
      const card = Array.isArray(cards) ? cards[i] : null;
      const summary = card?.summary;
      if (!card || !summary || typeof summary !== 'object') return;
      const icon = typeof summary.icon === 'string' ? summary.icon.trim() : '';
      if (icon !== '') admitIconHit({ id, icon, via: 'm2' });
      if (summary.is_cataloged === true) {
        byId.set(id, resolveIconWithBuffer(undefined, summary));
        return;
      }
      if (card.is_private === true) recordSharedPrivateRepos([id]);
      if (card.confirmed_other === true && !hasConcretePlatforms(summary.platforms)) {
        markConfirmedOthersFreshNow([id]);
        confirmedOther.add(id);
      }
      const updatedAt = Number(card.updated_at);
      if (Number.isFinite(updatedAt) && updatedAt > 0 && isFresh(updatedAt * 1000, now, REPO_ENRICH_CACHE_TTL_MS)) {
        putRepoEnrichMemory(new Map([[id, summary]]), { timestamp: updatedAt * 1000 });
        freshCardIds.add(id);
      }
      byId.set(id, resolveIconWithBuffer(undefined, summary));
    });
  }

  const rows: AppSummary[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (row) rows.push(row);
  }
  return { rows, byId, confirmedOtherIds: [...confirmedOther], freshCardIds };
}
