import { listen } from '@tauri-apps/api/event';
import { zlogWarn } from '../../lib/z-log';
import type { IconReadyPayload } from '../iconStore';
import type {
  AppDetail,
  AppMatchResult,
  AppSummary,
  CacheUsageStats,
  ForgeRepoInfo,
  ImportAppRequest,
  SyncCatalogResult,
} from '../../types';
import {
  CMD,
  type AppIconCycleResult,
  type HomeFeedRaw,
  type HomeFeedResult,
  type PlatformsLiteResult,
  type ReadmeVariant,
  type ReadmeVariantsResult,
} from '../api';
import { isTauri, tauriInvoke } from './client';

export async function searchApps(query: string, limit?: number, offset?: number): Promise<AppSummary[]> {
  const args: Record<string, unknown> = { query };
  if (limit !== undefined && limit !== null) args.limit = limit;
  if (offset !== undefined && offset !== null) args.offset = offset;
  return tauriInvoke<AppSummary[]>(CMD.search, args);
}

export async function getHomeFeed(
  limit: number,
  offset: number,
  seed?: number,
  strategy?: string,
): Promise<HomeFeedResult> {
  const args: Record<string, unknown> = { limit, offset };
  if (seed !== undefined && seed !== null) args.seed = seed;
  if (strategy !== undefined && strategy !== null) args.strategy = strategy;
  const raw = await tauriInvoke<HomeFeedRaw>(CMD.getHomeFeed, args);
  // 发现页 feed 分页归一：容忍后端/ mock 误写 camelCase（`hasMore`），收敛为 snake_case 只读视图。
  const items = Array.isArray(raw?.items) ? (raw as { items: AppSummary[] }).items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  const hasMore = (raw?.has_more ?? (raw as { hasMore?: unknown })?.hasMore) as unknown;
  return { items, total, has_more: hasMore === true };
}

export async function searchAppsOnline(
  query: string,
  searchId?: string,
  page?: number,
  perPage?: number,
): Promise<{ rows: AppSummary[]; sid: string }> {
  try {
    const args: Record<string, unknown> = { query, search_id: searchId };
    if (page !== undefined && page !== null) args.page = page;
    if (perPage !== undefined && perPage !== null) args.per_page = perPage;
    const res = await tauriInvoke<AppSummary[] | { rows: AppSummary[]; sid: string }>(
      CMD.searchOnline,
      args,
    );
    if (Array.isArray(res)) return { rows: res, sid: '' };
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      sid: typeof res.sid === 'string' ? res.sid : '',
    };
  } catch (err) {
    zlogWarn(
      `search_apps_online is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return { rows: [], sid: '' };
  }
}

export async function enrichTrendRepos(
  repos: { owner: string; repo: string }[],
): Promise<(AppSummary | null)[]> {
  const fallback = repos.map(() => null);
  try {
    const res = await tauriInvoke<(AppSummary | null)[]>(CMD.enrichTrendRepos, { repos });
    if (!Array.isArray(res)) return fallback;
    return repos.map((_, i) => res[i] ?? null);
  } catch (err) {
    zlogWarn(
      `enrich_trend_repos is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return fallback;
  }
}

/**
 * 只听统一事件 `zstore://icon-ready{id,icon,level,via,context}`：
 * 前端只订阅此事件（`via`透传，M2首屏直填不走emit）。
 * 世代门控走 `services/iconStore.applyHit`（读 `context.search_id` vs `currentSearchId`），
 * `level`纯L单调，调用方只做载荷适配 + React 列表 `patch` 注入。
 */
export type SearchIconUpgradePayload = IconReadyPayload;

export async function onSearchIconUpgraded(
  callback: (payload: SearchIconUpgradePayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<IconReadyPayload>('zstore://icon-ready', (e) => {
    callback(e.payload);
  });
}

export async function getAppDetails(id: string, forceRefresh = false): Promise<AppDetail> {
  return tauriInvoke<AppDetail>(CMD.getAppDetails, { id, forceRefresh });
}

export async function getPlatformsLite(id: string): Promise<PlatformsLiteResult> {
  try {
    const res = await tauriInvoke<PlatformsLiteResult>(CMD.getPlatformsLite, { id });
    if (!res || !Array.isArray((res as PlatformsLiteResult).platforms)) {
      zlogWarn(`get_platforms_lite returned invalid shape for id=${id}, treating as stale pending`);
      return { id, platforms: [], is_stale: true };
    }
    return res;
  } catch (err) {
    zlogWarn(
      `get_platforms_lite is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return { id, platforms: [], is_stale: true };
  }
}

export async function getReadmeVariants(appId: string): Promise<ReadmeVariantsResult> {
  try {
    const raw = await tauriInvoke<ReadmeVariantsResult | ReadmeVariant[] | null>(
      CMD.getReadmeVariants,
      { appId, app_id: appId },
    );
    if (!raw) return { variants: [] };
    if (Array.isArray(raw)) return { variants: raw };
    if (Array.isArray((raw as ReadmeVariantsResult).variants)) {
      return { variants: (raw as ReadmeVariantsResult).variants };
    }
    return { variants: [] };
  } catch {
    return { variants: [] };
  }
}

// 图片磁盘缓存查询：返回 asset 本地路径或原 https，失败时回退原链。
export async function getAssetCacheUrl(url: string, appId: string): Promise<string> {
  try {
    const res = await tauriInvoke<string>(CMD.getAssetCacheUrl, { app_id: appId, url });
    if (typeof res === 'string' && res) return res;
    return url;
  } catch {
    return url;
  }
}

// 查询通用图片磁盘缓存占用。
export async function getAssetCacheStats(): Promise<CacheUsageStats | null> {
  try {
    return await tauriInvoke<CacheUsageStats>(CMD.getAssetCacheStats);
  } catch {
    return null;
  }
}

// 清空通用图片磁盘缓存，返回已删除文件数。
export async function clearAssetCache(): Promise<number> {
  return tauriInvoke<number>(CMD.clearAssetCache);
}

// 查询图标磁盘缓存占用。
export async function getIconCacheStats(): Promise<CacheUsageStats | null> {
  try {
    return await tauriInvoke<CacheUsageStats>(CMD.getIconCacheStats);
  } catch {
    return null;
  }
}

// 清空图标磁盘缓存，返回已删除文件数。
export async function clearIconCache(): Promise<number> {
  return tauriInvoke<number>(CMD.clearIconCache);
}

export async function getCategoryApps(category: string): Promise<AppSummary[]> {
  return tauriInvoke<AppSummary[]>(CMD.getCategoryApps, { category });
}

export async function getCatalogCount(): Promise<number> {
  return tauriInvoke<number>(CMD.getCatalogCount);
}

export async function scanAndMatchLocalApps(): Promise<AppMatchResult[]> {
  return tauriInvoke<AppMatchResult[]>(CMD.scanAndMatchLocalApps);
}

export async function importMatchedApps(apps: ImportAppRequest[]): Promise<number> {
  return tauriInvoke<number>(CMD.importMatchedApps, { apps });
}

export async function getDetectedInstalledAppIds(forceRefresh = false): Promise<string[]> {
  return tauriInvoke<string[]>(CMD.getDetectedInstalledAppIds, { forceRefresh });
}

export async function importSingleApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.importSingleApp, { appId });
}

export async function recordSearchQuery(query: string): Promise<void> {
  return tauriInvoke<void>(CMD.recordSearchQuery, { query });
}

export async function getSearchHistory(): Promise<string[]> {
  return tauriInvoke<string[]>(CMD.getSearchHistory);
}

export async function clearSearchHistory(): Promise<void> {
  return tauriInvoke<void>(CMD.clearSearchHistory);
}

export async function removeSearchQuery(query: string): Promise<void> {
  return tauriInvoke<void>(CMD.removeSearchQuery, { query });
}

export async function recordAppView(appId: string): Promise<void> {
  return tauriInvoke<void>(CMD.recordAppView, { appId });
}

export async function getRecentlyViewedApps(): Promise<AppSummary[]> {
  return tauriInvoke<AppSummary[]>(CMD.getRecentlyViewedApps);
}

export async function clearViewHistory(): Promise<void> {
  return tauriInvoke<void>(CMD.clearViewHistory);
}

export async function searchForgeRepos(
  forge: string,
  query: string,
  host?: string,
): Promise<ForgeRepoInfo[]> {
  return tauriInvoke<ForgeRepoInfo[]>(CMD.searchForgeRepos, { forge, host, query });
}

export async function syncCatalog(force?: boolean): Promise<SyncCatalogResult> {
  return tauriInvoke<SyncCatalogResult>(CMD.syncCatalog, { force });
}

export async function getOrFetchIcon(appId: string | undefined, remoteUrl: string): Promise<string> {
  return tauriInvoke<string>(CMD.getOrFetchIcon, { appId: appId ?? null, remoteUrl });
}

export async function cycleAppIcon(appId: string): Promise<AppIconCycleResult> {
  return tauriInvoke<AppIconCycleResult>(CMD.cycleAppIcon, { appId, app_id: appId });
}

export async function getAppIconCycle(appId: string): Promise<AppIconCycleResult | null> {
  try {
    return await tauriInvoke<AppIconCycleResult | null>(CMD.getAppIconCycle, {
      appId,
      app_id: appId,
    });
  } catch {
    return null;
  }
}
