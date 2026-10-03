import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { zlogWarn } from '../lib/z-log';
import {
  AppDetail,
  AppMatchResult,
  AppSettings,
  AppSummary,
  DownloadProgressPayload,
  ImportAppRequest,
  ImportUserDataCounts,
  InstalledApp,
  MirrorNodeStatus,
  OAuthDeviceStartResult,
  OAuthPollResult,
  OAuthUser,
  ProxyTestResult,
  QuotaUpdatePayload,
  StarredSyncResult,
  UpdateItem,
  UpdateCheckProgressPayload,
  UpdateRule,
  DeveloperProfile,
  HostTokenEntry,
  HostRateLimitStatus,
  DeepLinkAction,
  SyncCatalogResult,
  ForgeRepoInfo,
  WatchUpdatedPayload,
  StarAppResult,
  DownloadAssetResult,
} from '../types';

export interface SearchIconReadyPayload {
  search_id: string;
  app_id: string;
  icon: string;
  level: number;
}

export interface ReadmeVariant {
  lang: 'zh-CN' | 'en-US';
  path: string;
  markdown: string;
}

export interface ReadmeVariantsResult {
  variants: ReadmeVariant[];
}

export interface AppIconCycleResult {
  url: string;
  level: number;
  source?: string;
  // 后端规范字段（snake_case，唯一可信来源；后端字段不动）。
  remote_url?: string;
  is_fallback?: boolean;
  total_levels?: number;
  is_cataloged?: boolean;
  /**
   * @deprecated 前端兼容别名：历史双命名残留，禁止新增写入；
   * 读取请经 normalizeIconCycle 收敛。
   */
  remoteUrl?: string;
  /** @deprecated 同上，经 normalizeIconCycle 收敛。 */
  isFallback?: boolean;
  /** @deprecated 同上，经 normalizeIconCycle 收敛。 */
  totalLevels?: number;
  /** @deprecated 同上，经 normalizeIconCycle 收敛。 */
  isCataloged?: boolean;
}

/**
 * B3-G12 前端收敛：图标轮换双命名的唯一归一出口。
 * 后端只认 snake_case；此函数以后端字段优先、camelCase 兜底，
 * 输出统一的 camelCase 只读视图，供 View/组件层消费。
 */
export interface NormalizedIconCycle {
  url: string;
  remoteUrl?: string;
  level: number;
  source?: string;
  isFallback?: boolean;
  totalLevels?: number;
  isCataloged?: boolean;
}

export function normalizeIconCycle(raw: AppIconCycleResult | null | undefined): NormalizedIconCycle | null {
  if (!raw) return null;
  return {
    url: raw.url,
    remoteUrl: raw.remote_url ?? raw.remoteUrl,
    level: raw.level,
    source: raw.source,
    isFallback: raw.is_fallback ?? raw.isFallback,
    totalLevels: raw.total_levels ?? raw.totalLevels,
    isCataloged: raw.is_cataloged ?? raw.isCataloged,
  };
}

/**
 * B3-G12 表驱动：全部 Tauri 命令名的唯一来源。
 * View 层禁止出现字面量命令名与直调 invoke，必须经 tauriApi 方法调用；
 * api.ts 内部统一经 CMD 派发（见下方的 tauriApi 实现）。
 */
export const CMD = {
  search: 'search_apps',
  searchOnline: 'search_apps_online',
  getAppDetails: 'get_app_details',
  getInstalledApps: 'get_installed_apps',
  installApp: 'install_app',
  downloadAsset: 'download_asset',
  showFileInFolder: 'show_file_in_folder',
  openFolder: 'open_folder',
  uninstallApp: 'uninstall_app',
  unmanageApp: 'unmanage_app',
  launchApp: 'launch_app',
  checkForUpdates: 'check_for_updates',
  getMirrorStatus: 'get_mirror_status',
  switchMirror: 'switch_mirror',
  testProxy: 'test_proxy',
  getSettings: 'get_settings',
  saveSetting: 'save_setting',
  getFavorites: 'get_favorites',
  toggleFavorite: 'toggle_favorite',
  getCategoryApps: 'get_category_apps',
  getCatalogCount: 'get_catalog_count',
  scanAndMatchLocalApps: 'scan_and_match_local_apps',
  importMatchedApps: 'import_matched_apps',
  getDetectedInstalledAppIds: 'get_detected_installed_app_ids',
  importSingleApp: 'import_single_app',
  getUpdateRules: 'get_update_rules',
  setAppSkipVersion: 'set_app_skip_version',
  setAppFrozen: 'set_app_frozen',
  setAppHidden: 'set_app_hidden',
  removeUpdateRule: 'remove_update_rule',
  getDeveloperProfile: 'get_developer_profile',
  syncGithubStarred: 'sync_github_starred',
  recordSearchQuery: 'record_search_query',
  getSearchHistory: 'get_search_history',
  clearSearchHistory: 'clear_search_history',
  removeSearchQuery: 'remove_search_query',
  recordAppView: 'record_app_view',
  getRecentlyViewedApps: 'get_recently_viewed_apps',
  clearViewHistory: 'clear_view_history',
  getHostTokens: 'get_host_tokens',
  setHostToken: 'set_host_token',
  removeHostToken: 'remove_host_token',
  refreshHostRateLimit: 'refresh_host_rate_limit',
  testHostConnection: 'test_host_connection',
  registerDeepLinkScheme: 'register_deep_link_scheme',
  handleDeepLink: 'handle_deep_link',
  getCliDeepLink: 'get_cli_deep_link',
  searchForgeRepos: 'search_forge_repos',
  syncCatalog: 'sync_catalog',
  selectFolder: 'select_folder',
  getOrFetchIcon: 'get_or_fetch_icon',
  cycleAppIcon: 'cycle_app_icon',
  getAppIconCycle: 'get_app_icon_cycle',
  getReadmeVariants: 'get_readme_variants',
  getWatchedApps: 'get_watched_apps',
  watchApp: 'watch_app',
  unwatchApp: 'unwatch_app',
  oauthDeviceStart: 'oauth_device_start',
  oauthDevicePoll: 'oauth_device_poll',
  getOAuthUser: 'get_oauth_user',
  oauthLogout: 'oauth_logout',
  starApp: 'star_app',
  unstarApp: 'unstar_app',
  isStarred: 'is_starred',
  importUserData: 'import_user_data',
  openUrl: 'open_url',
} as const;

export type TauriCommand = (typeof CMD)[keyof typeof CMD];

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'zh-CN',
  ui_scale: '100',
  font_size: '14',
  portable_dir: '%LOCALAPPDATA%\\Programs\\z-store-apps',
  download_dir: '~/Downloads',
  active_mirror: 'ghproxy',
  launch_on_startup: false,
  update_frequency: 'startup',
  detail_cache_ttl_minutes: 30,
  catalog_source_url: '',
  watch_notify_frequency: 'daily',
};

async function tauriInvoke<T>(cmd: TauriCommand, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    return invoke<T>(cmd, args);
  }
  throw new Error('Not in Tauri environment');
}

export const tauriApi = {
  async searchApps(query: string): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>(CMD.search, { query });
  },

  async searchAppsOnline(query: string, searchId?: string): Promise<AppSummary[]> {
    try {
      return await tauriInvoke<AppSummary[]>(CMD.searchOnline, {
        query,
        searchId,
        search_id: searchId,
      });
    } catch (err) {
      zlogWarn(`search_apps_online is not available or failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return [];
    }
  },

  async onSearchIconUpgraded(callback: (payload: SearchIconReadyPayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<SearchIconReadyPayload>('zstore://search-icon-ready', (e) => {
      callback(e.payload);
    });
  },

  async getAppDetails(id: string, forceRefresh = false): Promise<AppDetail> {
    return tauriInvoke<AppDetail>(CMD.getAppDetails, { id, forceRefresh });
  },

  async getReadmeVariants(appId: string): Promise<ReadmeVariantsResult> {
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
  },

  async getInstalledApps(): Promise<InstalledApp[]> {
    return tauriInvoke<InstalledApp[]>(CMD.getInstalledApps);
  },

  async installApp(appId: string, assetName?: string, customInstallDir?: string): Promise<InstalledApp> {
    return tauriInvoke<InstalledApp>(CMD.installApp, {
      appId,
      assetName: assetName || null,
      customInstallDir: customInstallDir || null,
    });
  },

  async downloadAsset(appId: string, assetName?: string): Promise<DownloadAssetResult> {
    return tauriInvoke<DownloadAssetResult>(CMD.downloadAsset, {
      appId,
      assetName: assetName || null,
    });
  },

  async showFileInFolder(path: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.showFileInFolder, { path });
  },

  async openFolder(path: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.openFolder, { path });
  },

  async uninstallApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.uninstallApp, { appId });
  },

  async unmanageApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.unmanageApp, { appId });
  },

  async launchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.launchApp, { appId });
  },

  async checkForUpdates(forceRefresh = false): Promise<UpdateItem[]> {
    return tauriInvoke<UpdateItem[]>(CMD.checkForUpdates, { forceRefresh });
  },

  async onUpdateItemFound(callback: (item: UpdateItem) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<UpdateItem>('zstore://update-item-found', (e) => {
      callback(e.payload);
    });
  },

  async onUpdateCheckProgress(callback: (payload: UpdateCheckProgressPayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<UpdateCheckProgressPayload>('zstore://update-check-progress', (e) => {
      callback(e.payload);
    });
  },

  async onUpdateCheckFinished(callback: (payload: { total_checked: number; total_found: number }) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<{ total_checked: number; total_found: number }>('zstore://update-check-finished', (e) => {
      callback(e.payload);
    });
  },

  async getMirrorStatus(): Promise<MirrorNodeStatus[]> {
    return tauriInvoke<MirrorNodeStatus[]>(CMD.getMirrorStatus);
  },

  async switchMirror(mirrorId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.switchMirror, { mirrorId });
  },

  async testProxy(proxyUrl?: string): Promise<ProxyTestResult> {
    return tauriInvoke<ProxyTestResult>(CMD.testProxy, { proxyUrl: proxyUrl || null });
  },

  async getSettings(): Promise<Record<string, string>> {
    return tauriInvoke<Record<string, string>>(CMD.getSettings);
  },

  async saveSetting(key: string, value: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.saveSetting, { key, value });
  },

  async getFavorites(): Promise<string[]> {
    return tauriInvoke<string[]>(CMD.getFavorites);
  },

  async toggleFavorite(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.toggleFavorite, { appId });
  },

  async getCategoryApps(category: string): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>(CMD.getCategoryApps, { category });
  },

  async getCatalogCount(): Promise<number> {
    return tauriInvoke<number>(CMD.getCatalogCount);
  },

  async scanAndMatchLocalApps(): Promise<AppMatchResult[]> {
    return tauriInvoke<AppMatchResult[]>(CMD.scanAndMatchLocalApps);
  },

  async importMatchedApps(apps: ImportAppRequest[]): Promise<number> {
    return tauriInvoke<number>(CMD.importMatchedApps, { apps });
  },

  async getDetectedInstalledAppIds(forceRefresh = false): Promise<string[]> {
    return tauriInvoke<string[]>(CMD.getDetectedInstalledAppIds, { forceRefresh });
  },

  async importSingleApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.importSingleApp, { appId });
  },

  async onDownloadProgress(callback: (payload: DownloadProgressPayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<DownloadProgressPayload>('zstore://download-progress', (e) => {
      callback(e.payload);
    });
  },

  async getUpdateRules(): Promise<UpdateRule[]> {
    return tauriInvoke<UpdateRule[]>(CMD.getUpdateRules);
  },

  async setAppSkipVersion(appId: string, version: string | null): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.setAppSkipVersion, { appId, version });
  },

  async setAppFrozen(appId: string, isFrozen: boolean): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.setAppFrozen, { appId, isFrozen });
  },

  async setAppHidden(appId: string, isHidden: boolean): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.setAppHidden, { appId, isHidden });
  },

  async removeUpdateRule(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.removeUpdateRule, { appId });
  },

  async getDeveloperProfile(developer: string): Promise<DeveloperProfile> {
    return tauriInvoke<DeveloperProfile>(CMD.getDeveloperProfile, { developer });
  },

  async syncGithubStarred(username?: string): Promise<StarredSyncResult> {
    return tauriInvoke<StarredSyncResult>(CMD.syncGithubStarred, { username });
  },

  async recordSearchQuery(query: string): Promise<void> {
    return tauriInvoke<void>(CMD.recordSearchQuery, { query });
  },

  async getSearchHistory(): Promise<string[]> {
    return tauriInvoke<string[]>(CMD.getSearchHistory);
  },

  async clearSearchHistory(): Promise<void> {
    return tauriInvoke<void>(CMD.clearSearchHistory);
  },

  async removeSearchQuery(query: string): Promise<void> {
    return tauriInvoke<void>(CMD.removeSearchQuery, { query });
  },

  async recordAppView(appId: string): Promise<void> {
    return tauriInvoke<void>(CMD.recordAppView, { appId });
  },

  async getRecentlyViewedApps(): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>(CMD.getRecentlyViewedApps);
  },

  async clearViewHistory(): Promise<void> {
    return tauriInvoke<void>(CMD.clearViewHistory);
  },

  async getHostTokens(): Promise<HostTokenEntry[]> {
    return tauriInvoke<HostTokenEntry[]>(CMD.getHostTokens);
  },

  async setHostToken(host: string, token: string): Promise<void> {
    return tauriInvoke<void>(CMD.setHostToken, { host, token });
  },

  async removeHostToken(host: string): Promise<void> {
    return tauriInvoke<void>(CMD.removeHostToken, { host });
  },

  async onQuotaUpdated(callback: (payload: QuotaUpdatePayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<QuotaUpdatePayload>('zstore://quota-updated', (e) => {
      callback(e.payload);
    });
  },

  async refreshHostRateLimit(host?: string): Promise<HostTokenEntry> {
    return tauriInvoke<HostTokenEntry>(CMD.refreshHostRateLimit, { host });
  },

  async testHostConnection(host: string, token?: string): Promise<HostRateLimitStatus> {
    return tauriInvoke<HostRateLimitStatus>(CMD.testHostConnection, { host, token });
  },

  async registerDeepLinkScheme(): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.registerDeepLinkScheme);
  },

  async handleDeepLink(url: string): Promise<DeepLinkAction> {
    return tauriInvoke<DeepLinkAction>(CMD.handleDeepLink, { url });
  },

  async getCliDeepLink(): Promise<string | null> {
    return tauriInvoke<string | null>(CMD.getCliDeepLink);
  },

  async searchForgeRepos(forge: string, query: string, host?: string): Promise<ForgeRepoInfo[]> {
    return tauriInvoke<ForgeRepoInfo[]>(CMD.searchForgeRepos, { forge, host, query });
  },

  async syncCatalog(force?: boolean): Promise<SyncCatalogResult> {
    return tauriInvoke<SyncCatalogResult>(CMD.syncCatalog, { force });
  },

  async selectFolder(defaultPath?: string, title?: string): Promise<string | null> {
    return tauriInvoke<string | null>(CMD.selectFolder, { defaultPath, title });
  },

  async getOrFetchIcon(appId: string | undefined, remoteUrl: string): Promise<string> {
    return tauriInvoke<string>(CMD.getOrFetchIcon, { appId: appId ?? null, remoteUrl });
  },

  async cycleAppIcon(appId: string): Promise<AppIconCycleResult> {
    return tauriInvoke<AppIconCycleResult>(CMD.cycleAppIcon, { appId, app_id: appId });
  },

  async getAppIconCycle(appId: string): Promise<AppIconCycleResult | null> {
    try {
      return await tauriInvoke<AppIconCycleResult | null>(CMD.getAppIconCycle, { appId, app_id: appId });
    } catch {
      return null;
    }
  },

  async getWatchedApps(): Promise<string[]> {
    const rows = await tauriInvoke<Array<{ app_id: string }>>(CMD.getWatchedApps);
    return rows.map((r) => r.app_id);
  },

  async watchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.watchApp, { appId });
  },

  async unwatchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.unwatchApp, { appId });
  },

  async onWatchUpdated(callback: (payload: WatchUpdatedPayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<WatchUpdatedPayload>('zstore://watch-updated', (e) => {
      callback(e.payload);
    });
  },

  async onOAuthExpired(callback: () => void): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen('zstore://oauth-expired', () => {
      callback();
    });
  },

  async oauthDeviceStart(): Promise<OAuthDeviceStartResult> {
    return tauriInvoke<OAuthDeviceStartResult>(CMD.oauthDeviceStart);
  },

  async oauthDevicePoll(deviceCode: string): Promise<OAuthPollResult> {
    const raw = await tauriInvoke<{ status: string; message?: string }>(CMD.oauthDevicePoll, {
      deviceCode,
    });
    const status =
      raw.status === 'authorized'
        ? 'complete'
        : raw.status === 'expired' || raw.status === 'denied' || raw.status === 'error'
        ? raw.status
        : 'pending';
    return { status, message: raw.message } as OAuthPollResult;
  },

  async getOAuthUser(): Promise<OAuthUser | null> {
    try {
      return await tauriInvoke<OAuthUser | null>(CMD.getOAuthUser);
    } catch {
      return null;
    }
  },

  async oauthLogout(): Promise<boolean> {
    try {
      return await tauriInvoke<boolean>(CMD.oauthLogout);
    } catch {
      return false;
    }
  },

  async starApp(appId: string): Promise<StarAppResult> {
    return tauriInvoke<StarAppResult>(CMD.starApp, { appId });
  },

  async unstarApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>(CMD.unstarApp, { appId });
  },

  async isStarred(appId: string): Promise<boolean> {
    try {
      return await tauriInvoke<boolean>(CMD.isStarred, { appId });
    } catch {
      return false;
    }
  },

  async importUserData(json: string): Promise<ImportUserDataCounts> {
    return tauriInvoke<ImportUserDataCounts>(CMD.importUserData, { json });
  },

  async openUrl(url: string): Promise<void> {
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      await tauriInvoke(CMD.openUrl, { url: trimmed });
    } catch {
      window.open(trimmed, '_blank', 'noopener,noreferrer');
    }
  },
};

/**
 * 核心统一 API 导出：仅面向 Tauri 桌面端 IPC 通信；
 * 浏览器直接访问时由应用入口渲染环境提示页（见 main.tsx）。
 */
/** 历史别名：与 tauriApi 同一实例；View 层新代码请统一使用 tauriApi。 */
export const api = tauriApi;

export * from './trends';

