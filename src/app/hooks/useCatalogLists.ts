import { useCallback, useMemo, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { patchAppIconList } from '../../services/iconStore';
import { patchRowsPlatforms } from '../../services/search/onlineRows';

/**
 * 收口全站五组重叠 `AppSummary[]` 列表态与同步 ref：
 * - `apps`：当前主目录 / 本地搜索结果；
 * - `fullCatalogApps`：未受顶栏搜索词裁剪的完整目录基线；
 * - `onlineApps`：在线搜索段结果；
 * - `recentlyViewedApps`：最近浏览历史；
 * - `uncatalogedExtraApps`：收藏/关注未收录占位行。
 *
 * 通过 `patchAllLists` / `patchCoreLists` / `patchIcons` / `patchPlatforms` / `findById`
 * 提供统一的多列表写透与查找入口。
 */
export interface CatalogListsStore {
  apps: AppSummary[];
  fullCatalogApps: AppSummary[];
  onlineApps: AppSummary[];
  recentlyViewedApps: AppSummary[];
  uncatalogedExtraApps: AppSummary[];
  appsRef: React.MutableRefObject<AppSummary[]>;
  fullCatalogAppsRef: React.MutableRefObject<AppSummary[]>;
  onlineAppsRef: React.MutableRefObject<AppSummary[]>;
  recentsRef: React.MutableRefObject<AppSummary[]>;
  uncatalogedExtraAppsRef: React.MutableRefObject<AppSummary[]>;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setFullCatalogApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setOnlineApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setRecentlyViewedApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setUncatalogedExtraApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  patchAllLists: (updater: (prev: AppSummary[]) => AppSummary[]) => void;
  patchCoreLists: (updater: (prev: AppSummary[]) => AppSummary[]) => void;
  patchIcons: (targetIdLower: string, icon: string) => void;
  patchPlatforms: (patched: Map<string, string[]>) => void;
  findById: (idLower: string) => AppSummary | undefined;
}

export function useCatalogLists(): CatalogListsStore {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [fullCatalogApps, setFullCatalogApps] = useState<AppSummary[]>([]);
  const [onlineApps, setOnlineApps] = useState<AppSummary[]>([]);
  const [recentlyViewedApps, setRecentlyViewedApps] = useState<AppSummary[]>([]);
  const [uncatalogedExtraApps, setUncatalogedExtraApps] = useState<AppSummary[]>([]);

  const appsRef = useRef<AppSummary[]>(apps);
  appsRef.current = apps;
  const fullCatalogAppsRef = useRef<AppSummary[]>(fullCatalogApps);
  fullCatalogAppsRef.current = fullCatalogApps;
  const onlineAppsRef = useRef<AppSummary[]>(onlineApps);
  onlineAppsRef.current = onlineApps;
  const recentsRef = useRef<AppSummary[]>(recentlyViewedApps);
  recentsRef.current = recentlyViewedApps;
  const uncatalogedExtraAppsRef = useRef<AppSummary[]>(uncatalogedExtraApps);
  uncatalogedExtraAppsRef.current = uncatalogedExtraApps;

  const patchCoreLists = useCallback((updater: (prev: AppSummary[]) => AppSummary[]) => {
    for (const setter of [setApps, setOnlineApps, setRecentlyViewedApps]) {
      try {
        setter(updater);
      } catch {
        // 单列表补丁失败不阻塞其余列表
      }
    }
  }, []);

  const patchAllLists = useCallback((updater: (prev: AppSummary[]) => AppSummary[]) => {
    for (const setter of [
      setApps,
      setFullCatalogApps,
      setOnlineApps,
      setRecentlyViewedApps,
      setUncatalogedExtraApps,
    ]) {
      try {
        setter(updater);
      } catch {
        // 单列表补丁失败不阻塞其余列表
      }
    }
  }, []);

  const patchIcons = useCallback(
    (targetIdLower: string, icon: string) => {
      patchAllLists((prev) => patchAppIconList(prev, targetIdLower, icon));
    },
    [patchAllLists],
  );

  const patchPlatforms = useCallback(
    (patched: Map<string, string[]>) => {
      patchCoreLists((prev) => patchRowsPlatforms(prev, patched));
    },
    [patchCoreLists],
  );

  const findById = useCallback((idLower: string): AppSummary | undefined => {
    const lk = idLower.trim().toLowerCase();
    if (!lk) return undefined;
    return (
      appsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      onlineAppsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      recentsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      uncatalogedExtraAppsRef.current.find((a) => a.id.toLowerCase() === lk)
    );
  }, []);

  return useMemo(
    () => ({
      apps,
      fullCatalogApps,
      onlineApps,
      recentlyViewedApps,
      uncatalogedExtraApps,
      appsRef,
      fullCatalogAppsRef,
      onlineAppsRef,
      recentsRef,
      uncatalogedExtraAppsRef,
      setApps,
      setFullCatalogApps,
      setOnlineApps,
      setRecentlyViewedApps,
      setUncatalogedExtraApps,
      patchAllLists,
      patchCoreLists,
      patchIcons,
      patchPlatforms,
      findById,
    }),
    [
      apps,
      fullCatalogApps,
      onlineApps,
      recentlyViewedApps,
      uncatalogedExtraApps,
      patchAllLists,
      patchCoreLists,
      patchIcons,
      patchPlatforms,
      findById,
    ],
  );
}
