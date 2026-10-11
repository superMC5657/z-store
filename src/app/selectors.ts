import { useCallback, useMemo, useState } from 'react';
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
    pendingDeepLinkDetail,
    pendingDeepLinkSummary,
    pendingDeepLinkSha256,
  };
}
