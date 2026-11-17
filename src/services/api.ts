import type { AppSettings, AppSummary } from '../types';
import * as catalogApi from './api/catalog';
import * as installerApi from './api/installer';
import * as launchpadApi from './api/launchpad';
import * as settingsApi from './api/settings';
import * as socialApi from './api/social';
import { isTauri, tauriInvoke } from './api/client';

export { isTauri, tauriInvoke };
export { UNVERIFIED_ASSET_MARKER } from './api/installer';

/**
 * 发现页 feed 后端分页契约（Rust `get_home_feed` 返回）：
 * `{ items, total, has_more }`。
 */
export interface HomeFeedResult {
  items: AppSummary[];
  total: number;
  has_more: boolean;
  /** 分类页/最新入库页：平台预过滤前的全部非隐藏 ID（其余 feed 不带）。 */
  matched_ids?: string[];
}

export type HomeFeedRaw = {
  items?: AppSummary[];
  total?: number;
  has_more?: boolean;
  matched_ids?: string[];
} | null | undefined;

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
 * 调用方必须视为 loading/待 backfill，永不确认 Other。
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
  // 后端规范字段（snake_case，调用方按需直读 `remote_url` 等）。
  remote_url?: string;
  is_fallback?: boolean;
  total_levels?: number;
  is_cataloged?: boolean;
}

/**
 * 表驱动：全部 Tauri 命令名的唯一来源。
 * View 层禁止出现字面量命令名与直调 invoke，必须经 tauriApi 方法调用；
 * api.ts 内部统一经 CMD 派发（见下方的 tauriApi 实现）。
 */
export const CMD = {
  search: 'search_apps',
  searchOnline: 'search_apps_online',
  enrichTrendRepos: 'enrich_trend_repos',
  getAppDetails: 'get_app_details',
  getCachedAppDetailsBatch: 'get_cached_app_details_batch',
  getConfirmedIconsBatch: 'get_confirmed_icons_batch',
  getRepoCardsBatch: 'get_repo_cards_batch',
  getSearchListCache: 'get_search_list_cache',
  saveSearchListCache: 'save_search_list_cache',
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
  getCachedUpdates: 'get_cached_updates',
  switchMirror: 'switch_mirror',
  testProxy: 'test_proxy',
  fetchTrendsText: 'fetch_trends_text',
  getTrendBoardCache: 'get_trend_board_cache',
  saveTrendBoardCache: 'save_trend_board_cache',
  zlogGetDir: 'zlog_get_dir',
  zlogExportBundle: 'zlog_export_bundle',
  getSettings: 'get_settings',
  saveSetting: 'save_setting',
  getFavorites: 'get_favorites',
  getFavoriteEntries: 'get_favorite_entries',
  toggleFavorite: 'toggle_favorite',
  getCategoryApps: 'get_category_apps',
  getLatestCatalogApps: 'get_latest_catalog_apps',
  getHomeFeed: 'get_home_feed',
  getLaunchpadFeed: 'get_launchpad_feed',
  syncLaunchpadDiscussions: 'sync_launchpad_discussions',
  getLaunchpadDiscussion: 'get_launchpad_discussion',
  addLaunchpadComment: 'add_launchpad_comment',
  toggleLaunchpadUpvote: 'toggle_launchpad_upvote',
  toggleLaunchpadCommentUpvote: 'toggle_launchpad_comment_upvote',
  toggleLaunchpadReaction: 'toggle_launchpad_reaction',
  getAffinityProfileSummary: 'get_affinity_profile_summary',
  getFeaturedPage: 'get_featured_page',
  saveInterestSeeds: 'save_interest_seeds',
  dismissFeatured: 'dismiss_featured',
  clearFeedFeedback: 'clear_feed_feedback',
  scanAndMatchLocalApps: 'scan_and_match_local_apps',
  importMatchedApps: 'import_matched_apps',
  getUpdateRules: 'get_update_rules',
  setAppSkipVersion: 'set_app_skip_version',
  setAppFrozen: 'set_app_frozen',
  setAppHidden: 'set_app_hidden',
  getDeveloperProfile: 'get_developer_profile',
  listGithubStarred: 'list_github_starred',
  getStarredFeedCache: 'get_starred_feed_cache',
  saveStarredFeedCache: 'save_starred_feed_cache',
  syncAffinitySignals: 'sync_affinity_signals',
  recordSearchQuery: 'record_search_query',
  getSearchHistory: 'get_search_history',
  clearSearchHistory: 'clear_search_history',
  removeSearchQuery: 'remove_search_query',
  recordAppView: 'record_app_view',
  getRecentlyViewedApps: 'get_recently_viewed_apps',
  registerDeepLinkScheme: 'register_deep_link_scheme',
  handleDeepLink: 'handle_deep_link',
  getCliDeepLink: 'get_cli_deep_link',
  syncCatalog: 'sync_catalog',
  consumeStartupCatalogSynced: 'consume_startup_catalog_synced',
  selectFolder: 'select_folder',
  getOrFetchIcon: 'get_or_fetch_icon',
  cycleAppIcon: 'cycle_app_icon',
  restoreOrFetchIconCycle: 'restore_or_fetch_icon_cycle',
  getReadmeVariants: 'get_readme_variants',
  fetchOrCacheAssetUrl: 'fetch_or_cache_asset_url',
  getWatchedApps: 'get_watched_apps',
  watchApp: 'watch_app',
  unwatchApp: 'unwatch_app',
  getWatchNotifications: 'get_watch_notifications',
  dismissWatchNotification: 'dismiss_watch_notification',
  getDismissedWatchNotifications: 'get_dismissed_watch_notifications',
  restoreWatchNotification: 'restore_watch_notification',
  oauthDeviceStart: 'oauth_device_start',
  oauthDevicePoll: 'oauth_device_poll',
  getOAuthUser: 'get_oauth_user',
  oauthLogout: 'oauth_logout',
  starApp: 'star_app',
  unstarApp: 'unstar_app',
  fetchStarredStatus: 'fetch_starred_status',
  importUserData: 'import_user_data',
  exportBackupFile: 'export_backup_file',
  openUrl: 'open_url',
  listCustomApps: 'list_custom_apps',
  saveCustomApp: 'save_custom_app',
  deleteCustomApp: 'delete_custom_app',
  markCustomSubmitted: 'mark_submitted',
  collectLocalApp: 'collect_local_app',
  revertCollectedApp: 'revert_collected_to_draft',
  withdrawSubmitted: 'withdraw_submitted',
  getCustomAppPrUrl: 'get_custom_app_pr_url',
  getCustomAppPrPayload: 'get_custom_app_pr_payload',
  getLicenseAllowlist: 'get_license_allowlist',
} as const;

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
  detail_cache_ttl_minutes: 60,
  catalog_source_url: '',
  watch_notify_frequency: 'daily',
};

/**
 * 在线搜索默认页大小：与后端 `LimitsConfig::online_search_page_size` 对齐（None 即 20）。
 * 前端翻页时显式透传，后端统一钳制 1-50；直查单条仍只回 1 条（page>1 回空）。
 */
export const ONLINE_SEARCH_PER_PAGE = 20;

export const tauriApi = {
  // Catalog / Discovery / Details
  searchApps: catalogApi.searchApps,
  getHomeFeed: catalogApi.getHomeFeed,
  getAffinityProfileSummary: catalogApi.getAffinityProfileSummary,
  syncAffinitySignals: catalogApi.syncAffinitySignals,
  getFeaturedPage: catalogApi.getFeaturedPage,
  saveInterestSeeds: catalogApi.saveInterestSeeds,
  dismissFeatured: catalogApi.dismissFeatured,
  clearFeedFeedback: catalogApi.clearFeedFeedback,
  searchAppsOnline: catalogApi.searchAppsOnline,
  enrichTrendRepos: catalogApi.enrichTrendRepos,
  onIconReady: catalogApi.onIconReady,
  onCatalogSynced: catalogApi.onCatalogSynced,
  consumeStartupCatalogSynced: catalogApi.consumeStartupCatalogSynced,
  getAppDetails: catalogApi.getAppDetails,
  getCachedAppDetailsBatch: catalogApi.getCachedAppDetailsBatch,
  getConfirmedIconsBatch: catalogApi.getConfirmedIconsBatch,
  getRepoCardsBatch: catalogApi.getRepoCardsBatch,
  getSearchListCache: catalogApi.getSearchListCache,
  saveSearchListCache: catalogApi.saveSearchListCache,
  getPlatformsLite: catalogApi.getPlatformsLite,
  getReadmeVariants: catalogApi.getReadmeVariants,
  fetchOrCacheAssetUrl: catalogApi.fetchOrCacheAssetUrl,
  getCategoryApps: catalogApi.getCategoryApps,
  getLatestCatalogApps: catalogApi.getLatestCatalogApps,
  scanAndMatchLocalApps: catalogApi.scanAndMatchLocalApps,
  importMatchedApps: catalogApi.importMatchedApps,
  recordSearchQuery: catalogApi.recordSearchQuery,
  getSearchHistory: catalogApi.getSearchHistory,
  clearSearchHistory: catalogApi.clearSearchHistory,
  removeSearchQuery: catalogApi.removeSearchQuery,
  recordAppView: catalogApi.recordAppView,
  getRecentlyViewedApps: catalogApi.getRecentlyViewedApps,
  syncCatalog: catalogApi.syncCatalog,
  listCustomApps: catalogApi.listCustomApps,
  saveCustomApp: catalogApi.saveCustomApp,
  deleteCustomApp: catalogApi.deleteCustomApp,
  markCustomSubmitted: catalogApi.markCustomSubmitted,
  collectLocalApp: catalogApi.collectLocalApp,
  revertCollectedApp: catalogApi.revertCollectedApp,
  withdrawSubmitted: catalogApi.withdrawSubmitted,
  getCustomAppPrUrl: catalogApi.getCustomAppPrUrl,
  getCustomAppPrPayload: catalogApi.getCustomAppPrPayload,
  getLicenseAllowlist: catalogApi.getLicenseAllowlist,
  getOrFetchIcon: catalogApi.getOrFetchIcon,
  cycleAppIcon: catalogApi.cycleAppIcon,
  restoreOrFetchIconCycle: catalogApi.restoreOrFetchIconCycle,

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
  getCachedUpdates: installerApi.getCachedUpdates,
  onUpdateItemFound: installerApi.onUpdateItemFound,
  onUpdateCheckProgress: installerApi.onUpdateCheckProgress,
  onUpdateCheckFinished: installerApi.onUpdateCheckFinished,
  onDownloadProgress: installerApi.onDownloadProgress,
  getUpdateRules: installerApi.getUpdateRules,
  setAppSkipVersion: installerApi.setAppSkipVersion,
  setAppFrozen: installerApi.setAppFrozen,
  setAppHidden: installerApi.setAppHidden,
  selectFolder: installerApi.selectFolder,

  // Settings / Proxy / System
  switchMirror: settingsApi.switchMirror,
  testProxy: settingsApi.testProxy,
  fetchTrendsText: settingsApi.fetchTrendsText,
  getSettings: settingsApi.getSettings,
  saveSetting: settingsApi.saveSetting,
  registerDeepLinkScheme: settingsApi.registerDeepLinkScheme,
  handleDeepLink: settingsApi.handleDeepLink,
  getCliDeepLink: settingsApi.getCliDeepLink,
  importUserData: settingsApi.importUserData,
  exportBackupFile: settingsApi.exportBackupFile,
  openUrl: settingsApi.openUrl,

  // Social / Auth / Watched
  getFavorites: socialApi.getFavorites,
  getFavoriteEntries: socialApi.getFavoriteEntries,
  toggleFavorite: socialApi.toggleFavorite,
  getDeveloperProfile: socialApi.getDeveloperProfile,
  listGithubStarred: socialApi.listGithubStarred,
  getStarredFeedCache: socialApi.getStarredFeedCache,
  saveStarredFeedCache: socialApi.saveStarredFeedCache,
  getWatchedApps: socialApi.getWatchedApps,
  watchApp: socialApi.watchApp,
  unwatchApp: socialApi.unwatchApp,
  getWatchNotifications: socialApi.getWatchNotifications,
  dismissWatchNotification: socialApi.dismissWatchNotification,
  getDismissedWatchNotifications: socialApi.getDismissedWatchNotifications,
  restoreWatchNotification: socialApi.restoreWatchNotification,
  onWatchUpdated: socialApi.onWatchUpdated,
  onOAuthExpired: socialApi.onOAuthExpired,
  oauthDeviceStart: socialApi.oauthDeviceStart,
  oauthDevicePoll: socialApi.oauthDevicePoll,
  getOAuthUser: socialApi.getOAuthUser,
  oauthLogout: socialApi.oauthLogout,
  starApp: socialApi.starApp,
  unstarApp: socialApi.unstarApp,
  fetchStarredStatus: socialApi.fetchStarredStatus,

  // Launchpad（开源广场）
  getLaunchpadFeed: launchpadApi.getLaunchpadFeed,
  syncLaunchpadDiscussions: launchpadApi.syncLaunchpadDiscussions,
  getLaunchpadDiscussion: launchpadApi.getLaunchpadDiscussion,
  addLaunchpadComment: launchpadApi.addLaunchpadComment,
  toggleLaunchpadUpvote: launchpadApi.toggleLaunchpadUpvote,
  toggleLaunchpadCommentUpvote: launchpadApi.toggleLaunchpadCommentUpvote,
  toggleLaunchpadReaction: launchpadApi.toggleLaunchpadReaction,

  // Diagnostics / Logs
  getLogDir: settingsApi.getLogDir,
  exportLogBundle: settingsApi.exportLogBundle,
};
