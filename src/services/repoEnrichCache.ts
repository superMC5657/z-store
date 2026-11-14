/**
 * 单仓富卡共享镜像（Repo Enrich Cache）：SQLite `repo_card_cache` 的前端 M1 镜像，
 * 趋势榜、在线搜索与 GitHub Star 三条链路按规范应用标识共享未收录仓库的轻量富卡。
 * 底层与趋势 `trendEnrichCache` / `trendConfirmedOtherCache` 为同一存储（12h TTL、600 条 FIFO）：
 * - 三态均可入池：具体平台 > 已确认 Other > 平台未知（卡片已知、平台待推导）；
 * - 写入非破坏合并：空/占位字段与未知空平台不覆盖实值、具体平台或已确认 Other；
 * - `data:` 图标只驻 iconStore M1 缓冲，收录态标注在池入口剥离（见 `trends/enrich`）；
 * - 列表只存有序 id 索引，卡片经 `hydrateCardsByIds` 按「目录 → M1 → `get_repo_cards_batch`」水合；
 * - 私有仓库 id 单独记录，登出即从池内清除。
 */
import type { AppSummary, HydratedRepoCard } from '../types';
import { tauriApi } from './api';
import { admitIconHit, resolveIconWithBuffer } from './iconStore';
import {
  isTrendConfirmedOtherFresh,
  isPlaceholderDescription,
  markConfirmedOthersFreshNow,
  markTrendConfirmedOthers,
  peekFreshRepoCard as peekPooledCard,
  peekFreshTrendEnrich,
  putTrendEnrichMemory,
  evictTrendEnrichKeys,
  TREND_ENRICH_CACHE_TTL_MS,
} from './trends/enrich';
import { normalizeId } from './normalizeId';

function coordKey(row: Pick<AppSummary, 'owner' | 'repo'> | undefined): string {
  if (!row || typeof row.owner !== 'string' || typeof row.repo !== 'string') return '';
  const owner = row.owner.trim();
  const repo = row.repo.trim();
  return owner && repo ? `${normalizeId(owner)}/${normalizeId(repo)}` : '';
}

function isPlaceholderVersion(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return t === '' || t === 'latest' || t === '...';
}

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

function isPlaceholderText(v: unknown): boolean {
  return isBlank(v) || isPlaceholderDescription(v);
}

function isPlaceholderLicense(v: unknown): boolean {
  if (isBlank(v)) return true;
  const t = (v as string).trim();
  return t === '...' || t === 'OpenSource' || /^(unknown|noassertion)$/i.test(t);
}

function hasPlatforms(row: Pick<AppSummary, 'platforms'> | undefined): boolean {
  return Array.isArray(row?.platforms) && row.platforms.length > 0;
}

/** 读池内新鲜（12h 内）的单仓富卡，三态均返回（卡片存在性）。 */
export function peekFreshRepoCard(idOrCoord: string): AppSummary | undefined {
  return peekPooledCard(idOrCoord);
}

/** 读共享池中新鲜（12h 内）且平台已落定的富卡：具平台，或空平台且已确认 Other。 */
export function readSharedRepoEnrich(idOrCoord: string): AppSummary | undefined {
  return peekFreshTrendEnrich(idOrCoord);
}

/** 该仓库平台是否已落定（具平台或已确认 Other）。 */
export function hasSettledRepoPlatforms(idOrCoord: string): boolean {
  return readSharedRepoEnrich(idOrCoord) !== undefined;
}

/** 该仓库是否已在任一视图被确认为 Other（无可安装资产）。 */
export function isSharedRepoConfirmedOther(idOrCoord: string): boolean {
  return isTrendConfirmedOtherFresh(idOrCoord);
}

function lookupPooledCard(row: AppSummary): AppSummary | undefined {
  const idKey = normalizeId(row.id);
  const ck = coordKey(row);
  return (idKey ? peekPooledCard(idKey) : undefined) ?? (ck ? peekPooledCard(ck) : undefined);
}

/**
 * 首绘回填：行缺平台而池内卡片具平台时补平台（真实版本同时替换占位版本）；
 * 行为裸壳时补齐池内非占位的简介、协议、主页与远端图标。无可改进时原样返回同一引用。
 */
export function hydrateRowFromSharedEnrich(row: AppSummary): AppSummary {
  if (!row) return row;
  const hit = lookupPooledCard(row);
  if (!hit) return row;
  const patch: Partial<AppSummary> = {};
  if (!hasPlatforms(row) && hasPlatforms(hit)) {
    patch.platforms = [...hit.platforms];
    if (isPlaceholderVersion(row.latest_version) && !isPlaceholderVersion(hit.latest_version)) {
      patch.latest_version = hit.latest_version;
    }
  }
  if (isPlaceholderText(row.description) && !isPlaceholderText(hit.description)) {
    patch.description = hit.description;
  }
  if (isPlaceholderText(row.description_en) && !isPlaceholderText(hit.description_en)) {
    patch.description_en = hit.description_en;
  }
  if (isPlaceholderLicense(row.license) && !isPlaceholderLicense(hit.license)) {
    patch.license = hit.license;
  }
  if (isBlank(row.homepage) && !isBlank(hit.homepage)) {
    patch.homepage = hit.homepage;
  }
  if (isBlank(row.icon) && !isBlank(hit.icon)) {
    patch.icon = hit.icon;
  }
  return Object.keys(patch).length > 0 ? { ...row, ...patch } : row;
}

/** 写入未收录卡片（任意平台态）；收录卡由池入口跳过。 */
export function recordSharedRepoCards(rows: readonly AppSummary[]): void {
  if (!rows || rows.length === 0) return;
  const out = new Map<string, AppSummary>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const key = normalizeId(row.id);
    if (key) out.set(key, row);
  }
  if (out.size > 0) putTrendEnrichMemory(out);
}

/**
 * 写回具平台：`patched`（归一 id → 平台）优先，否则取行自带的非空平台。
 * 写入具平台会同时撤销该仓的已确认 Other 标记；空平台行跳过。
 */
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
        : Array.isArray(row.platforms) && row.platforms.length > 0
          ? row.platforms
          : undefined;
    if (!platforms) continue;
    out.set(key, { ...row, platforms: [...platforms] });
  }
  if (out.size > 0) putTrendEnrichMemory(out);
}

/** 写回已确认 Other（已具平台的仓库由底层守卫跳过）。 */
export function recordSharedConfirmedOthers(ids: readonly string[]): void {
  if (!ids || ids.length === 0) return;
  markTrendConfirmedOthers(ids);
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
  evictTrendEnrichKeys(privateRepoIds);
  privateRepoIds.clear();
}

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
      const ck = coordKey(app);
      if (ck && !index.has(ck)) index.set(ck, app);
    }
  }
  return index;
}

function isFreshUpdatedAt(updatedAtSecs: number, now: number): boolean {
  if (!Number.isFinite(updatedAtSecs) || updatedAtSecs <= 0) return false;
  const elapsed = now - updatedAtSecs * 1000;
  return elapsed >= 0 && elapsed < TREND_ENRICH_CACHE_TTL_MS;
}

/**
 * 按有序 id 批量水合卡片：
 * 1. 去重归一并保持入参顺序；
 * 2. 命中当前合并目录（精选 + 本地库）直接投影；
 * 3. 命中 M1 共享池（12h 内）零 IPC 组装；
 * 4. 其余单次 `get_repo_cards_batch`（DB-only）：确认图标进 iconStore 缓冲，私有/已确认 Other 记账，
 *    未收录卡片按数据库 `updated_at` 写回 M1；
 * 5. 组装时经 `resolveIconWithBuffer` 叠加缓冲图标（`data:` 仅出现在返回对象上，池内永不存）。
 */
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
    const pooled = peekPooledCard(id);
    if (pooled) {
      byId.set(id, resolveIconWithBuffer(undefined, pooled));
      freshCardIds.add(id);
      if (!hasPlatforms(pooled) && isTrendConfirmedOtherFresh(id)) confirmedOther.add(id);
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
      const confirmed = card.confirmed_other === true && !hasPlatforms(summary);
      if (confirmed) {
        markConfirmedOthersFreshNow([id]);
        confirmedOther.add(id);
      }
      const updatedAt = Number(card.updated_at);
      if (isFreshUpdatedAt(updatedAt, now)) {
        putTrendEnrichMemory(new Map([[id, summary]]), { timestamp: updatedAt * 1000 });
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
