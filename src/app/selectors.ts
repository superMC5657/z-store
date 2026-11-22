/**
 * 纯派生选择器：目录合并、平台过滤、侧栏默认计数与行标注。
 * 不持有状态、不发起副作用；`useAppSelectors` 只用 `useMemo` 缓存派生结果。
 */
import { useMemo } from 'react';
import type {
  AppDetailViewModel,
  AppSummary,
  InstalledApp,
  UpdateItem,
  ViewType,
} from '../types';
import { healSummaryPlaceholders } from '../services/repoEnrichCache';
import { inferInstalledFallbackPlatforms } from '../views/manage/manageModel';
import {
  PLATFORM_IDS,
  isPlatformLoading,
  matchPlatformSet,
  matchPlatformSetWithLoading,
  normalizePlatform,
  type PlatformId,
} from '../lib/platformFilter';
import { normalizeId } from '../services/normalizeId';
import { filterMaskedRecentViews } from '../services/recentViewsMask';
import { isCollectedStatus, itemToSummary, type DraftItem, type DraftStatus } from '../services/custom';
// 平台加载中判定与落定超时常量从 lib/platformFilter 重导出
export {
  LOADING_SETTLE_MS,
  isEnrichedRowLoading,
} from '../lib/platformFilter';

interface UseAppSelectorsParams {
  apps: AppSummary[];
  onlineApps: AppSummary[];
  isOnlineResults?: boolean;
  uncatalogedExtraApps: AppSummary[];
  selectedPlatforms: Set<PlatformId>;
  platformResolvedOtherIds: Set<string>;
  selectedApp: AppDetailViewModel | null;
  recentlyViewedApps: AppSummary[];
  currentView: ViewType;
  stagedDeepLinkInstall: string | null;
  /** 未归档本地收录条目列表与显示开关（默认开启）。 */
  customApps?: AppSummary[];
  showCustom?: boolean;
  searchQuery?: string;
  /** 未经搜索词裁剪的完整目录：全站目录基线（非搜索视图、收藏池、已装查表、侧栏默认计数）的唯一来源。 */
  fullCatalogApps?: AppSummary[];
  /** 收藏 ID 集（任意大小写），供侧栏「收藏」角标的平台过滤计数。 */
  favoriteIds?: ReadonlySet<string>;
  /** 待收录条目（含归档），供侧栏「待收录」角标的平台过滤计数。 */
  pendingEntries?: readonly PendingCountEntry[];
}

/** 待收录计数所需的最小条目形状（与 `DraftEntry` 结构兼容）。 */
export interface PendingCountEntry {
  item: { platforms?: readonly string[] };
  archived: boolean;
}

/** 平台分布计数：侧栏 6 枚平台芯片下方的数字。 */
export type PlatformCounts = Record<PlatformId, number>;

/** 统计未归档且匹配当前平台筛选的待收录条目数。 */
export function selectPendingFilteredCount(
  entries: readonly PendingCountEntry[],
  selectedPlatforms: ReadonlySet<string>,
): number {
  let n = 0;
  for (const e of entries) {
    if (e.archived) continue;
    if (matchPlatformSet({ platforms: [...(e.item.platforms ?? [])] }, selectedPlatforms)) n++;
  }
  return n;
}

/** 已装应用的平台行：`id` 保持已装行原值，平台按「目录 → 水合卡片 → 安装方式兜底」解析。 */
export interface InstalledPlatformRow {
  id: string;
  platforms: string[];
}

/** 为每条已装应用解析平台列表，按「目录行 → 水合卡片 → 安装方式推断」回退。 */
export function resolveInstalledPlatformRows(
  installedApps: readonly InstalledApp[],
  appsById: ReadonlyMap<string, AppSummary>,
  hydratedById: ReadonlyMap<string, AppSummary>,
  hostPlatform: PlatformId,
): InstalledPlatformRow[] {
  return installedApps.map((inst) => {
    const key = normalizeId(inst.app_id);
    const catalogEntry = appsById.get(key);
    if (catalogEntry) return { id: inst.app_id, platforms: catalogEntry.platforms ?? [] };
    const card = hydratedById.get(key);
    if (card?.platforms && card.platforms.length > 0) return { id: inst.app_id, platforms: card.platforms };
    return { id: inst.app_id, platforms: inferInstalledFallbackPlatforms(inst.install_method, hostPlatform) };
  });
}

function buildInstalledRowLookup(rows: readonly InstalledPlatformRow[]): Map<string, InstalledPlatformRow> {
  const map = new Map<string, InstalledPlatformRow>();
  for (const r of rows) {
    const k = normalizeId(r.id);
    if (k && !map.has(k)) map.set(k, r);
  }
  return map;
}

/** 已装列表按平台行过滤（加载中行恒可见，落定后走 matchPlatformSet）。 */
export function selectPlatformFilteredInstalled(
  installedApps: readonly InstalledApp[],
  rows: readonly InstalledPlatformRow[],
  selectedPlatforms: ReadonlySet<string>,
  platformResolvedOtherIds: ReadonlySet<string>,
): InstalledApp[] {
  const byId = buildInstalledRowLookup(rows);
  return installedApps.filter((inst) => {
    const row = byId.get(normalizeId(inst.app_id));
    return !row || matchPlatformSetWithLoading(row, selectedPlatforms, platformResolvedOtherIds);
  });
}

/** 更新快照按对应已装应用的平台行过滤；无已装行的更新项不属于「我的应用」，一并排除。 */
export function selectPlatformFilteredUpdates(
  updates: readonly UpdateItem[],
  rows: readonly InstalledPlatformRow[],
  selectedPlatforms: ReadonlySet<string>,
  platformResolvedOtherIds: ReadonlySet<string>,
): UpdateItem[] {
  const byId = buildInstalledRowLookup(rows);
  return updates.filter((u) => {
    const row = byId.get(normalizeId(u.app_id));
    return Boolean(row) && matchPlatformSetWithLoading(row!, selectedPlatforms, platformResolvedOtherIds);
  });
}

/** 目录与补充行按 `normalizeId` 去重合并（目录行优先），不过平台过滤。 */
function mergeUniqueById(base: AppSummary[], extras: readonly AppSummary[]): AppSummary[] {
  if (extras.length === 0) return base;
  const seen = new Set<string>();
  for (const a of base) {
    const k = normalizeId(a.id);
    if (k) seen.add(k);
  }
  const out = [...base];
  for (const e of extras) {
    const k = normalizeId(e.id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.length === base.length ? base : out;
}

function selectPlatformFilteredApps(
  apps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  return apps.filter((a) => matchPlatformSetWithLoading(a, selectedPlatforms, platformResolvedOtherIds));
}

export function selectPlatformCounts(
  apps: readonly Pick<AppSummary, 'id' | 'platforms'>[],
  platformResolvedOtherIds: ReadonlySet<string>,
): Record<PlatformId, number> {
  const counts = {} as Record<PlatformId, number>;
  for (const id of PLATFORM_IDS) {
    counts[id] = 0;
  }
  const known = new Set<string>(PLATFORM_IDS as readonly string[]);
  for (const a of apps) {
    if (!a.platforms || a.platforms.length === 0) {
      // 加载中：暂不计入任何桶；已确认 other：仅计 other 桶
      if (isPlatformLoading(a, platformResolvedOtherIds)) continue;
      counts['other'] += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const p of a.platforms) {
      const n = normalizePlatform(p);
      if (known.has(n) && !seen.has(n)) {
        seen.add(n);
        counts[n as PlatformId] += 1;
      }
    }
  }
  return counts;
}

/** 按行别名键去重并合并多组应用的平台并集，供侧栏平台计数。 */
export function mergeAppsForPlatformCounts(
  baseApps: readonly AppSummary[],
  extraApps: readonly AppSummary[] = [],
): AppSummary[] {
  const aliasToIndex = new Map<string, number>();
  const out: AppSummary[] = [];

  const appendOrMerge = (app: AppSummary) => {
    const keys = rowAliasKeys(app);
    let existingIdx: number | undefined;
    for (const k of keys) {
      const hit = aliasToIndex.get(k);
      if (hit !== undefined) {
        existingIdx = hit;
        break;
      }
    }
    if (existingIdx === undefined) {
      const idx = out.length;
      out.push(app);
      for (const k of keys) aliasToIndex.set(k, idx);
      return;
    }
    for (const k of keys) {
      if (!aliasToIndex.has(k)) aliasToIndex.set(k, existingIdx);
    }
    const existing = out[existingIdx];
    const nextPlatforms = app.platforms ?? [];
    const existingPlatforms = existing.platforms ?? [];
    if (nextPlatforms.length === 0) {
      if (existingPlatforms.length === 0 && !existing.id.includes('/') && app.id.includes('/')) {
        out[existingIdx] = app;
      }
      return;
    }
    if (existingPlatforms.length === 0) {
      out[existingIdx] = app;
      return;
    }
    const seen = new Set(existingPlatforms.map(normalizePlatform));
    const additions = nextPlatforms.filter((p) => {
      const n = normalizePlatform(p);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    if (additions.length > 0) {
      out[existingIdx] = { ...existing, platforms: [...existingPlatforms, ...additions] };
    }
  };

  for (const a of baseApps) appendOrMerge(a);
  for (const a of extraApps) appendOrMerge(a);
  return out;
}

function buildAppsById(apps: AppSummary[]): Map<string, AppSummary> {
  const map = new Map<string, AppSummary>();
  for (const a of apps) {
    const key = normalizeId(a.id);
    if (!key) continue;
    if (!map.has(key)) map.set(key, a);
  }
  return map;
}

/** 构建包含原始 id 与 `normalizeId` 归一 id 的已安装集合。 */
export function buildInstalledIdSet(installedApps: InstalledApp[]): Set<string> {
  const set = new Set<string>();
  for (const a of installedApps) {
    set.add(a.app_id);
    const n = normalizeId(a.app_id);
    if (n) set.add(n);
  }
  return set;
}

/** 判断应用是否已纳入 ZStore 管理（大小写归一）。 */
export function isManaged(id: string, managedIds: Set<string>): boolean {
  if (!id || managedIds.size === 0) return false;
  if (managedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && managedIds.has(n)) return true;
  return false;
}

/** 判断应用是否已安装（原始键与 `normalizeId` 归一键均命中）。 */
export function isInstalled(id: string, installedIds: Set<string> | null | undefined): boolean {
  if (!id || !installedIds || installedIds.size === 0) return false;
  if (installedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && installedIds.has(n)) return true;
  return false;
}

/** 返回三态纳管状态：`null` 表示列表尚未加载完成，避免冷启闪烁。 */
export function selectManagedState(
  id: string,
  managedIds: Set<string> | null,
): boolean | null {
  if (managedIds === null) return null;
  return isManaged(id, managedIds);
}

/** 徽标三态（单测与文档口径，组件布尔 props 为其展开形态）。 */
type BadgeState = 'managed' | 'none' | 'unknown';

export function selectBadgeState(
  id: string,
  installedIds: Set<string> | null | undefined,
  managedIds: Set<string> | null,
): BadgeState {
  if (!id) return 'none';
  if (managedIds === null) return isInstalled(id, installedIds) ? 'unknown' : 'none';
  if (isManaged(id, managedIds)) return 'managed';
  return 'none';
}

/** 合并平台过滤后的收录段与未收录占位段（小写 id 去重）。 */
export function selectFavoritesViewApps(
  platformFilteredApps: AppSummary[],
  uncatalogedExtraApps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  if (uncatalogedExtraApps.length === 0) return platformFilteredApps;
  const filteredExtras = uncatalogedExtraApps.filter((a) =>
    matchPlatformSetWithLoading(a, selectedPlatforms, platformResolvedOtherIds),
  );
  if (filteredExtras.length === 0) return platformFilteredApps;
  const baseLower = new Set<string>();
  for (const a of platformFilteredApps) {
    const k = normalizeId(a.id);
    if (k) baseLower.add(k);
  }
  const deduped = filteredExtras.filter((e) => {
    const k = normalizeId(e.id);
    return k !== '' && !baseLower.has(k);
  });
  if (deduped.length === 0) return platformFilteredApps;
  return [...platformFilteredApps, ...deduped];
}

// ---------- 全局合并显示与本地收录标记 ----------

/** 自维护 overlay 开关默认值：开（关闭即隐藏全部 custom 行）。 */
const SHOW_CUSTOM_DEFAULT = true;

/** 带 source 标记的合并行（custom 标 source=custom，local 标 source=local，is_cataloged 恒 true）。 */
type MergedAppRow = AppSummary & {
  source?: string;
  is_cataloged?: boolean;
  status?: string;
};

/** 行身份（id / owner / repo 任一形态）：别名归一与本地命中判定的最小输入。 */
type RowIdentity = { id?: unknown; owner?: unknown; repo?: unknown; forge?: unknown };

/** 是否为自维护行（source=custom 即是；category external 原样保留，不参与判定）。 */
function isCustomAppRow(app: { source?: string }): boolean {
  return app.source === 'custom';
}

/** 是否为本地收录行（source=local 即是，已收录可搜可装，徽标走橘黄 local 变体）。 */
function isLocalAppRow(app: { source?: string }): boolean {
  return app.source === 'local';
}

/** 本地收录态判定（实现位于 `services/custom`）。 */
export { isCollectedStatus };

/** 判定状态是否属于本地库成员（已收录或已提交）。 */
export function isLocalLibraryStatus(status: unknown): boolean {
  return isCollectedStatus(status) || status === 'submitted';
}

/** 本地收录行打标（source=local，is_cataloged 恒 true；已盖章行原引用透传，不克隆）。 */
function markLocalSource<T extends AppSummary>(app: T): MergedAppRow {
  if (
    app.source === 'local' &&
    app.is_cataloged === true &&
    typeof app.status === 'string' &&
    app.status !== ''
  ) {
    return app;
  }
  return { ...app, source: 'local', is_cataloged: true };
}

/** 判定应用是否在各文本字段中匹配搜索词。 */
function appMatchesQuery(app: AppSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = (app.name || '').toLowerCase();
  const id = (app.id || '').toLowerCase();
  const owner = (app.owner || '').toLowerCase();
  const repo = (app.repo || '').toLowerCase();
  const desc = (app.description || '').toLowerCase();
  const descEn = (app.description_en || '').toLowerCase();
  const cat = (app.category || '').toLowerCase();
  const catName = (app.category_name || '').toLowerCase();
  const rawAliases = (app as { aliases?: unknown }).aliases;
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.map((a: unknown) => (typeof a === 'string' ? a.toLowerCase() : ''))
    : [];

  return (
    name.includes(q) ||
    id.includes(q) ||
    owner.includes(q) ||
    repo.includes(q) ||
    desc.includes(q) ||
    descEn.includes(q) ||
    cat === q ||
    catName === q ||
    aliases.some((a: string) => a.includes(q))
  );
}

/**
 * 合并远端目录与本地库补位行（远端优先去重），并为同仓远端行叠加本地标记。
 * 传入非空 `searchQuery` 时按词过滤补位行。
 */
export function selectMergedCatalogApps(
  remote: AppSummary[],
  custom: readonly unknown[],
  showCustom: boolean = SHOW_CUSTOM_DEFAULT,
  searchQuery?: string,
): AppSummary[] {
  if (!showCustom || custom.length === 0) return remote;
  const q = typeof searchQuery === 'string' ? searchQuery.trim().toLowerCase() : '';
  const isSearching = q.length > 0;
  const seen = new Set<string>();
  for (const r of remote) {
    const k = normalizeId(r.id);
    if (k) seen.add(k);
  }
  // 收录态 overlay 用别名集（大小写/owner/repo/前后缀漂移仍命中，如 openchamber 大小写变体）：
  // 去重语义不动（仍仅 id 归一去重），仅对远端已存在同仓行叠加 local 标记（蓝优先）。
  const collectedAliasStatus = new Map<string, unknown>();
  const collectedBases: Array<{ base: AppSummary; status: unknown }> = [];
  for (const c of custom) {
    if (!c || typeof c !== 'object') continue;
    let base: AppSummary | null = null;
    let status: unknown;
    let archived: unknown;
    if ('item' in (c as Record<string, unknown>) && (c as { item?: unknown }).item) {
      const entry = c as { item: DraftItem; status?: unknown; archived?: unknown };
      status = entry.status;
      archived = entry.archived;
      if (!isLocalLibraryStatus(status) || archived) continue;
      if (!entry.item || typeof entry.item.id !== 'string' || !entry.item.id) continue;
      base = itemToSummary(entry.item, status as DraftStatus);
    } else {
      const row = c as AppSummary & { status?: unknown; archived?: unknown };
      status = (row as { status?: unknown }).status;
      archived = (row as { archived?: unknown }).archived;
      if (!isLocalLibraryStatus(status) || archived) continue;
      if (!row.id) continue;
      // 扁平行已是摘要形态（App.tsx 侧经 customCatalogItemToSummary 转换后仍带 status），直接复用。
      base = row as AppSummary;
    }
    if (!base) continue;
    const wantStatus = typeof status === 'string' && status ? status : 'collected';
    for (const k of rowAliasKeys(base)) {
      if (!collectedAliasStatus.has(k)) collectedAliasStatus.set(k, wantStatus);
    }
    collectedBases.push({ base, status: wantStatus });
  }
  if (collectedBases.length === 0) return remote;
  let appended = false;
  const out: AppSummary[] = [...remote];
  for (const { base, status } of collectedBases) {
    if (isSearching && !appMatchesQuery(base, q)) {
      continue;
    }
    const k = normalizeId(base.id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    // 补位行携带库内状态（草稿已被上方过滤）：已盖章行保持原引用，摘要投影补 status。
    const withStatus =
      (base as { status?: unknown }).status === status
        ? base
        : ({ ...base, status } as AppSummary);
    out.push(markLocalSource(withStatus));
    appended = true;
  }
  // 远端已存在同仓行叠加 local（蓝优先：已验证不叠加；custom 草稿行不参与，此处仅 remote）：
  // 不改顺序/去重，仅搬标记供黄标判定；custom 就绪前后经引用变化重标（缺席透传 remote 本体）。
  let overlaid = false;
  const remoteCount = remote.length;
  for (let i = 0; i < remoteCount; i++) {
    const r = out[i];
    if (!r || r.is_verified === true) continue;
    if (isCustomAppRow(r) || isLocalAppRow(r)) continue;
    const keys = rowAliasKeys(r);
    let hitStatus: unknown;
    let hit = false;
    for (const k of keys) {
      if (collectedAliasStatus.has(k)) {
        hit = true;
        hitStatus = collectedAliasStatus.get(k);
        break;
      }
    }
    if (!hit) continue;
    const wantStatus = typeof hitStatus === 'string' && hitStatus ? hitStatus : 'collected';
    if (r.source === 'local' && r.status === wantStatus && r.is_cataloged === true) continue;
    out[i] = { ...r, source: 'local', status: wantStatus, is_cataloged: true };
    overlaid = true;
  }
  if (!appended && !overlaid) return remote;
  return out;
}

// ---------- 在线/趋势行 `is_cataloged` 显式标注 ----------

/** catalog id 集（含行别名归一，去空去重）。 */
export function buildCatalogIdSet(catalogApps: readonly AppSummary[]): Set<string> {
  const out = new Set<string>();
  for (const a of catalogApps) {
    if (!a) continue;
    for (const k of rowAliasKeys(a)) out.add(k);
  }
  return out;
}

/** 统一处理后端返回的最近浏览列表：应用清空遮罩并标注 `is_cataloged` 与本地标记。 */
export function prepareRecentViews(
  recents: readonly AppSummary[],
  fullCatalogApps: readonly AppSummary[] | undefined,
  fallbackCatalogApps: readonly AppSummary[],
  localApps: readonly AppSummary[] | undefined,
): AppSummary[] {
  const visible = filterMaskedRecentViews(recents);
  const baseCatalog = selectCatalogBase(fullCatalogApps, fallbackCatalogApps);
  const catalogIds = buildCatalogIdSet(baseCatalog);
  return visible.map((r) => healSummaryPlaceholders(annotateIsCataloged(r, catalogIds, localApps)));
}

/** 选取未裁剪全量目录，缺席时回退当前列表。 */
export function selectCatalogBase(
  fullCatalogApps: readonly AppSummary[] | undefined,
  apps: readonly AppSummary[],
): readonly AppSummary[] {
  return fullCatalogApps && fullCatalogApps.length > 0 ? fullCatalogApps : apps;
}

/** 别名命中集判断（id / GitHub owner-repo 归一，供 customIds / catalogIds 共用）。 */
export function hasIdAliasMatch(
  row: RowIdentity,
  idSet?: ReadonlySet<string>,
): boolean {
  if (!idSet || idSet.size === 0) return false;
  for (const k of rowAliasKeys(row)) {
    if (idSet.has(k)) return true;
  }
  return false;
}

/**
 * 为单行补齐 `is_cataloged` 与未验证本地收录的 `source='local'` 标记（无变更返回原引用）。
 * 后端投影为权威来源，此处用于乐观本地行与缺省字段载荷的展示补齐。
 */
export function annotateIsCataloged<T extends AppSummary>(
  row: T,
  catalogIds: ReadonlySet<string>,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): T {
  if (isCustomAppRow(row)) {
    return row.is_cataloged === true ? row : ({ ...row, is_cataloged: true } as T);
  }
  if (isLocalAppRow(row)) {
    // 给了本地 lookup 时以 lookup 为准（未命中即陈旧标注，落到下方按目录纠正）；
    // lookup 缺席（customApps 未加载）时信任后端盖章原样透传。
    if (localAppsOrIds === undefined || didHitLocal(row, localAppsOrIds).hit) {
      return row.is_cataloged === true ? row : ({ ...row, is_cataloged: true } as T);
    }
  }
  // 蓝标优先：已验证行不叠加本地标记（仍走蓝），仅显式 is_cataloged。
  const localHit = didHitLocal(row, localAppsOrIds);
  if (row.is_verified !== true && localHit.hit) {
    const wantStatus = localHit.status ?? 'collected';
    if (row.is_cataloged === true && row.source === 'local' && row.status === wantStatus) {
      return row;
    }
    return {
      ...row,
      source: 'local',
      status: wantStatus,
      is_cataloged: true,
    } as T;
  }
  const expected = hasIdAliasMatch(row, catalogIds);
  // 失效本地标注（本地收录已退回/删除等情形）：source/status 一并清掉，
  // 否则仅纠 is_cataloged 会让黄标判定继续读到残留 source。
  const staleLocalMark =
    row.source === 'local' || isCollectedStatus(row.status);
  if (!staleLocalMark) {
    if (typeof row.is_cataloged === 'boolean' && row.is_cataloged === expected) return row;
    return { ...row, is_cataloged: expected } as T;
  }
  return {
    ...row,
    is_cataloged: expected,
    source: expected ? 'remote' : undefined,
    status: undefined,
  } as T;
}

/**
 * 按当前本地收录集合重标历史行（`undefined` 表示未加载，原样透传；无变化返回原引用）。
 */
export function restampLocalMarks<T extends AppSummary>(
  rows: T[],
  catalogIds: ReadonlySet<string>,
  localApps?: readonly AppSummary[] | ReadonlySet<string>,
): T[] {
  if (!localApps || rows.length === 0) return rows;
  let changed = false;
  const next = rows.map((row) => {
    const n = annotateIsCataloged(row, catalogIds, localApps);
    if (n !== row) changed = true;
    return n;
  });
  return changed ? next : rows;
}

/** 返回规范化的行别名键；非 GitHub forge 仅保留自身 canonical id。 */
export function rowAliasKeys(row: RowIdentity): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string): void => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  const idKey = normalizeId(row?.id);
  if (idKey) {
    push(idKey);
  }
  const forgeRaw = typeof row?.forge === 'string' ? row.forge.trim().toLowerCase() : '';
  const isNonGithubForge =
    (idKey.includes(':') && !idKey.startsWith('github:')) ||
    (forgeRaw !== '' && forgeRaw !== 'github');
  if (!isNonGithubForge) {
    const raw = String(row?.id ?? '').trim().toLowerCase();
    if (raw.startsWith('github.com/')) {
      const segs = raw.slice('github.com/'.length).split('/').filter(Boolean);
      if (segs.length === 2) {
        const shortKey = normalizeId(`${segs[0]}/${segs[1]}`);
        if (shortKey) push(shortKey);
      }
    }
    if (typeof row?.owner === 'string' && typeof row?.repo === 'string') {
      const coord = normalizeId(`${row.owner.trim()}/${row.repo.trim()}`);
      if (coord && coord !== '/') push(coord);
    }
  }
  return out;
}

/** 本地命中判定（含 status 搬运；Set 口径无 status 时回落 'collected'；数组口径仅认 source=local/status collected 系）。 */
function didHitLocal(
  row: RowIdentity,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): { hit: boolean; status?: unknown } {
  if (!localAppsOrIds) return { hit: false };
  const rowKeys = rowAliasKeys(row);
  if (rowKeys.length === 0) return { hit: false };
  const rowKeySet = new Set(rowKeys);
  if (localAppsOrIds instanceof Set) {
    // Set 口径经行别名归一展开后求交（大小写/前后缀漂移仍命中，口径与数组侧一致）。
    const expanded = new Set<string>();
    for (const raw of localAppsOrIds as ReadonlySet<string>) {
      if (typeof raw !== 'string') continue;
      for (const k of rowAliasKeys({ id: raw })) expanded.add(k);
    }
    for (const k of rowKeySet) {
      if (expanded.has(k)) return { hit: true, status: 'collected' };
    }
    return { hit: false };
  }
  const statusByAlias = new Map<string, unknown>();
  for (const l of localAppsOrIds) {
    if (!l || typeof (l as AppSummary).id !== 'string') continue;
    const src = (l as { source?: unknown }).source;
    const st = (l as { status?: unknown }).status;
    const isLocalRow = src === 'local' || isLocalLibraryStatus(st);
    if (!isLocalRow) continue;
    const keys = rowAliasKeys(l as AppSummary);
    const wantStatus = typeof st === 'string' && st ? st : 'collected';
    for (const k of keys) {
      if (!statusByAlias.has(k)) statusByAlias.set(k, wantStatus);
    }
  }
  for (const k of rowKeySet) {
    if (statusByAlias.has(k)) return { hit: true, status: statusByAlias.get(k) };
  }
  return { hit: false };
}

/** 从目录数组中提取本地收录行（source=local）供在线叠加，不改排序/去重语义。 */
function collectLocalFromCatalog(catalogApps: readonly AppSummary[]): AppSummary[] {
  const out: AppSummary[] = [];
  for (const c of catalogApps) {
    if (!c) continue;
    if ((c as { source?: unknown }).source === 'local') out.push(c);
  }
  return out;
}

/** 合并显式本地（数组或 Set 口径）与目录自带本地行，统一为数组 lookup（不改排序/去重）。 */
export function mergeLocalLookups(
  inferred: AppSummary[],
  explicit?: readonly AppSummary[] | ReadonlySet<string>,
): AppSummary[] | undefined {
  const out: AppSummary[] = [...inferred];
  if (explicit) {
    if (explicit instanceof Set) {
      for (const id of explicit) {
        const k = normalizeId(id);
        if (!k) continue;
        out.push({ id: k, status: 'collected' } as unknown as AppSummary);
      }
    } else {
      const arr = explicit as readonly AppSummary[];
      if (arr.length > 0) out.push(...arr);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 目录自带本地行 + 显式本地统一为数组 lookup（在线/enrich 双处共用，不改排序/去重）。 */
function resolveLocalLookup(
  catalogAppsOrIds: readonly AppSummary[] | ReadonlySet<string>,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): AppSummary[] | undefined {
  const inferred =
    catalogAppsOrIds instanceof Set ? [] : collectLocalFromCatalog(catalogAppsOrIds as readonly AppSummary[]);
  return mergeLocalLookups(inferred, localAppsOrIds);
}

/** 为在线列表标注 `is_cataloged` 与未验证本地收录的 `source='local'` 标记。 */
export function annotateOnlineCataloged<T extends AppSummary>(
  onlineApps: readonly T[],
  catalogAppsOrIds: readonly AppSummary[] | ReadonlySet<string>,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): T[] {
  if (onlineApps.length === 0) return onlineApps as T[];
  const catalogIds =
    catalogAppsOrIds instanceof Set
      ? catalogAppsOrIds
      : buildCatalogIdSet(catalogAppsOrIds as readonly AppSummary[]);
  // 目录自带本地行与显式本地统一为 lookup（不改排序/去重，仅搬标记供 badge 判定）。
  const localLookup = resolveLocalLookup(catalogAppsOrIds, localAppsOrIds);
  let changed = false;
  const out = onlineApps.map((r) => {
    const next = annotateIsCataloged(r, catalogIds, localLookup);
    if (next !== (r as T)) changed = true;
    return next;
  });
  return changed ? out : (onlineApps as T[]);
}

/** 为趋势富卡镜像记录标注 `is_cataloged` 与本地标记，无变更返回原引用。 */
export function annotateEnrichMirrorCataloged(
  mirror: Record<string, AppSummary>,
  catalogAppsOrIds: readonly AppSummary[] | ReadonlySet<string>,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): Record<string, AppSummary> {
  const keys = Object.keys(mirror);
  if (keys.length === 0) return mirror;
  const catalogIds =
    catalogAppsOrIds instanceof Set
      ? catalogAppsOrIds
      : buildCatalogIdSet(catalogAppsOrIds as readonly AppSummary[]);
  const localLookup = resolveLocalLookup(catalogAppsOrIds, localAppsOrIds);
  let changed = false;
  const next: Record<string, AppSummary> = { ...mirror };
  for (const k of keys) {
    const cur = mirror[k];
    if (!cur) continue;
    const annotated = annotateIsCataloged(cur, catalogIds, localLookup);
    if (annotated !== cur) {
      next[k] = annotated;
      changed = true;
    }
  }
  return changed ? next : mirror;
}

/** 为命中本地收录且未验证的行补齐 `source='local'` 与 `is_cataloged=true`。 */
export function annotateLocalSource<T extends AppSummary>(
  row: T,
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): T {
  if (row.is_verified === true || isCustomAppRow(row)) return row;
  if (isLocalAppRow(row)) {
    return row.is_cataloged === true ? row : ({ ...row, is_cataloged: true } as T);
  }
  const hit = didHitLocal(row, localAppsOrIds);
  if (!hit.hit) return row;
  const wantStatus = hit.status ?? 'collected';
  if (row.is_cataloged === true && row.status === wantStatus) return row;
  return { ...row, source: 'local', status: wantStatus, is_cataloged: true } as T;
}

/** 判定裸行（未认证且命中本地收录）是否显示本地收录徽标。 */
export function resolveBareRowLocalBadgeVariant(
  row: RowIdentity & { is_verified?: boolean },
  localAppsOrIds?: readonly AppSummary[] | ReadonlySet<string>,
): 'local' | null {
  if (row.is_verified === true) return null;
  return didHitLocal(row, localAppsOrIds).hit ? 'local' : null;
}

export function useAppSelectors({
  apps,
  onlineApps,
  isOnlineResults = false,
  uncatalogedExtraApps,
  selectedPlatforms,
  platformResolvedOtherIds,
  selectedApp,
  recentlyViewedApps,
  currentView,
  stagedDeepLinkInstall,
  customApps = [],
  showCustom = SHOW_CUSTOM_DEFAULT,
  searchQuery,
  fullCatalogApps,
  favoriteIds,
  pendingEntries,
}: UseAppSelectorsParams) {
  const trimmedQuery = typeof searchQuery === 'string' ? searchQuery.trim() : '';

  // 全量目录链（全站权威基线）：不传 searchQuery，本地库行全部补位。
  const catalogBase = selectCatalogBase(fullCatalogApps, apps) as AppSummary[];
  const fullMergedCatalogApps = useMemo(
    () => selectMergedCatalogApps(catalogBase, customApps, showCustom),
    [catalogBase, customApps, showCustom],
  );
  // 精选/最新/分类/趋势/我的应用消费；加载中行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
  const catalogPlatformFilteredApps = useMemo(
    () => selectPlatformFilteredApps(fullMergedCatalogApps, selectedPlatforms, platformResolvedOtherIds),
    [fullMergedCatalogApps, selectedPlatforms, platformResolvedOtherIds],
  );

  // 搜索链：顶栏搜索命中 + 按词过滤的本地库行，仅 SearchResultsView 与 home 搜索空态判断消费。
  const searchMergedApps = useMemo(
    () => selectMergedCatalogApps(apps, customApps, showCustom, searchQuery),
    [apps, customApps, showCustom, searchQuery],
  );
  const searchPlatformFilteredApps = useMemo(
    () => selectPlatformFilteredApps(searchMergedApps, selectedPlatforms, platformResolvedOtherIds),
    [searchMergedApps, selectedPlatforms, platformResolvedOtherIds],
  );

  // 搜索在线段同口径平台过滤：与本地段一致，加载中恒可见，落定后走正常过滤。
  // 在线落定处按全量合并目录显式标注 is_cataloged（含本地，蓝优先：自身已验证不叠加），
  // 已收录在线仍正确隐藏按钮，未收录 dev 猜分类正确显示。
  const annotatedOnlineApps = useMemo(
    () => annotateOnlineCataloged(onlineApps, fullMergedCatalogApps, customApps),
    [onlineApps, fullMergedCatalogApps, customApps],
  );
  const platformFilteredOnlineApps = useMemo(
    () => selectPlatformFilteredApps(annotatedOnlineApps, selectedPlatforms, platformResolvedOtherIds),
    [annotatedOnlineApps, selectedPlatforms, platformResolvedOtherIds]
  );
  const platformFilteredRecentApps = useMemo(
    () => selectPlatformFilteredApps(recentlyViewedApps, selectedPlatforms, platformResolvedOtherIds),
    [recentlyViewedApps, selectedPlatforms, platformResolvedOtherIds],
  );

  // 收藏/关注池：全量目录 ∪ 未收录占位行（normalizeId 去重，不过平台），供收藏页平台分布与空态判定。
  const allFavoritesPoolApps = useMemo(
    () => mergeUniqueById(fullMergedCatalogApps, uncatalogedExtraApps),
    [fullMergedCatalogApps, uncatalogedExtraApps],
  );
  // 收藏页 left-join 供给：全量目录链（已平台过滤）+ 未收录占位段（同口径平台过滤后并入，小写去重）。
  const favoritesViewApps = useMemo(
    () => selectFavoritesViewApps(catalogPlatformFilteredApps, uncatalogedExtraApps, selectedPlatforms, platformResolvedOtherIds),
    [catalogPlatformFilteredApps, uncatalogedExtraApps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 侧栏「收藏」角标：平台过滤后命中收藏集的去重条数（不受页内搜索词影响）。
  const platformFilteredFavoriteCount = useMemo(() => {
    if (!favoriteIds || favoriteIds.size === 0) return 0;
    const wanted = new Set<string>();
    for (const id of favoriteIds) {
      const k = normalizeId(id);
      if (k) wanted.add(k);
    }
    const hit = new Set<string>();
    for (const a of favoritesViewApps) {
      const k = normalizeId(a.id);
      if (wanted.has(k)) hit.add(k);
    }
    return hit.size;
  }, [favoriteIds, favoritesViewApps]);
  // 侧栏「待收录」角标：未归档条目按平台过滤计数。
  const pendingFilteredCount = useMemo(
    () => selectPendingFilteredCount(pendingEntries ?? [], selectedPlatforms),
    [pendingEntries, selectedPlatforms],
  );

  // 全库平台分布（侧栏默认口径）：基于全量合并目录（含本地库补位行），顶栏搜索词不缩小它。
  // 已确认 other 才计入 other 桶，加载中行暂不计数，大小写归一，同应用去重后各桶 +1。
  const platformCounts = useMemo(
    () => selectPlatformCounts(fullMergedCatalogApps, platformResolvedOtherIds),
    [fullMergedCatalogApps, platformResolvedOtherIds]
  );

  // home 搜索态：本地搜索命中（有在线结果时 ∪ 在线结果，按行别名去重）的分布；非 home 搜索态为 null。
  const isHomeSearch = currentView === 'home' && trimmedQuery.length > 0;
  const hasActiveOnlineSearch = isHomeSearch && isOnlineResults && annotatedOnlineApps.length > 0;
  const searchPlatformCounts = useMemo(() => {
    if (!isHomeSearch) return null;
    return selectPlatformCounts(
      hasActiveOnlineSearch
        ? mergeAppsForPlatformCounts(searchMergedApps, annotatedOnlineApps)
        : searchMergedApps,
      platformResolvedOtherIds,
    );
  }, [isHomeSearch, hasActiveOnlineSearch, searchMergedApps, annotatedOnlineApps, platformResolvedOtherIds]);

  // 目录 id（小写）→ AppSummary 索引，供已安装/更新列表 O(1) 查表，避免每行 apps.find 全扫
  const appsById = useMemo(() => buildAppsById(fullMergedCatalogApps), [fullMergedCatalogApps]);

  // 深链安装确认弹窗：呈现应用名称、仓库/来源以及 SHA-256（优先使用已加载详情，兜底使用列表快照）。
  const stagedDeepLinkDetail =
    stagedDeepLinkInstall !== null &&
    selectedApp !== null &&
    normalizeId(selectedApp.id) === normalizeId(stagedDeepLinkInstall) &&
    !selectedApp.isLoading
      ? selectedApp
      : null;
  const stagedDeepLinkSummary =
    stagedDeepLinkDetail ??
    (stagedDeepLinkInstall !== null
      ? appsById.get(normalizeId(stagedDeepLinkInstall)) ??
        recentlyViewedApps.find((a) => normalizeId(a.id) === normalizeId(stagedDeepLinkInstall)) ??
        null
      : null);
  const stagedDeepLinkSha256 = stagedDeepLinkDetail?.releases.find((r) => r.sha256)?.sha256;

  return {
    fullMergedCatalogApps,
    catalogPlatformFilteredApps,
    searchPlatformFilteredApps,
    platformFilteredOnlineApps,
    platformFilteredRecentApps,
    allFavoritesPoolApps,
    favoritesViewApps,
    platformFilteredFavoriteCount,
    pendingFilteredCount,
    platformCounts,
    searchPlatformCounts,
    appsById,
    showCustom,
    stagedDeepLinkDetail,
    stagedDeepLinkSummary,
    stagedDeepLinkSha256,
  };
}

/** 列表项是否命中查询（名称 / owner / repo / 分类）。 */
export function matchesAppText(app: AppSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    app.name.toLowerCase().includes(q) ||
    app.owner.toLowerCase().includes(q) ||
    app.repo.toLowerCase().includes(q) ||
    app.category_name.toLowerCase().includes(q)
  );
}
