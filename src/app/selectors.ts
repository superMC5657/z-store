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
import { notifyToast } from '../utils/notify';
// loading 语义唯一深模块为 `lib/platformFilter`：本选择器直接消费 lib，
// 对外仅保留 LOADING_SETTLE_MS/isEnrichedRowLoading/unionConfirmedSets 三件重导出。
export {
  LOADING_SETTLE_MS,
  isEnrichedRowLoading,
  unionConfirmedSets,
} from '../lib/platformFilter';

export interface UseAppSelectorsParams {
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
   * Lane C 自维护 overlay（ADR-0017，可选以兼容 Lane B 现有调用）：
   * 未归档 custom 列表 + showCustom 开关（默认开）。缺席即无 overlay，行为零变化。
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

export function selectPlatformFilteredApps(
  apps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  return apps.filter((a) => matchPlatformSetWithLoading(a, selectedPlatforms, platformResolvedOtherIds));
}

export function selectPlatformCounts(
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

export function buildAppsById(apps: AppSummary[]): Map<string, AppSummary> {
  const map = new Map<string, AppSummary>();
  for (const a of apps) {
    const key = normalizeId(a.id);
    if (!key) continue;
    if (!map.has(key)) map.set(key, a);
  }
  return map;
}

export function buildInstalledIds(installedApps: InstalledApp[]): Set<string> {
  const set = new Set<string>();
  for (const a of installedApps) {
    set.add(a.app_id);
    const n = normalizeId(a.app_id);
    if (n) set.add(n);
  }
  return set;
}

export function buildManagedIds(installedApps: InstalledApp[]): Set<string> {
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
 * managed 三态（P1 冷启闪烁修复）：`null` = managed 列表尚未加载（未知），
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
export type BadgeState = 'managed' | 'none' | 'unknown';

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

// ---------- Lane C：全局合并显示 + showCustom 开关 + 转正提示 ----------

/** 自维护 overlay 开关默认值：开（关闭即隐藏全部 custom 行）。 */
export const SHOW_CUSTOM_DEFAULT = true;

/** showCustom 设置键（兼容 snake/camel；值形态兼容 boolean/数字/字符串）。 */
export const SHOW_CUSTOM_SETTING_KEYS = ['showCustom', 'show_custom'] as const;

/** 带 source 标记的合并行（custom 标 source=custom，is_cataloged 恒 true）。 */
export type MergedAppRow = AppSummary & {
  source?: string;
  is_cataloged?: boolean;
};

/** 是否为自维护行（source=custom 即是；category external 原样保留，不参与判定）。 */
export function isCustomAppRow(app: { source?: unknown }): boolean {
  return (app as { source?: unknown }).source === 'custom';
}

/**
 * showCustom 解析（纯函数，默认开）：
 * settings 缺席/无键即默认开；'false'/false/0/'0'/'no'/'off' 即关，其余即开。
 */
export function resolveShowCustom(
  settings?: Record<string, unknown> | null,
  fallback: boolean = SHOW_CUSTOM_DEFAULT,
): boolean {
  if (!settings) return fallback;
  for (const key of SHOW_CUSTOM_SETTING_KEYS) {
    if (!(key in settings)) continue;
    const v = (settings as Record<string, unknown>)[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '' ) continue;
      if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
      if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
      continue;
    }
  }
  return fallback;
}

/** custom 行打标（source=custom，is_cataloged 恒 true；不改原对象）。 */
export function markCustomSource<T extends AppSummary>(app: T): MergedAppRow {
  return { ...app, source: 'custom', is_cataloged: true };
}

/**
 * 全局合并（远端优先去重，custom 仅补位）：
 * - remote 在前，custom 在后；同 id（归一）取远端行；
 * - showCustom=false 即返回 remote 本体（引用透传，调用方可 memo 命中）；
 * - custom 为空同样透传 remote；否则 custom 行经 markCustomSource 打标。
 * Home/分类/搜索三处共用同一口（调用方先合并再平台过滤）。
 */
export function selectMergedCatalogApps(
  remote: AppSummary[],
  custom: readonly AppSummary[],
  showCustom: boolean = SHOW_CUSTOM_DEFAULT,
): AppSummary[] {
  if (!showCustom || custom.length === 0) return remote;
  const seen = new Set<string>();
  for (const r of remote) {
    const k = normalizeId(r.id);
    if (k) seen.add(k);
  }
  let appended = false;
  const out: AppSummary[] = [...remote];
  for (const c of custom) {
    const k = normalizeId(c.id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(markCustomSource(c));
    appended = true;
  }
  if (!appended) return remote;
  return out;
}

/** 未归档 custom 可见行（archived 即隐藏；后端默认已过滤，此处再守一次）。 */
export function selectVisibleCustomApps<T extends { archived?: boolean }>(entries: readonly T[]): T[] {
  return entries.filter((e) => !e.archived);
}

// ---------- Lane C fix：在线/趋势 enrich 显式 is_cataloged 标注 ----------
// 根因：后端 AppSummary 无 is_cataloged（models.rs），在线/富卡 category 为
// guess_category 猜的真实分类（http.rs 默认 dev），appHelper category 兜底遂误判已收录。
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
export function isCatalogedId(id: unknown, catalogIds: ReadonlySet<string>): boolean {
  const k = normalizeId(id);
  return k !== '' && catalogIds.has(k);
}

/**
 * 单行显式标注（不改原对象）：
 * - source=custom 草稿行恒 true（不被 catalog 集覆盖）；
 * - 其余按 catalog 集命中=true、未命中=false，显式携带以优先于 category 兜底；
 * - 已有正确布尔值即原引用透传（memo 友好）。
 */
export function annotateIsCataloged<T extends AppSummary>(
  row: T,
  catalogIds: ReadonlySet<string>,
): T {
  if (isCustomAppRow(row as { source?: unknown })) {
    return typeof (row as { is_cataloged?: unknown }).is_cataloged === 'boolean' &&
      (row as { is_cataloged?: unknown }).is_cataloged === true
      ? row
      : ({ ...row, is_cataloged: true } as T);
  }
  const expected = isCatalogedId((row as AppSummary).id, catalogIds);
  const cur = (row as { is_cataloged?: unknown }).is_cataloged;
  if (typeof cur === 'boolean' && cur === expected) return row;
  return { ...row, is_cataloged: expected } as T;
}

/**
 * 在线段标注（online 落定处调用）：
 * 命中 catalog 即 true（已收录，在线结果仍正确隐藏按钮），未命中即 false。
 */
export function annotateOnlineCataloged<T extends AppSummary>(
  onlineApps: readonly T[],
  catalogAppsOrIds: readonly AppSummary[] | ReadonlySet<string>,
): T[] {
  if (onlineApps.length === 0) return onlineApps as T[];
  const catalogIds =
    catalogAppsOrIds instanceof Set
      ? catalogAppsOrIds
      : buildCatalogIdSet(catalogAppsOrIds as readonly AppSummary[]);
  let changed = false;
  const out = onlineApps.map((r) => {
    const next = annotateIsCataloged(r, catalogIds);
    if (next !== (r as T)) changed = true;
    return next;
  });
  return changed ? out : (onlineApps as T[]);
}

/**
 * 趋势 enrich 镜像标注（enrich 合并处调用，Record 口径）：
 * 同上，未命中=false，命中=true；key 与 app.id 双通道归一（防别名漂移）。
 */
export function annotateEnrichMirrorCataloged(
  mirror: Record<string, AppSummary>,
  catalogAppsOrIds: readonly AppSummary[] | ReadonlySet<string>,
): Record<string, AppSummary> {
  const keys = Object.keys(mirror);
  if (keys.length === 0) return mirror;
  const catalogIds =
    catalogAppsOrIds instanceof Set
      ? catalogAppsOrIds
      : buildCatalogIdSet(catalogAppsOrIds as readonly AppSummary[]);
  let changed = false;
  const next: Record<string, AppSummary> = { ...mirror };
  for (const k of keys) {
    const cur = mirror[k];
    if (!cur) continue;
    const annotated = annotateIsCataloged(cur, catalogIds);
    if (annotated !== cur) {
      next[k] = annotated;
      changed = true;
    }
  }
  return changed ? next : mirror;
}

/** 转正 toast 文案（恒含“已转正”，无转正返回空串）。 */
export function formatGraduationToast(notices: readonly { id: string }[]): string {
  if (notices.length === 0) return '';
  const ids = notices.map((n) => n.id).join('、');
  return `${ids} 已转正并自动归档`;
}

/**
 * 转正 toast 派发（archived 即隐藏由调用方经可见行过滤完成，此处仅提示）：
 * 文案恒含“已转正”，失败静默不阻塞主流程。
 */
export function notifyGraduationNotices(notices: readonly { id: string; message?: string }[]): void {
  if (notices.length === 0) return;
  const text = formatGraduationToast(notices);
  if (!text) return;
  try {
    notifyToast(text, 'success');
  } catch {
    // 通知失败不影响主流程
  }
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
  // Lane C overlay：custom 未归档叠加到 Home/分类/搜索（远端优先去重，custom 标 source=custom）。
  // 缺省（customApps=[]/showCustom=true）即原数组透传，Lane B 现有调用零变化。
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
  // Lane C fix：在线落定处显式标注 is_cataloged（catalog id 集 canonical 比对），
  // 显式标记优先于 category 兜底；已收录在线仍正确隐藏按钮，未收录 dev 猜分类正确显示。
  const catalogIdSet = useMemo(() => buildCatalogIdSet(apps), [apps]);
  const annotatedOnlineApps = useMemo(
    () => annotateOnlineCataloged(onlineApps, catalogIdSet),
    [onlineApps, catalogIdSet],
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
  // 一次扫完 6 项：已确认 other 才计入虚拟 other 桶，加载中行暂不计数（首绘不闪 Other=23，
  // 落定后单次更新），大小写归一，同应用去重后各桶 +1（与 6×filter 语义一致）。
  // Lane C：计数基于合并后全量（含 custom 补位行）。
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
  // 其余页面沿用收录库口径。null = 尚未上报（首绘沿用收录库，避免闪 0）。
  const [trendsPlatformCounts, setTrendsPlatformCounts] = useState<Record<PlatformId, number> | null>(null);
  const handleTrendsPlatformCounts = useCallback((counts: Record<PlatformId, number>) => {
    setTrendsPlatformCounts(counts);
  }, []);
  const sidebarPlatformCounts = currentView === 'trends' && trendsPlatformCounts ? trendsPlatformCounts : platformCounts;

  const installedIds = useMemo(() => buildInstalledIds(installedApps), [installedApps]);

  const managedIds = useMemo(() => buildManagedIds(installedApps), [installedApps]);

  // managed 加载三态（P1 冷启闪烁修复）：`installedApps` 初始 `[]`
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
