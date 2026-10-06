/**
 * Live-demo Tauri mock（`/live-demo` 嵌入页）。
 *
 * 仅用于浏览器的 Tauri IPC 层替代实现。在 `App` 挂载前安装
 * （参见 `src/main.tsx` 的 demo 分支），以确保 `services/api.ts` 计算出
 * `isTauri === true`，并且所有 `tauriApi` 调用均通过 `invoke` 执行。
 *
 * 作用域：仅覆盖视图层涉及的命令（参见 `demoInvoke` 的 switch）。其他所有命令
 * 均回退至符合数据结构的默认安全值（返回列表的命令返回 `[]`，其余返回 `null`），
 * 并附带单次告警，从而使未 mock 的界面软失败而非导致嵌入页崩溃。
 */
import type { AppSettings } from '../types';
import {
  demoCallbacks,
  demoRunCallback,
  demoTransformCallback,
  demoUnregisterCallback,
  demoUnregisterListener,
  getDemoSettingsSaved,
  hydrate,
  LIST_FALLBACK,
  warnOnce,
} from './demoState';
import { asRecord } from './handlers/common';
import { handlePluginCommand } from './handlers/plugins';
import {
  handleClearSearchHistory,
  handleClearViewHistory,
  handleEnrichTrendRepos,
  handleGetAppDetails,
  handleGetAppIconCycle,
  handleGetCategoryApps,
  handleGetCatalogCount,
  handleGetHomeFeed,
  handleGetOrFetchIcon,
  handleGetPlatformsLite,
  handleGetReadmeVariants,
  handleGetRecentlyViewedApps,
  handleGetSearchHistory,
  handleImportMatchedApps,
  handleRecordAppView,
  handleRecordSearchQuery,
  handleRemoveSearchQuery,
  handleScanAndMatchLocalApps,
  handleSearchApps,
  handleSearchAppsOnline,
  handleSearchForgeRepos,
  handleSyncCatalog,
} from './handlers/catalog';
import {
  handleCheckForUpdates,
  handleDownloadAsset,
  handleGetDetectedInstalledAppIds,
  handleGetInstalledApps,
  handleGetUpdateRules,
  handleImportSingleApp,
  handleInstallApp,
  handleLaunchApp,
  handleOpenFolder,
  handleRemoveUpdateRule,
  handleSelectFolder,
  handleSetAppFrozen,
  handleSetAppHidden,
  handleSetAppSkipVersion,
  handleShowFileInFolder,
  handleUninstallApp,
  handleUnmanageApp,
} from './handlers/installer';
import {
  handleFetchTrendsText,
  handleGetCliDeepLink,
  handleGetMirrorStatus,
  handleGetSettings,
  handleHandleDeepLink,
  handleImportUserData,
  handleOpenUrl,
  handleRegisterDeepLinkScheme,
  handleSaveSetting,
  handleSwitchMirror,
  handleTestProxy,
} from './handlers/settings';
import {
  handleGetDeveloperProfile,
  handleGetFavorites,
  handleGetHostTokens,
  handleGetOAuthUser,
  handleGetWatchedApps,
  handleIsStarred,
  handleOAuthDevicePoll,
  handleOAuthDeviceStart,
  handleOAuthLogout,
  handleRefreshHostRateLimit,
  handleRemoveHostToken,
  handleSetHostToken,
  handleStarApp,
  handleSyncGithubStarred,
  handleTestHostConnection,
  handleToggleFavorite,
  handleUnstarApp,
  handleUnwatchApp,
  handleWatchApp,
} from './handlers/social';

// ---------------------------------------------------------------------------
// Demo 默认显示配置（仅限嵌入页）：UI 缩放 0.9 + 12px 字号。
// ---------------------------------------------------------------------------

const DEMO_UI_SCALE: AppSettings['ui_scale'] = '90';
const DEMO_FONT_SIZE: AppSettings['font_size'] = '12';

// 可用于 grep 检查的构建标记：普通字符串字面量（固定硬编码数值），
// 以便代码压缩后仍能原样保留——可通过 grep 搜索
// `zstore:demo:display-defaults` / `ui_scale=90` / `font_size=12` 进行验证。
// 在 installDemoMock 中挂载到 window，避免被 tree-shaking 移除。
const DEMO_DISPLAY_DEFAULTS_MARKER = 'zstore:demo:display-defaults:ui_scale=90:font_size=12';

const ALLOWED_UI_SCALES: ReadonlySet<string> = new Set(['90', '100', '110', '125']);
const ALLOWED_FONT_SIZES: ReadonlySet<string> = new Set([
  '12',
  '14',
  '16',
  '18',
  '20',
  'small',
  'standard',
  'medium',
  'large',
]);

function normalizeDemoUiScale(raw: string | null | undefined): AppSettings['ui_scale'] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (ALLOWED_UI_SCALES.has(v)) return v as AppSettings['ui_scale'];
  if (v === '0.9' || v === '0.90') return '90';
  if (v === '1' || v === '1.0' || v === '1.00') return '100';
  if (v === '1.1' || v === '1.10') return '110';
  if (v === '1.25') return '125';
  return null;
}

function normalizeDemoFontSize(raw: string | null | undefined): AppSettings['font_size'] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/px$/, '');
  if (ALLOWED_FONT_SIZES.has(v)) return v as AppSettings['font_size'];
  return null;
}

/** 生效的 Demo 显示默认值：硬编码 90/12 < 已保存滑块值 < URL 参数。 */
export function resolveDemoDisplayDefaults(): {
  ui_scale: AppSettings['ui_scale'];
  font_size: AppSettings['font_size'];
} {
  let ui_scale: AppSettings['ui_scale'] = DEMO_UI_SCALE;
  let font_size: AppSettings['font_size'] = DEMO_FONT_SIZE;
  try {
    const saved = getDemoSettingsSaved();
    if (saved['ui_scale'] && ALLOWED_UI_SCALES.has(saved['ui_scale'])) {
      ui_scale = saved['ui_scale'] as AppSettings['ui_scale'];
    }
    if (saved['font_size'] && ALLOWED_FONT_SIZES.has(saved['font_size'])) {
      font_size = saved['font_size'] as AppSettings['font_size'];
    }
  } catch {
    // 保持硬编码默认值
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const urlScale = normalizeDemoUiScale(params.get('scale') ?? params.get('ui_scale') ?? params.get('uiScale'));
    if (urlScale) ui_scale = urlScale;
    const urlFont = normalizeDemoFontSize(params.get('font') ?? params.get('font_size') ?? params.get('fontSize'));
    if (urlFont) font_size = urlFont;
  } catch {
    // 非浏览器环境 / 畸变 URL——保持默认值
  }
  return { ui_scale, font_size };
}

// ---------------------------------------------------------------------------
// Invoke 路由分发器（视图层涉及的命令，逐字对齐 CMD）
// ---------------------------------------------------------------------------

async function demoInvoke(cmd: string, args?: unknown): Promise<unknown> {
  const a = asRecord(args);
  const plugin = handlePluginCommand(cmd, a);
  if (plugin.handled) return plugin.result;

  switch (cmd) {
    // -- 搜索 / 发现 / 目录 ---------------------------------------------
    case 'search_apps':
      return handleSearchApps(a);
    case 'search_apps_online':
      return handleSearchAppsOnline(a);
    case 'enrich_trend_repos':
      return handleEnrichTrendRepos(a);
    case 'get_app_details':
      return handleGetAppDetails(a);
    case 'get_platforms_lite':
      return handleGetPlatformsLite(a);
    case 'get_home_feed':
      return handleGetHomeFeed(a);
    case 'get_category_apps':
      return handleGetCategoryApps(a);
    case 'get_catalog_count':
      return handleGetCatalogCount();
    case 'scan_and_match_local_apps':
      return handleScanAndMatchLocalApps();
    case 'import_matched_apps':
      return handleImportMatchedApps();
    case 'record_search_query':
      return handleRecordSearchQuery(a);
    case 'get_search_history':
      return handleGetSearchHistory();
    case 'clear_search_history':
      return handleClearSearchHistory();
    case 'remove_search_query':
      return handleRemoveSearchQuery(a);
    case 'record_app_view':
      return handleRecordAppView(a);
    case 'get_recently_viewed_apps':
      return handleGetRecentlyViewedApps();
    case 'clear_view_history':
      return handleClearViewHistory();
    case 'search_forge_repos':
      return handleSearchForgeRepos();
    case 'sync_catalog':
      return handleSyncCatalog();
    case 'get_or_fetch_icon':
      return handleGetOrFetchIcon(a);
    case 'cycle_app_icon':
    case 'get_app_icon_cycle':
      return handleGetAppIconCycle(a, cmd);
    case 'get_readme_variants':
      return handleGetReadmeVariants(a);

    // -- 安装生命周期 / 本地应用 / 更新 --------------------------------
    case 'get_installed_apps':
      return handleGetInstalledApps();
    case 'install_app':
      return handleInstallApp(a);
    case 'download_asset':
      return handleDownloadAsset(a);
    case 'show_file_in_folder':
      return handleShowFileInFolder();
    case 'open_folder':
      return handleOpenFolder();
    case 'uninstall_app':
      return handleUninstallApp(a);
    case 'unmanage_app':
      return handleUnmanageApp(a);
    case 'launch_app':
      return handleLaunchApp();
    case 'check_for_updates':
      return handleCheckForUpdates();
    case 'get_detected_installed_app_ids':
      return handleGetDetectedInstalledAppIds();
    case 'import_single_app':
      return handleImportSingleApp(a);
    case 'get_update_rules':
      return handleGetUpdateRules();
    case 'set_app_skip_version':
      return handleSetAppSkipVersion();
    case 'set_app_frozen':
      return handleSetAppFrozen();
    case 'set_app_hidden':
      return handleSetAppHidden();
    case 'remove_update_rule':
      return handleRemoveUpdateRule();
    case 'select_folder':
      return handleSelectFolder();

    // -- 设置 / 代理 / 系统 ---------------------------------------------
    case 'get_mirror_status':
      return handleGetMirrorStatus();
    case 'switch_mirror':
      return handleSwitchMirror();
    case 'test_proxy':
      return handleTestProxy();
    case 'fetch_trends_text':
      return handleFetchTrendsText(a);
    case 'get_settings':
      return handleGetSettings(resolveDemoDisplayDefaults());
    case 'save_setting':
      return handleSaveSetting(a);
    case 'register_deep_link_scheme':
      return handleRegisterDeepLinkScheme();
    case 'handle_deep_link':
      return handleHandleDeepLink();
    case 'get_cli_deep_link':
      return handleGetCliDeepLink();
    case 'import_user_data':
      return handleImportUserData();
    case 'open_url':
      return handleOpenUrl(a);

    // -- 社交 / 认证 / 关注 / 令牌 -------------------------------------
    case 'get_favorites':
      return handleGetFavorites();
    case 'toggle_favorite':
      return handleToggleFavorite(a);
    case 'get_developer_profile':
      return handleGetDeveloperProfile(a);
    case 'sync_github_starred':
      return handleSyncGithubStarred();
    case 'get_host_tokens':
      return handleGetHostTokens();
    case 'set_host_token':
      return handleSetHostToken();
    case 'remove_host_token':
      return handleRemoveHostToken();
    case 'refresh_host_rate_limit':
      return handleRefreshHostRateLimit(a);
    case 'test_host_connection':
      return handleTestHostConnection(a);
    case 'get_watched_apps':
      return handleGetWatchedApps();
    case 'watch_app':
      return handleWatchApp(a);
    case 'unwatch_app':
      return handleUnwatchApp(a);
    case 'oauth_device_start':
      return handleOAuthDeviceStart();
    case 'oauth_device_poll':
      return handleOAuthDevicePoll();
    case 'get_oauth_user':
      return handleGetOAuthUser();
    case 'oauth_logout':
      return handleOAuthLogout();
    case 'star_app':
      return handleStarApp(a);
    case 'unstar_app':
      return handleUnstarApp(a);
    case 'is_starred':
      return handleIsStarred(a);

    default:
      warnOnce(cmd);
      if (LIST_FALLBACK.has(cmd)) return [];
      if (cmd === 'get_catalog_count' || cmd === 'import_matched_apps') return 0;
      return null;
  }
}

// ---------------------------------------------------------------------------
// 安装器（幂等，必须在 services/api 计算 isTauri 之前运行）
// ---------------------------------------------------------------------------

export function installDemoMock(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w['__ZSTORE_DEMO_MOCK__']) return;

  // 在 browserLockdown 劫持 window.open 之前捕获原生 opener，
  // 从而使 Demo 的 `open_url` 仍可为外部链接打开真实的标签页。
  try {
    if (typeof w['__ZSTORE_DEMO_NATIVE_OPEN__'] !== 'function' && typeof window.open === 'function') {
      w['__ZSTORE_DEMO_NATIVE_OPEN__'] = window.open.bind(window);
    }
  } catch {
    // 忽略异常
  }

  hydrate();

  if (
    DEMO_DISPLAY_DEFAULTS_MARKER !==
    `zstore:demo:display-defaults:ui_scale=${DEMO_UI_SCALE}:font_size=${DEMO_FONT_SIZE}`
  ) {
    throw new Error('[demo-mock] display-defaults marker drifted from DEMO_UI_SCALE / DEMO_FONT_SIZE');
  }

  const internals = {
    invoke: (cmd: string, args?: unknown) => demoInvoke(cmd, args),
    transformCallback: (cb?: (data: unknown) => void, once = false) => demoTransformCallback(cb, once),
    unregisterCallback: (id: number) => demoUnregisterCallback(id),
    runCallback: (id: number, data: unknown) => demoRunCallback(id, data),
    callbacks: demoCallbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    convertFileSrc: (filePath: string, protocol = 'asset') => {
      try {
        return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
      } catch {
        return filePath;
      }
    },
  };

  w['__TAURI_INTERNALS__'] = internals;
  (w as Record<string, unknown>)['__TAURI_EVENT_PLUGIN_INTERNALS__'] = {
    unregisterListener: (event: string, eventId: number) => demoUnregisterListener(event, eventId),
  };
  try {
    w['__ZSTORE_DEMO_DISPLAY_DEFAULTS__'] = DEMO_DISPLAY_DEFAULTS_MARKER;
  } catch {
    // 忽略异常——标记仅用于方便构建后 grep 检索，属于尽力而为（best-effort）
  }
  w['__ZSTORE_DEMO_MOCK__'] = true;
}

if (typeof window !== 'undefined') {
  try {
    const flag = (import.meta as unknown as { env?: Record<string, unknown> }).env?.['VITE_DEMO'];
    if (flag) installDemoMock();
  } catch {
    // 绝不阻断模块求值流程
  }
}
