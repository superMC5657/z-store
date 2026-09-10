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
  SignatureInfo,
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
} from '../types';
import { mockApi } from './mockApi';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  ui_scale: '100',
  font_size: '14',
  portable_dir: '%LOCALAPPDATA%\\Programs\\z-store-apps',
  download_dir: '~/Downloads',
  active_mirror: 'ghproxy',
  max_concurrent_downloads: 3,
  github_token: '',
  close_to_tray: true,
  launch_on_startup: false,
  update_frequency: 'startup',
  detail_cache_ttl_minutes: 30,
  catalog_source_url: 'https://gh-proxy.com/https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json',
  watch_notify_frequency: 'daily',
};

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error('Not in Tauri environment');
}

/**
 * 仓库坐标拆解（如 "owner/repo" 或 "gh:owner/repo" -> { owner, repo }）
 */
function splitOwnerRepo(appId: string): { owner: string; repo: string } {
  const noHost = appId.includes(':') ? appId.slice(appId.indexOf(':') + 1) : appId;
  const slash = noHost.indexOf('/');
  const owner = slash >= 0 ? noHost.slice(0, slash) : '';
  const repo = slash >= 0 ? noHost.slice(slash + 1) : '';
  if (!owner || !repo || repo.includes('/')) throw new Error(`无法解析仓库坐标: ${appId}`);
  return { owner, repo };
}

const tauriApi = {
  async searchApps(query: string): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>('search_apps', { query });
  },

  async getAppDetails(id: string, forceRefresh = false): Promise<AppDetail> {
    const res = await tauriInvoke<AppDetail>('get_app_details', { id, forceRefresh });
    if (res) {
      res.releases = Array.isArray(res.releases)
        ? res.releases
        : Array.isArray(res.assets)
        ? res.assets
        : [];
    }
    return res;
  },

  async forceRefreshApp(id: string): Promise<AppDetail> {
    return this.getAppDetails(id, true);
  },

  async getInstalledApps(): Promise<InstalledApp[]> {
    return tauriInvoke<InstalledApp[]>('get_installed_apps');
  },

  async installApp(appId: string, assetName?: string, customInstallDir?: string): Promise<InstalledApp> {
    return tauriInvoke<InstalledApp>('install_app', {
      appId,
      assetName: assetName || null,
      customInstallDir: customInstallDir || null,
    });
  },

  async uninstallApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('uninstall_app', { appId });
  },

  async unmanageApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('unmanage_app', { appId });
  },

  async launchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('launch_app', { appId });
  },

  async checkForUpdates(forceRefresh = false): Promise<UpdateItem[]> {
    return tauriInvoke<UpdateItem[]>('check_for_updates', { forceRefresh });
  },

  async onUpdateItemFound(callback: (item: UpdateItem) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<UpdateItem>('zstore://update-item-found', (e) => {
      callback(e.payload);
    });
  },

  async onUpdateCheckProgress(callback: (payload: UpdateCheckProgressPayload) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<UpdateCheckProgressPayload>('zstore://update-check-progress', (e) => {
      callback(e.payload);
    });
  },

  async onUpdateCheckFinished(callback: (payload: { total_checked: number; total_found: number }) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ total_checked: number; total_found: number }>('zstore://update-check-finished', (e) => {
      callback(e.payload);
    });
  },

  async getMirrorStatus(): Promise<MirrorNodeStatus[]> {
    return tauriInvoke<MirrorNodeStatus[]>('get_mirror_status');
  },

  async switchMirror(mirrorId: string): Promise<boolean> {
    return tauriInvoke<boolean>('switch_mirror', { mirrorId });
  },

  async pingMirrors(): Promise<MirrorNodeStatus[]> {
    return tauriInvoke<MirrorNodeStatus[]>('ping_mirrors');
  },

  async testProxy(proxyUrl?: string): Promise<ProxyTestResult> {
    return tauriInvoke<ProxyTestResult>('test_proxy', { proxyUrl: proxyUrl || null });
  },

  async setGithubToken(token: string): Promise<boolean> {
    return tauriInvoke<boolean>('set_github_token', { token });
  },

  async getSettings(): Promise<Record<string, string>> {
    return tauriInvoke<Record<string, string>>('get_settings');
  },

  async saveSetting(key: string, value: string): Promise<boolean> {
    return tauriInvoke<boolean>('save_setting', { key, value });
  },

  async resetSettings(): Promise<boolean> {
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      await this.saveSetting(key, String(val));
    }
    return true;
  },

  async getFavorites(): Promise<string[]> {
    return tauriInvoke<string[]>('get_favorites');
  },

  async toggleFavorite(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('toggle_favorite', { appId });
  },

  async getCategoryApps(category: string): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>('get_category_apps', { category });
  },

  async getCatalogCount(): Promise<number> {
    return tauriInvoke<number>('get_catalog_count');
  },

  async warmupTopApps(limit = 15): Promise<number> {
    return tauriInvoke<number>('warmup_top_apps', { limit });
  },

  async scanAndMatchLocalApps(): Promise<AppMatchResult[]> {
    return tauriInvoke<AppMatchResult[]>('scan_and_match_local_apps');
  },

  async importMatchedApps(apps: ImportAppRequest[]): Promise<number> {
    return tauriInvoke<number>('import_matched_apps', { apps });
  },

  async getDetectedInstalledAppIds(forceRefresh = false): Promise<string[]> {
    return tauriInvoke<string[]>('get_detected_installed_app_ids', { forceRefresh });
  },

  async importSingleApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('import_single_app', { appId });
  },

  async onDownloadProgress(callback: (payload: DownloadProgressPayload) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<DownloadProgressPayload>('zstore://download-progress', (e) => {
      callback(e.payload);
    });
  },

  async getUpdateRules(): Promise<UpdateRule[]> {
    return tauriInvoke<UpdateRule[]>('get_update_rules');
  },

  async setAppSkipVersion(appId: string, version: string | null): Promise<boolean> {
    return tauriInvoke<boolean>('set_app_skip_version', { appId, version });
  },

  async setAppFrozen(appId: string, isFrozen: boolean): Promise<boolean> {
    return tauriInvoke<boolean>('set_app_frozen', { appId, isFrozen });
  },

  async setAppHidden(appId: string, isHidden: boolean): Promise<boolean> {
    return tauriInvoke<boolean>('set_app_hidden', { appId, isHidden });
  },

  async removeUpdateRule(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('remove_update_rule', { appId });
  },

  async verifyFileSignature(filePath: string): Promise<SignatureInfo> {
    return tauriInvoke<SignatureInfo>('verify_file_signature', { filePath });
  },

  async getDeveloperProfile(developer: string): Promise<DeveloperProfile> {
    return tauriInvoke<DeveloperProfile>('get_developer_profile', { developer });
  },

  async syncGithubStarred(username?: string): Promise<StarredSyncResult> {
    return tauriInvoke<StarredSyncResult>('sync_github_starred', { username });
  },

  async recordSearchQuery(query: string): Promise<void> {
    return tauriInvoke<void>('record_search_query', { query });
  },

  async getSearchHistory(): Promise<string[]> {
    return tauriInvoke<string[]>('get_search_history');
  },

  async clearSearchHistory(): Promise<void> {
    return tauriInvoke<void>('clear_search_history');
  },

  async removeSearchQuery(query: string): Promise<void> {
    return tauriInvoke<void>('remove_search_query', { query });
  },

  async recordAppView(appId: string): Promise<void> {
    return tauriInvoke<void>('record_app_view', { appId });
  },

  async getRecentlyViewedApps(): Promise<AppSummary[]> {
    return tauriInvoke<AppSummary[]>('get_recently_viewed_apps');
  },

  async clearViewHistory(): Promise<void> {
    return tauriInvoke<void>('clear_view_history');
  },

  async getHostTokens(): Promise<HostTokenEntry[]> {
    return tauriInvoke<HostTokenEntry[]>('get_host_tokens');
  },

  async setHostToken(host: string, token: string): Promise<void> {
    return tauriInvoke<void>('set_host_token', { host, token });
  },

  async removeHostToken(host: string): Promise<void> {
    return tauriInvoke<void>('remove_host_token', { host });
  },

  async onQuotaUpdated(callback: (payload: QuotaUpdatePayload) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<QuotaUpdatePayload>('zstore://quota-updated', (e) => {
      callback(e.payload);
    });
  },

  async refreshHostRateLimit(host?: string): Promise<HostTokenEntry> {
    return tauriInvoke<HostTokenEntry>('refresh_host_rate_limit', { host });
  },

  async testHostConnection(host: string, token?: string): Promise<HostRateLimitStatus> {
    return tauriInvoke<HostRateLimitStatus>('test_host_connection', { host, token });
  },

  async registerDeepLinkScheme(): Promise<boolean> {
    return tauriInvoke<boolean>('register_deep_link_scheme');
  },

  async handleDeepLink(url: string): Promise<DeepLinkAction> {
    return tauriInvoke<DeepLinkAction>('handle_deep_link', { url });
  },

  async getCliDeepLink(): Promise<string | null> {
    return tauriInvoke<string | null>('get_cli_deep_link');
  },

  async searchForgeRepos(forge: string, query: string, host?: string): Promise<ForgeRepoInfo[]> {
    return tauriInvoke<ForgeRepoInfo[]>('search_forge_repos', { forge, host, query });
  },

  async syncCatalog(force?: boolean): Promise<SyncCatalogResult> {
    return tauriInvoke<SyncCatalogResult>('sync_catalog', { force });
  },

  async selectFolder(defaultPath?: string, title?: string): Promise<string | null> {
    return tauriInvoke<string | null>('select_folder', { defaultPath, title });
  },

  async getOrFetchIcon(
    owner: string | undefined,
    repo: string | undefined,
    appId: string | undefined,
    remoteUrl: string
  ): Promise<string> {
    return tauriInvoke<string>('get_or_fetch_icon', { owner, repo, appId, remoteUrl });
  },

  async getWatchedApps(): Promise<string[]> {
    const rows = await tauriInvoke<Array<{ app_id: string }>>('get_watched_apps');
    return rows.map((r) => r.app_id);
  },

  async watchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('watch_app', { appId });
  },

  async unwatchApp(appId: string): Promise<boolean> {
    return tauriInvoke<boolean>('unwatch_app', { appId });
  },

  async onWatchUpdated(callback: (payload: WatchUpdatedPayload) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<WatchUpdatedPayload>('zstore://watch-updated', (e) => {
      callback(e.payload);
    });
  },

  async oauthDeviceStart(): Promise<OAuthDeviceStartResult> {
    return tauriInvoke<OAuthDeviceStartResult>('oauth_device_start');
  },

  async oauthDevicePoll(deviceCode: string): Promise<OAuthPollResult> {
    const raw = await tauriInvoke<{ status: string; message?: string }>('oauth_device_poll', {
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
      return await tauriInvoke<OAuthUser | null>('get_oauth_user');
    } catch {
      return null;
    }
  },

  async oauthLogout(): Promise<boolean> {
    try {
      return await tauriInvoke<boolean>('oauth_logout');
    } catch {
      return false;
    }
  },

  async starApp(ownerOrAppId: string, repo?: string): Promise<StarAppResult> {
    const { owner, repo: r } = repo ? { owner: ownerOrAppId, repo } : splitOwnerRepo(ownerOrAppId);
    return tauriInvoke<StarAppResult>('star_app', { owner, repo: r });
  },

  async unstarApp(ownerOrAppId: string, repo?: string): Promise<boolean> {
    const { owner, repo: r } = repo ? { owner: ownerOrAppId, repo } : splitOwnerRepo(ownerOrAppId);
    return tauriInvoke<boolean>('unstar_app', { owner, repo: r });
  },

  async isStarred(ownerOrAppId: string, repo?: string): Promise<boolean> {
    try {
      const { owner, repo: r } = repo ? { owner: ownerOrAppId, repo } : splitOwnerRepo(ownerOrAppId);
      return await tauriInvoke<boolean>('is_starred', { owner, repo: r });
    } catch {
      return false;
    }
  },

  async verifyOwnership(appId: string, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (!trimmed) return false;
    return tauriInvoke<boolean>('verify_ownership', { appId, code: trimmed });
  },

  async importUserData(json: string): Promise<ImportUserDataCounts> {
    return tauriInvoke<ImportUserDataCounts>('import_user_data', { json });
  },

  async openUrl(url: string): Promise<void> {
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      await tauriInvoke('open_url', { url: trimmed });
    } catch (err) {
      console.warn('Failed to invoke open_url via Tauri, falling back to window.open:', err);
      window.open(trimmed, '_blank', 'noopener,noreferrer');
    }
  },
};

/**
 * 核心统一 API 导出：在 Tauri 桌面端走 IPC 通信，在独立浏览器预览模式下平滑降级使用内存 Mock
 */
export const api = isTauri ? tauriApi : (mockApi as unknown as typeof tauriApi);
