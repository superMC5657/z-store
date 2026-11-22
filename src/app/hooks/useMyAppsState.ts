/**
 * 「我的应用」（`My Apps`）状态域：已装列表、安装/卸载/启动、更新与规则、流式检查进度、
 * 无校验资产确认、未收录已装卡片水合、受管态门控，以及按全局设备平台过滤后的已装/更新视图。
 *
 * 安装域与更新域共享同一份已装列表状态，卸载即清残留更新项，无需跨 Hook 桥接。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, UpdateItem, UpdateRule, ViewType } from '../../types';
import { hydrateCardsByIds } from '../../services/repoEnrichCache';
import { normalizeId } from '../../services/normalizeId';
import { detectHostOs } from '../../utils/appHelper';
import type { PlatformId } from '../../lib/platformFilter';
import { buildRulesMap, buildUpdatesMap, selectUpdatableInstalled } from '../../views/manage/manageModel';
import {
  buildInstalledIdSet,
  resolveInstalledPlatformRows,
  selectPlatformFilteredInstalled,
  selectPlatformFilteredUpdates,
} from '../selectors';
import type { CatalogListsStore } from './useCatalogLists';
import { useInstallState } from './useInstallState';
import { useUpdatesState } from './useUpdatesState';
import { useLatestRef } from './mountCtx';

/** 已装列表首读未回的兜底时长：超时后受管态不再占位。 */
const MANAGED_LOAD_TIMEOUT_MS = 8000;

interface UseMyAppsStateParams {
  currentView: ViewType;
  catalogLists: Pick<CatalogListsStore, 'apps' | 'setApps' | 'setFullCatalogApps'>;
  searchQuery: string;
  /** 全量合并目录索引（小写 id → 摘要），供已装行平台查表。 */
  appsById: ReadonlyMap<string, AppSummary>;
  selectedPlatforms: Set<PlatformId>;
  platformResolvedOtherIds: Set<string>;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

export function useMyAppsState({
  currentView,
  catalogLists,
  searchQuery,
  appsById,
  selectedPlatforms,
  platformResolvedOtherIds,
  showToast,
  t,
}: UseMyAppsStateParams) {
  const installedState = useState<InstalledApp[]>([]);
  const [installedApps, setInstalledApps] = installedState;

  const updatesDomain = useUpdatesState({ catalogLists, setInstalledApps, searchQuery, currentView, showToast, t });
  const installDomain = useInstallState({
    currentView,
    apps: catalogLists.apps,
    showToast,
    t,
    onAppRemoved: updatesDomain.handleInstalledAppRemoved,
    installedState,
  });
  const { loadInstalledApps } = installDomain;

  // 受管态门控：已装列表首读落定（成功或失败）即可信；IPC 迟迟不回时超时放行，避免中性占位永久悬挂。
  const [managedLoaded, setManagedLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void loadInstalledApps().finally(() => {
      if (active) setManagedLoaded(true);
    });
    const timer = setTimeout(() => setManagedLoaded(true), MANAGED_LOAD_TIMEOUT_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [loadInstalledApps]);

  // 不在全量目录内的已装应用（被隐藏的收录应用、未收录已装）经零网络批量水合补齐卡片平台。
  const [installedHydratedById, setInstalledHydratedById] = useState<ReadonlyMap<string, AppSummary>>(
    () => new Map(),
  );
  const uncatalogedInstalledKey = useMemo(() => {
    const ids: string[] = [];
    for (const inst of installedApps) {
      const k = normalizeId(inst.app_id);
      if (k && !appsById.has(k)) ids.push(k);
    }
    return ids.sort().join('\n');
  }, [installedApps, appsById]);
  useEffect(() => {
    if (!uncatalogedInstalledKey) return;
    let cancelled = false;
    hydrateCardsByIds(uncatalogedInstalledKey.split('\n'), { uncatalogedOnly: true })
      .then((res) => {
        if (!cancelled) setInstalledHydratedById(res.byId);
      })
      .catch(() => {
        // 水合失败时按安装方式兜底
      });
    return () => {
      cancelled = true;
    };
  }, [uncatalogedInstalledKey]);

  const installedPlatformRows = useMemo(
    () => resolveInstalledPlatformRows(installedApps, appsById, installedHydratedById, detectHostOs()),
    [installedApps, appsById, installedHydratedById],
  );
  const filteredInstalledApps = useMemo(
    () =>
      selectPlatformFilteredInstalled(installedApps, installedPlatformRows, selectedPlatforms, platformResolvedOtherIds),
    [installedApps, installedPlatformRows, selectedPlatforms, platformResolvedOtherIds],
  );
  const { updates, updateRules } = updatesDomain;
  const filteredUpdates = useMemo(
    () => selectPlatformFilteredUpdates(updates, installedPlatformRows, selectedPlatforms, platformResolvedOtherIds),
    [updates, installedPlatformRows, selectedPlatforms, platformResolvedOtherIds],
  );

  // 侧栏「我的应用」角标：与页内「有更新」筛选签同一口径
  const updatableInstalledCount = useMemo(
    () =>
      selectUpdatableInstalled(filteredInstalledApps, buildRulesMap(updateRules), buildUpdatesMap(filteredUpdates))
        .length,
    [filteredInstalledApps, updateRules, filteredUpdates],
  );

  // 规则管理按 app_id 查可用更新（不过平台筛选：规则行本身不受平台筛选影响）
  const allUpdatesById = useMemo(() => buildUpdatesMap(updates), [updates]);

  // 检查更新 Toast 口径：与「有更新」签同一可更新集；联网检查期间已装列表刷新也按最新口径计数。
  const countInputsRef = useLatestRef({ installedApps, installedPlatformRows, selectedPlatforms, platformResolvedOtherIds });
  const countVisibleUpdatable = useCallback(
    (freshUpdates: UpdateItem[], rules: UpdateRule[]) => {
      const cur = countInputsRef.current;
      const platformUpdates = selectPlatformFilteredUpdates(
        freshUpdates,
        cur.installedPlatformRows,
        cur.selectedPlatforms,
        cur.platformResolvedOtherIds,
      );
      const platformInstalled = selectPlatformFilteredInstalled(
        cur.installedApps,
        cur.installedPlatformRows,
        cur.selectedPlatforms,
        cur.platformResolvedOtherIds,
      );
      return selectUpdatableInstalled(platformInstalled, buildRulesMap(rules), buildUpdatesMap(platformUpdates)).length;
    },
    [countInputsRef],
  );

  // 「我的应用」检查更新：联网检查的同时重读本地已装列表（零网络），页面只保留这一个刷新入口。
  const { handleCheckUpdates, refreshUpdatesSnapshotFromDb } = updatesDomain;
  const checkUpdatesAndRefresh = useCallback(async () => {
    void loadInstalledApps();
    await handleCheckUpdates(countVisibleUpdatable);
  }, [loadInstalledApps, handleCheckUpdates, countVisibleUpdatable]);

  // 系统扫描导入成功：重读已装列表并后台复核更新（DB-only 合成读，不阻塞界面）。
  const refreshAfterImport = useCallback(async () => {
    await loadInstalledApps();
    refreshUpdatesSnapshotFromDb();
  }, [loadInstalledApps, refreshUpdatesSnapshotFromDb]);

  const installedIds = useMemo(() => buildInstalledIdSet(installedApps), [installedApps]);

  return {
    ...installDomain,
    ...updatesDomain,
    installedApps,
    installedIds,
    /** 受管集与已装集同源；`managedLoaded` 前视为未知。 */
    managedIds: installedIds,
    managedLoaded,
    installedPlatformRows,
    filteredInstalledApps,
    filteredUpdates,
    updatableInstalledCount,
    allUpdatesById,
    checkUpdatesAndRefresh,
    refreshAfterImport,
  };
}

export type MyAppsState = ReturnType<typeof useMyAppsState>;
