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
  isPlatformPending,
  matchPlatformSetWithPending,
  normalizePlatform,
  type PlatformId,
} from '../lib/platformFilter';
import { normalizeId } from '../services/normalizeId';
// pending 语义唯一深模块为 `lib/platformFilter`（ica3-3）：本选择器直接消费 lib，
// 对外仅保留 PENDING_SETTLE_MS/isEnrichedRowPending/unionConfirmedSets 三件重导出
// （ica3-11：旧 pending 别名已删，调用方直引 lib）。
export {
  PENDING_SETTLE_MS,
  isEnrichedRowPending,
  unionConfirmedSets,
} from '../lib/platformFilter';

export interface UseAppSelectorsParams {
  apps: AppSummary[];
  onlineApps: AppSummary[];
  favoriteExtraApps: AppSummary[];
  installedApps: InstalledApp[];
  detectedAppIds: Set<string>;
  updates: UpdateItem[];
  selectedPlatforms: Set<PlatformId>;
  setSelectedPlatforms: React.Dispatch<React.SetStateAction<Set<PlatformId>>>;
  platformResolvedOtherIds: Set<string>;
  selectedApp: AppDetailViewModel | null;
  recentlyViewedApps: AppSummary[];
  currentView: ViewType;
  pendingDeepLinkInstall: string | null;
}

/**
 * 派生选择器（C3 自 App.tsx 抽出，原 L1290-1536）。
 *
 * - 任务 3：平台优先派生（待确认恒可见，落定后走 matchPlatformSet）；
 * - 任务 4：侧栏计数基于全量 `apps`（已确认 other 才计 other 桶，待确认不计数）；
 * - 收藏页 left-join 供给（收录段 + 未收录占位段，小写去重）；
 * - 已安装/更新列表经 `appsById` O(1) 查表，未收录行保持可见；
 * - P0-1 深链确认弹窗的详情/摘要/SHA-256 解析。
 *
 * ica3-6：`selectFavoritesViewApps` 薄透传已删（原经 `app/favoritesUncataloged`
 * 中转），合并器收归本选择器，键归一律经前端唯一口 `normalizeId`，
 * 平台语义仍经 `lib/platformFilter` 单口（不回退）。
 */

export function selectPlatformFilteredApps(
  apps: AppSummary[],
  selectedPlatforms: Set<PlatformId>,
  platformResolvedOtherIds: Set<string>,
): AppSummary[] {
  return apps.filter((a) => matchPlatformSetWithPending(a, selectedPlatforms, platformResolvedOtherIds));
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
      // 待确认：暂不计入任何桶；已确认 other：仅计 other 桶
      if (isPlatformPending(a, platformResolvedOtherIds)) continue;
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

export function buildInstalledIds(installedApps: InstalledApp[], detectedAppIds: Set<string>): Set<string> {
  const set = new Set<string>();
  for (const a of installedApps) {
    set.add(a.app_id);
    const n = normalizeId(a.app_id);
    if (n) set.add(n);
  }
  for (const id of detectedAppIds) {
    set.add(id);
    const n = normalizeId(id);
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
 * P0 已纳管 vs 仅检测到：组件统一经此判态，消灭发现页误报“已安装”。
 * - isManaged：已纳入 ZStore 管理（绿色已安装，来源 installedApps）。
 * - isDetectedOnly：在 union（installed+detected）中但不在 managed 中（灰色检测到·点击纳管）。
 * 大小写归一经 `normalizeId` 单口；raw 直命中优先，归一兜底。
 */
export function isManaged(id: string, managedIds: Set<string>): boolean {
  if (!id || managedIds.size === 0) return false;
  if (managedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && managedIds.has(n)) return true;
  return false;
}

export function isDetectedOnly(id: string, installedIds: Set<string>, managedIds: Set<string>): boolean {
  if (!id) return false;
  if (isManaged(id, managedIds)) return false;
  if (installedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && installedIds.has(n)) return true;
  return false;
}

/**
 * union 已安装（含仅检测到）归一判定：调用方禁止再手写 `installedIds.has(id)` raw 直查
 * （大小写变体 ID 下与 managed 判态分叉，B3a）。raw 直命中优先，归一兜底；
 * 集合缺席（null/undefined）即未安装。
 */
export function isInstalledUnion(id: string, installedIds: Set<string> | null | undefined): boolean {
  if (!id || !installedIds || installedIds.size === 0) return false;
  if (installedIds.has(id)) return true;
  const n = normalizeId(id);
  if (n && installedIds.has(n)) return true;
  return false;
}

/**
 * managed 三态（P1 冷启闪烁修复）：`null` = managed 列表尚未加载（未知），
 * `undefined` = 调用方未提供 managed 信息（旧调用兼容，卡片回退 union 语义）。
 * 未知态调用方渲染中性占位，永不闪灰。
 */
export function selectIsManagedOpt(
  id: string,
  managedIds: Set<string> | null | undefined,
): boolean | null | undefined {
  if (managedIds === undefined) return undefined;
  if (managedIds === null) return null;
  return isManaged(id, managedIds);
}

/**
 * detectedOnly 三态：与 `selectIsManagedOpt` 同口径。managed 未知且 union 命中
 * 即未知（null，占位）；union 未命中即确定未检测到（false，无需占位）。
 */
export function selectIsDetectedOnlyOpt(
  id: string,
  installedIds: Set<string> | null | undefined,
  managedIds: Set<string> | null | undefined,
): boolean | null | undefined {
  if (managedIds === undefined) return undefined;
  if (managedIds === null) return isInstalledUnion(id, installedIds) ? null : false;
  return isDetectedOnly(id, installedIds ?? new Set<string>(), managedIds);
}

/** 徽标四态（单测与文档口径，组件三布尔 props 为其展开形态）。 */
export type BadgeState = 'managed' | 'detected' | 'none' | 'unknown';

export function selectBadgeState(
  id: string,
  installedIds: Set<string> | null | undefined,
  managedIds: Set<string> | null | undefined,
): BadgeState {
  if (!id) return 'none';
  if (managedIds === undefined) return isInstalledUnion(id, installedIds) ? 'managed' : 'none';
  if (managedIds === null) return isInstalledUnion(id, installedIds) ? 'unknown' : 'none';
  if (isManaged(id, managedIds)) return 'managed';
  if (isDetectedOnly(id, installedIds ?? new Set<string>(), managedIds)) return 'detected';
  return 'none';
}

/**
 * 布尔口径 detected 归一（InstallActions 等仅持有 booleans 的末端使用）：
 * 调用方 booleans 须经上方归一选择器得出；末端禁止再手写 `isInstalled && !isManaged`
 * 派生（大小写变体 ID 下与选择器分叉，B3a）。`isManaged === null`（未知）恒非 detected。
 */
export function resolveDetectedOnly(isInstalled: boolean, isManaged: boolean | null): boolean {
  return isInstalled && isManaged === false;
}

/**
 * 收藏页 left-join 合并器（ica3-6 自 `app/favoritesUncataloged` 收归本选择器，
 * 语义逐字一致，键归一改调 `normalizeId` 单口）：
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
    matchPlatformSetWithPending(a, selectedPlatforms, platformResolvedOtherIds),
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

export function useAppSelectors({
  apps,
  onlineApps,
  favoriteExtraApps,
  installedApps,
  detectedAppIds,
  updates,
  selectedPlatforms,
  setSelectedPlatforms,
  platformResolvedOtherIds,
  selectedApp,
  recentlyViewedApps,
  currentView,
  pendingDeepLinkInstall,
}: UseAppSelectorsParams) {
  // 任务 3：以平台优先派生数据供给 精选/趋势/分类 视图（使用同名 apps 属性）。
  // 待确认行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
  const platformFilteredApps = useMemo(
    () => selectPlatformFilteredApps(apps, selectedPlatforms, platformResolvedOtherIds),
    [apps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 搜索在线段同口径平台过滤：与本地段一致，待确认恒可见，落定后走正常过滤。
  const platformFilteredOnlineApps = useMemo(
    () => selectPlatformFilteredApps(onlineApps, selectedPlatforms, platformResolvedOtherIds),
    [onlineApps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 收藏页 left-join 供给：收录段（已平台过滤）+ 未收录占位段（收藏/关注 union 合成，同口径平台过滤后并入，
  // 小写去重防双显）。其它视图仍用 `platformFilteredApps`，计数仍基于全量 `apps`。
  const favoritesViewApps = useMemo(
    () => selectFavoritesViewApps(platformFilteredApps, favoriteExtraApps, selectedPlatforms, platformResolvedOtherIds),
    [platformFilteredApps, favoriteExtraApps, selectedPlatforms, platformResolvedOtherIds]
  );

  // 任务 4（设备平台全局过滤）：侧栏分组的各平台应用计数，
  // 基于全量 `apps` 数组（而非已过滤数组）计算，以便准确呈现“有多少应用支持该设备”。
  // 一次扫完 6 项：已确认 other 才计入虚拟 other 桶，待确认行暂不计数（首绘不闪 Other=23，
  // 落定后单次更新），大小写归一，同应用去重后各桶 +1（与 6×filter 语义一致）。
  const platformCounts = useMemo(
    () => selectPlatformCounts(apps, platformResolvedOtherIds),
    [apps, platformResolvedOtherIds]
  );

  // 目录 id（小写）→ AppSummary 索引，供已安装/更新列表 O(1) 查表，避免每行 apps.find 全扫
  const appsById = useMemo(() => buildAppsById(apps), [apps]);

  const filteredInstalledApps = useMemo(() => {
    return installedApps.filter((inst) => {
      const catalogEntry = appsById.get(normalizeId(inst.app_id));
      return !catalogEntry || matchPlatformSetWithPending(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
    });
  }, [installedApps, appsById, selectedPlatforms, platformResolvedOtherIds]);

  const filteredUpdates = useMemo(() => {
    return updates.filter((u) => {
      const catalogEntry = appsById.get(normalizeId(u.app_id));
      return !catalogEntry || matchPlatformSetWithPending(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
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

  const installedIds = useMemo(() => buildInstalledIds(installedApps, detectedAppIds), [installedApps, detectedAppIds]);

  const managedIds = useMemo(() => buildManagedIds(installedApps), [installedApps]);

  // managed 加载三态（P1 冷启 green→gray→green 闪烁修复）：`installedApps` 初始 `[]`
  // 与“已加载但为空”引用不同（订阅层 `.then(setInstalledApps)` 恒产生新引用，
  // IPC 反序列化无复用），引用变化即 managed 已加载；其它重渲染引用不变即仍未知。
  // 加载失败无写入时 union 为空恒走 'none'（全 Get），故失败态自然降级；8s 超时兜底
  // 防 installed 失败 + detected 成功时占位永久悬挂（此时 union 命中才占位）。
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

  // P0-1 深链安装确认弹窗：呈现应用名称、仓库/来源以及 SHA-256（优先使用已加载详情，兜底使用列表快照）。
  const pendingDeepLinkDetail =
    pendingDeepLinkInstall !== null &&
    selectedApp !== null &&
    normalizeId(selectedApp.id) === normalizeId(pendingDeepLinkInstall) &&
    !selectedApp.isLoading
      ? selectedApp
      : null;
  const pendingDeepLinkSummary =
    pendingDeepLinkDetail ??
    (pendingDeepLinkInstall !== null
      ? appsById.get(normalizeId(pendingDeepLinkInstall)) ??
        recentlyViewedApps.find((a) => normalizeId(a.id) === normalizeId(pendingDeepLinkInstall)) ??
        null
      : null);
  const pendingDeepLinkSha256 = pendingDeepLinkDetail?.releases.find((r) => r.sha256)?.sha256;

  return {
    platformFilteredApps,
    platformFilteredOnlineApps,
    favoritesViewApps,
    platformCounts,
    appsById,
    filteredInstalledApps,
    filteredUpdates,
    handleResetPlatformFilter,
    handleTrendsPlatformCounts,
    sidebarPlatformCounts,
    installedIds,
    managedIds,
    managedLoaded,
    pendingDeepLinkDetail,
    pendingDeepLinkSummary,
    pendingDeepLinkSha256,
  };
}
