import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppDetailViewModel,
  AppSummary,
  InstalledApp,
  UpdateItem,
  ViewType,
} from '../types';
import {
  PLATFORM_IDS,
  isPlatformLoading,
  matchPlatformSetWithLoading,
  normalizePlatform,
  type PlatformId,
} from '../lib/platformFilter';
import { normalizeId } from '../services/normalizeId';
// loading 语义唯一深模块为 `lib/platformFilter`：本选择器直接消费 lib，
// 对外仅保留 LOADING_SETTLE_MS/isEnrichedRowLoading/unionConfirmedSets 三件重导出。
export {
  LOADING_SETTLE_MS,
  isEnrichedRowLoading,
  unionConfirmedSets,
} from '../lib/platformFilter';

interface UseAppSelectorsParams {
  apps: AppSummary[];
  onlineApps: AppSummary[];
  favoriteExtraApps: AppSummary[];
  installedApps: InstalledApp[];
  updates: UpdateItem[];
  selectedPlatforms: Set<PlatformId>;
  setSelectedPlatforms: React.Dispatch<React.SetStateAction<Set<PlatformId>>>;
  platformResolvedOtherIds: Set<string>;
  selectedApp: AppDetailViewModel | null;
  recentlyViewedApps: AppSummary[];
  currentView: ViewType;
  stagedDeepLinkInstall: string | null;
  /**
   * 自维护 overlay 可选项（ADR-0017）：未归档 custom 列表 + showCustom 开关（默认开）。
   * 缺席即无 overlay，直接返回 remote 本体。
   */
  customApps?: AppSummary[];
  showCustom?: boolean;
}

/**
 * 派生选择器。
 *
 * - 平台优先派生（加载中恒可见，落定后走 matchPlatformSet）；
 * - 侧栏计数基于全量 `apps`（已确认 other 才计 other 桶，加载中不计数）；
 * - 收藏页 left-join 供给（收录段 + 未收录占位段，小写去重）；
 * - 已安装/更新列表经 `appsById` O(1) 查表，未收录行保持可见；
 * - 深链确认弹窗的详情/摘要/SHA-256 解析。
 */

function selectPlatformFilteredApps(
  apps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  return apps.filter((a) => matchPlatformSetWithLoading(a, selectedPlatforms, platformResolvedOtherIds));
}

function selectPlatformCounts(
  apps: AppSummary[],
  platformResolvedOtherIds: Set<string>,
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

function buildAppsById(apps: AppSummary[]): Map<string, AppSummary> {
  const map = new Map<string, AppSummary>();
  for (const a of apps) {
    const key = normalizeId(a.id);
    if (!key) continue;
    if (!map.has(key)) map.set(key, a);
  }
  return map;
}

function buildInstalledIds(installedApps: InstalledApp[]): Set<string> {
  const set = new Set<string>();
  for (const a of installedApps) {
    set.add(a.app_id);
    const n = normalizeId(a.app_id);
    if (n) set.add(n);
  }
  return set;
}

function buildManagedIds(installedApps: InstalledApp[]): Set<string> {
  const set = new Set<string>();
  for (const a of installedApps) {
    set.add(a.app_id);
    const n = normalizeId(a.app_id);
    if (n) set.add(n);
  }
  return set;
}

/**
 * 已纳管判定：组件统一经此判态，消灭发现页误报“已安装”。
 * - isManaged：已纳入 ZStore 管理（绿色已安装，来源 installedApps）。
 * 大小写归一经 `normalizeId` 单口；raw 直命中优先，归一兜底。
 */
export function isManaged(id: string, managedIds: Set<string>): boolean {
  if (!id || managedIds.size === 0) return false;
  if (managedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && managedIds.has(n)) return true;
  return false;
}

/**
 * 已安装（已纳管）归一判定：调用方禁止再手写 `installedIds.has(id)` raw 直查
 * （大小写变体 ID 下与 managed 判态分叉）。raw 直命中优先，归一兜底；
 * 集合缺席（null/undefined）即未安装。
 */
export function isInstalled(id: string, installedIds: Set<string> | null | undefined): boolean {
  if (!id || !installedIds || installedIds.size === 0) return false;
  if (installedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && installedIds.has(n)) return true;
  return false;
}

/**
 * managed 三态（冷启闪烁守卫）：`null` = managed 列表尚未加载（未知），
 * `Set<string>` = 已知集合。未知态调用方渲染中性占位。
 */
export function selectIsManagedOpt(
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

/**
 * 收藏页 left-join 合并器：
 * 收录段（已平台过滤）+ 未收录占位段（同口径平台过滤后并入，小写去重防双显）。
 */
export function selectFavoritesViewApps(
  platformFilteredApps: AppSummary[],
  favoriteExtraApps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  if (favoriteExtraApps.length === 0) return platformFilteredApps;
  const filteredExtras = favoriteExtraApps.filter((a) =>
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

// ---------- 全局合并显示 + showCustom 开关 + 转正提示（ADR-0017 自维护 overlay） ----------

/** 自维护 overlay 开关默认值：开（关闭即隐藏全部 custom 行）。 */
const SHOW_CUSTOM_DEFAULT = true;

/** 带 source 标记的合并行（custom 标 source=custom，local 标 source=local，is_cataloged 恒 true）。 */
type MergedAppRow = AppSummary & {
  source?: string;
  is_cataloged?: boolean;
  status?: string;
};

/** 行身份（id / owner / repo 任一形态）：别名归一与本地命中判定的最小输入。 */
type RowIdentity = { id?: unknown; owner?: unknown; repo?: unknown };

/** 是否为自维护行（source=custom 即是；category external 原样保留，不参与判定）。 */
function isCustomAppRow(app: { source?: string }): boolean {
  return app.source === 'custom';
}

/** 是否为本地收录行（source=local 即是，已收录可搜可装，徽标走橘黄 local 变体）。 */
function isLocalAppRow(app: { source?: string }): boolean {
  return app.source === 'local';
}

/** 本地收录态判定（overlay/PR 门禁唯一口径，`collected` 与磁盘残留 `local_collected` 同义；归档与否由调用方另判）。 */
export function isCollectedStatus(status: unknown): boolean {
  return status === 'collected' || status === 'local_collected';
}

/** 本地收录行打标（source=local，is_cataloged 恒 true；已盖章行原引用透传，不再克隆）。 */
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

/** 草稿 payload 转收录行摘要（default_version 落 latest_version，forge 补 github）。 */
function customItemToSummary(item: {
  id: string;
  name?: unknown;
  owner?: unknown;
  repo?: unknown;
  icon?: unknown;
  icon_bg?: unknown;
  description?: unknown;
  description_en?: unknown;
  category?: unknown;
  category_name?: unknown;
  default_version?: unknown;
  latest_version?: unknown;
  license?: unknown;
  stars?: unknown;
  forks?: unknown;
  homepage?: unknown;
  platforms?: unknown;
}): AppSummary {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const platforms = Array.isArray(item.platforms)
    ? (item.platforms as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const homepage = typeof item.homepage === 'string' ? item.homepage : null;
  return {
    id: str(item.id),
    name: str(item.name),
    description_en: typeof item.description_en === 'string' ? item.description_en : undefined,
    owner: str(item.owner),
    repo: str(item.repo),
    icon: str(item.icon),
    icon_bg: str(item.icon_bg, 'linear-gradient(135deg, #475569, #334155)'),
    description: str(item.description),
    stars: num(item.stars),
    forks: num(item.forks),
    license: str(item.license),
    latest_version: str(item.default_version ?? item.latest_version, 'v0.1.0'),
    category: str(item.category, 'dev'),
    category_name: str(item.category_name ?? item.category, 'dev'),
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage,
    platforms: [...platforms],
  };
}

/**
 * 全局合并（远端优先去重，仅收录态补位）：
 * - remote 在前，collected 在后；同 id（归一）取远端行；
 * - showCustom=false 即返回 remote 本体（引用透传，调用方可 memo 命中）；
 * - 仅合 status 为 collected 系且未归档的行（draft/submitted/已归档一律跳过），
 *   补位行经 markLocalSource 打标（source=local，is_cataloged 恒 true）；
 * - 支持 CustomAppEntry（{item,status,archived}）与扁平行（含 status/archived）两种形态；
 *   无 status 的旧行视为未收录直接跳过。
 * Home/分类/搜索三处共用同一口（调用方先合并再平台过滤）。
 */
export function selectMergedCatalogApps(
  remote: AppSummary[],
  custom: readonly unknown[],
  showCustom: boolean = SHOW_CUSTOM_DEFAULT,
): AppSummary[] {
  if (!showCustom || custom.length === 0) return remote;
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
      const entry = c as { item: Parameters<typeof customItemToSummary>[0]; status?: unknown; archived?: unknown };
      status = entry.status;
      archived = entry.archived;
      if (!isCollectedStatus(status) || archived) continue;
      if (!entry.item || typeof entry.item.id !== 'string' || !entry.item.id) continue;
      base = customItemToSummary(entry.item);
    } else {
      const row = c as AppSummary & { status?: unknown; archived?: unknown };
      status = (row as { status?: unknown }).status;
      archived = (row as { archived?: unknown }).archived;
      if (!isCollectedStatus(status) || archived) continue;
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
  for (const { base } of collectedBases) {
    const k = normalizeId(base.id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(markLocalSource(base));
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

// ---------- 在线/趋势 enrich 显式 is_cataloged 标注 ----------
// 后端 AppSummary 无 is_cataloged（models.rs），在线/富卡 category 为
// guess_category 猜的真实分类（http.rs 默认 dev），需按 catalog id 集显式标注才不误判已收录。
// 此处按 catalog id 集（canonical 小写，复用 normalizeId）显式标注，显式标记优先于兜底。

/** catalog id 集（canonical 小写归一，去空去重）。 */
export function buildCatalogIdSet(catalogApps: readonly AppSummary[]): Set<string> {
  const out = new Set<string>();
  for (const a of catalogApps) {
    const k = normalizeId(a?.id);
    if (k) out.add(k);
  }
  return out;
}

/** 单 id 是否命中收录（canonical 小写比对）。 */
function isCatalogedId(id: unknown, catalogIds: ReadonlySet<string>): boolean {
  const k = normalizeId(id);
  return k !== '' && catalogIds.has(k);
}

/**
 * 单行显式标注（不改原对象）：
 * - source=custom 草稿行与 source=local 收录行恒 true（不被 catalog 集覆盖，
 *   不碰 is_verified，草稿/本地收录均不配已认证蓝标，本地收录配橘黄 local 变体）；
 * - 其余按 catalog 集命中/未命中显式携带以优先于 category 兜底；
 * - 本地收录叠加：同 id 命中本地收录且自身未验证（is_verified !== true）时补
 *   source='local'（蓝标优先不动；远端已验证仍蓝，仅远端缺席/未验证才显黄），
 *   status 一并搬运供 badge 兜底判定；
 * - 已有正确值即原引用透传（memo 友好）。
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
  const expected = isCatalogedId(row.id, catalogIds);
  // 陈旧本地标注（本地收录已退回/删除、或后端旧投影）：source/status 一并清掉，
  // 否则仅纠 is_cataloged 会让黄标判定继续读到旧 source。
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

/** 行别名键（id 归一 + owner/repo 归一 + id 末两段归一）：大小写/前后缀漂移仍命中同一仓库。 */
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
    const raw = String(row?.id ?? '').trim();
    const afterColon = raw.includes(':') ? (raw.split(':').pop() ?? raw) : raw;
    const segs = afterColon.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      const shortKey = normalizeId(`${segs[segs.length - 2]}/${segs[segs.length - 1]}`);
      if (shortKey) push(shortKey);
    }
  }
  if (typeof row?.owner === 'string' && typeof row?.repo === 'string') {
    const coord = normalizeId(`${row.owner.trim()}/${row.repo.trim()}`);
    if (coord && coord !== '/') push(coord);
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
    const isLocalRow = src === 'local' || isCollectedStatus(st);
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

/**
 * 在线段标注（online 落定处调用）：
 * 命中 catalog 即 true（已收录，在线结果仍正确隐藏按钮），未命中即 false；
 * 同 id 命中本地收录时叠加 source='local'/status（蓝标优先：自身已验证不叠加）。
 */
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

/**
 * 趋势 enrich 镜像标注（enrich 合并处调用，Record 口径）：
 * 同上，未命中=false，命中=true；key 与 app.id 双通道归一（防别名漂移）；
 * 本地收录同 id 叠加 source/status（蓝优先）。
 */
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

/**
 * 本地收录标记搬运（不改收录判定）：
 * 命中本地收录即补 `source='local'` + `status` + `is_cataloged=true`，未命中原引用透传。
 * 蓝优先：已验证行不叠加；`source=custom` 草稿行原样保留；已是本地行仅补显式收录位。
 */
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

/**
 * 裸行（enrich 富卡缺席的占位小行）本地收录徽标判定：
 * 身份按 `rowAliasKeys` 归一对齐（大小写 / owner-repo 漂移仍命中），
 * 已认证行由自身蓝标承担（此处不返回橘黄），命中本地收录即 'local'，否则 null。
 */
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
  favoriteExtraApps,
  installedApps,
  updates,
  selectedPlatforms,
  setSelectedPlatforms,
  platformResolvedOtherIds,
  selectedApp,
  recentlyViewedApps,
  currentView,
  stagedDeepLinkInstall,
  customApps = [],
  showCustom = SHOW_CUSTOM_DEFAULT,
}: UseAppSelectorsParams) {
  // 自维护 overlay：custom 未归档叠加到 Home/分类/搜索（远端优先去重，custom 标 source=custom）。
  // 缺省（customApps=[]/showCustom=true）即原数组透传。
  const mergedApps = useMemo(
    () => selectMergedCatalogApps(apps, customApps, showCustom),
    [apps, customApps, showCustom],
  );
  // 任务 3：以平台优先派生数据供给 精选/趋势/分类 视图（使用同名 apps 属性）。
  // 加载中行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
  const platformFilteredApps = useMemo(
    () => selectPlatformFilteredApps(mergedApps, selectedPlatforms, platformResolvedOtherIds),
    [mergedApps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 搜索在线段同口径平台过滤：与本地段一致，加载中恒可见，落定后走正常过滤。
  // 在线落定处显式标注 is_cataloged（catalog id 集 canonical 比对），
  // 显式标记优先于 category 兜底；已收录在线仍正确隐藏按钮，未收录 dev 猜分类正确显示。
  // 本地收录橘黄链路：目录用合并后全量（含本地，远端优先去重语义不动），在线同 id 命中本地
  // 叠加 source='local'/status（蓝优先：自身已验证不叠加），供 badge 判定。
  const annotatedOnlineApps = useMemo(
    () => annotateOnlineCataloged(onlineApps, mergedApps, customApps),
    [onlineApps, mergedApps, customApps],
  );
  const platformFilteredOnlineApps = useMemo(
    () => selectPlatformFilteredApps(annotatedOnlineApps, selectedPlatforms, platformResolvedOtherIds),
    [annotatedOnlineApps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 收藏页 left-join 供给：收录段（已平台过滤）+ 未收录占位段（收藏/关注 union 合成，同口径平台过滤后并入，
  // 小写去重防双显）。其它视图仍用 `platformFilteredApps`，计数仍基于全量 `apps`。
  const favoritesViewApps = useMemo(
    () => selectFavoritesViewApps(platformFilteredApps, favoriteExtraApps, selectedPlatforms, platformResolvedOtherIds),
    [platformFilteredApps, favoriteExtraApps, selectedPlatforms, platformResolvedOtherIds]
  );

  // 任务 4（设备平台全局过滤）：侧栏分组的各平台应用计数，
  // 基于全量 `apps` 数组（而非已过滤数组）计算，以便准确呈现“有多少应用支持该设备”。
  // 一次扫完 6 项：已确认 other 才计入虚拟 other 桶，加载中行暂不计数（缺席沿用收录库口径，
  // 落定后单次更新），大小写归一，同应用去重后各桶 +1（与 6×filter 语义一致）。
  // 计数基于合并后全量（含 custom 补位行）。
  const platformCounts = useMemo(
    () => selectPlatformCounts(mergedApps, platformResolvedOtherIds),
    [mergedApps, platformResolvedOtherIds]
  );

  // 目录 id（小写）→ AppSummary 索引，供已安装/更新列表 O(1) 查表，避免每行 apps.find 全扫
  const appsById = useMemo(() => buildAppsById(mergedApps), [mergedApps]);

  const filteredInstalledApps = useMemo(() => {
    return installedApps.filter((inst) => {
      const catalogEntry = appsById.get(normalizeId(inst.app_id));
      return !catalogEntry || matchPlatformSetWithLoading(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
    });
  }, [installedApps, appsById, selectedPlatforms, platformResolvedOtherIds]);

  const filteredUpdates = useMemo(() => {
    return updates.filter((u) => {
      const catalogEntry = appsById.get(normalizeId(u.app_id));
      return !catalogEntry || matchPlatformSetWithLoading(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
    });
  }, [updates, appsById, selectedPlatforms, platformResolvedOtherIds]);

  const handleResetPlatformFilter = useCallback(() => {
    setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS));
  }, [setSelectedPlatforms]);

  // 趋势榜单平台分布（TrendsView 上报其榜单行口径）：趋势页侧栏计数切到该口径，
  // 其余页面沿用收录库口径。null = 尚未上报（沿用收录库，避免闪 0）。
  const [trendsPlatformCounts, setTrendsPlatformCounts] = useState<Record<PlatformId, number> | null>(null);
  const handleTrendsPlatformCounts = useCallback((counts: Record<PlatformId, number>) => {
    setTrendsPlatformCounts(counts);
  }, []);
  const sidebarPlatformCounts = currentView === 'trends' && trendsPlatformCounts ? trendsPlatformCounts : platformCounts;

  const installedIds = useMemo(() => buildInstalledIds(installedApps), [installedApps]);

  const managedIds = useMemo(() => buildManagedIds(installedApps), [installedApps]);

  // managed 加载三态（冷启闪烁守卫）：`installedApps` 初始 `[]`
  // 与“已加载但为空”引用不同（订阅层 `.then(setInstalledApps)` 恒产生新引用，
  // IPC 反序列化无复用），引用变化即 managed 已加载；其它重渲染引用不变即仍未知。
  // 加载失败无写入时 installed 为空恒走 'none'（全 Get），故失败态自然降级；8s 超时兜底
  // 防占位永久悬挂（此时已安装命中才占位）。
  const initialInstalledRef = useRef(installedApps);
  const [managedLoaded, setManagedLoaded] = useState(false);
  useEffect(() => {
    if (installedApps !== initialInstalledRef.current) setManagedLoaded(true);
  }, [installedApps]);
  useEffect(() => {
    if (managedLoaded) return;
    const t = setTimeout(() => setManagedLoaded(true), 8000);
    return () => clearTimeout(t);
  }, [managedLoaded]);

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
    platformFilteredApps,
    platformFilteredOnlineApps,
    favoritesViewApps,
    platformCounts,
    appsById,
    mergedApps,
    showCustom,
    filteredInstalledApps,
    filteredUpdates,
    handleResetPlatformFilter,
    handleTrendsPlatformCounts,
    sidebarPlatformCounts,
    installedIds,
    managedIds,
    managedLoaded,
    stagedDeepLinkDetail,
    stagedDeepLinkSummary,
    stagedDeepLinkSha256,
  };
}
