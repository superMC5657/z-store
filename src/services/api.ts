import type { AppSettings, AppSummary } from '../types';
import * as catalogApi from './api/catalog';
import * as installerApi from './api/installer';
import * as settingsApi from './api/settings';
import * as socialApi from './api/social';
import { isTauri, tauriInvoke } from './api/client';

export { isTauri, tauriInvoke };

export interface SearchIconReadyPayload {
  search_id: string;
  app_id: string;
  icon: string;
  level: number;
}

/**
 * 发现页 feed 后端分页契约（Rust `get_home_feed` 返回）：
 * `{ items, total, has_more }`。容忍后端/ mock 误写 camelCase（`hasMore`），
 * 统一经 `normalizeHomeFeed` 收敛为 snake_case 只读视图。
 */
export interface HomeFeedResult {
  items: AppSummary[];
  total: number;
  has_more: boolean;
}

export type HomeFeedRaw = {
  items?: AppSummary[];
  total?: number;
  has_more?: boolean;
  hasMore?: boolean;
} | null | undefined;

export function normalizeHomeFeed(raw: HomeFeedRaw): HomeFeedResult {
  const items = Array.isArray(raw?.items) ? (raw as { items: AppSummary[] }).items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  const hasMore = (raw?.has_more ?? (raw as { hasMore?: unknown })?.hasMore) as unknown;
  return { items, total, has_more: hasMore === true };
}

export interface ReadmeVariant {
  lang: 'zh-CN' | 'en-US';
  path: string;
  markdown: string;
}

export interface ReadmeVariantsResult {
  variants: ReadmeVariant[];
}

/**
 * 平台轻量回填结果（Rust `get_platforms_lite`，见 `PlatformsLiteResult`）。
 * `platforms` 为空表示未知（unknown）；`is_stale` 为 true 表示降级数据，
 * 调用方必须视为 pending/待 backfill，永不确认 Other。
 */
export interface PlatformsLiteResult {
  id: string;
  platforms: string[];
  from_cache?: boolean;
  is_stale?: boolean | null;
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
  enrichTrendRepos: 'enrich_trend_repos',
  getAppDetails: 'get_app_details',
  getPlatformsLite: 'get_platforms_lite',
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
  fetchTrendsText: 'fetch_trends_text',
  getSettings: 'get_settings',
  saveSetting: 'save_setting',
  getFavorites: 'get_favorites',
  toggleFavorite: 'toggle_favorite',
  getCategoryApps: 'get_category_apps',
  getCatalogCount: 'get_catalog_count',
  getHomeFeed: 'get_home_feed',
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

/**
 * 在线搜索默认页大小：与后端 `LimitsConfig::online_search_page_size` 对齐（None 即 12）。
 * 前端翻页时显式透传，后端统一钳制 1-50；直查单条仍只回 1 条（page>1 回空）。
 */
export const ONLINE_SEARCH_PER_PAGE = 12;

export const tauriApi = {
  // Catalog / Discovery / Details
  searchApps: catalogApi.searchApps,
  getHomeFeed: catalogApi.getHomeFeed,
  searchAppsOnline: catalogApi.searchAppsOnline,
  enrichTrendRepos: catalogApi.enrichTrendRepos,
  onSearchIconUpgraded: catalogApi.onSearchIconUpgraded,
  getAppDetails: catalogApi.getAppDetails,
  getPlatformsLite: catalogApi.getPlatformsLite,
  getReadmeVariants: catalogApi.getReadmeVariants,
  getCategoryApps: catalogApi.getCategoryApps,
  getCatalogCount: catalogApi.getCatalogCount,
  scanAndMatchLocalApps: catalogApi.scanAndMatchLocalApps,
  importMatchedApps: catalogApi.importMatchedApps,
  getDetectedInstalledAppIds: catalogApi.getDetectedInstalledAppIds,
  importSingleApp: catalogApi.importSingleApp,
  recordSearchQuery: catalogApi.recordSearchQuery,
  getSearchHistory: catalogApi.getSearchHistory,
  clearSearchHistory: catalogApi.clearSearchHistory,
  removeSearchQuery: catalogApi.removeSearchQuery,
  recordAppView: catalogApi.recordAppView,
  getRecentlyViewedApps: catalogApi.getRecentlyViewedApps,
  clearViewHistory: catalogApi.clearViewHistory,
  searchForgeRepos: catalogApi.searchForgeRepos,
  syncCatalog: catalogApi.syncCatalog,
  getOrFetchIcon: catalogApi.getOrFetchIcon,
  cycleAppIcon: catalogApi.cycleAppIcon,
  getAppIconCycle: catalogApi.getAppIconCycle,

  // Installer / Apps / Updates
  getInstalledApps: installerApi.getInstalledApps,
  installApp: installerApi.installApp,
  downloadAsset: installerApi.downloadAsset,
  showFileInFolder: installerApi.showFileInFolder,
  openFolder: installerApi.openFolder,
  uninstallApp: installerApi.uninstallApp,
  unmanageApp: installerApi.unmanageApp,
  launchApp: installerApi.launchApp,
  checkForUpdates: installerApi.checkForUpdates,
  onUpdateItemFound: installerApi.onUpdateItemFound,
  onUpdateCheckProgress: installerApi.onUpdateCheckProgress,
  onUpdateCheckFinished: installerApi.onUpdateCheckFinished,
  onDownloadProgress: installerApi.onDownloadProgress,
  getUpdateRules: installerApi.getUpdateRules,
  setAppSkipVersion: installerApi.setAppSkipVersion,
  setAppFrozen: installerApi.setAppFrozen,
  setAppHidden: installerApi.setAppHidden,
  removeUpdateRule: installerApi.removeUpdateRule,
  selectFolder: installerApi.selectFolder,

  // Settings / Proxy / System
  getMirrorStatus: settingsApi.getMirrorStatus,
  switchMirror: settingsApi.switchMirror,
  testProxy: settingsApi.testProxy,
  fetchTrendsText: settingsApi.fetchTrendsText,
  getSettings: settingsApi.getSettings,
  saveSetting: settingsApi.saveSetting,
  registerDeepLinkScheme: settingsApi.registerDeepLinkScheme,
  handleDeepLink: settingsApi.handleDeepLink,
  getCliDeepLink: settingsApi.getCliDeepLink,
  importUserData: settingsApi.importUserData,
  openUrl: settingsApi.openUrl,

  // Social / Auth / Watched / Host tokens
  getFavorites: socialApi.getFavorites,
  toggleFavorite: socialApi.toggleFavorite,
  getDeveloperProfile: socialApi.getDeveloperProfile,
  syncGithubStarred: socialApi.syncGithubStarred,
  getHostTokens: socialApi.getHostTokens,
  setHostToken: socialApi.setHostToken,
  removeHostToken: socialApi.removeHostToken,
  onQuotaUpdated: socialApi.onQuotaUpdated,
  refreshHostRateLimit: socialApi.refreshHostRateLimit,
  testHostConnection: socialApi.testHostConnection,
  getWatchedApps: socialApi.getWatchedApps,
  watchApp: socialApi.watchApp,
  unwatchApp: socialApi.unwatchApp,
  onWatchUpdated: socialApi.onWatchUpdated,
  onOAuthExpired: socialApi.onOAuthExpired,
  oauthDeviceStart: socialApi.oauthDeviceStart,
  oauthDevicePoll: socialApi.oauthDevicePoll,
  getOAuthUser: socialApi.getOAuthUser,
  oauthLogout: socialApi.oauthLogout,
  starApp: socialApi.starApp,
  unstarApp: socialApi.unstarApp,
  isStarred: socialApi.isStarred,
};

/**
 * 核心统一 API 导出：仅面向 Tauri 桌面端 IPC 通信；
 * 浏览器直接访问时由应用入口渲染环境提示页（见 main.tsx）。
 */
/** 历史别名：与 tauriApi 同一实例；View 层新代码请统一使用 tauriApi。 */
export const api = tauriApi;

export * from './trends';
