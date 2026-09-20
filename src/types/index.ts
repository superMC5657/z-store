export interface AppSummary {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  stars: number;
  forks: number;
  license: string;
  latest_version: string;
  category: string;
  category_name: string;
  is_verified: boolean;
  is_installed?: boolean;
  has_update?: boolean;
  installed_version?: string;
  forge: string;
  forge_host: string;
  homepage: string | null;
  platforms: string[];
}

export interface ReleaseAsset {
  name: string;
  download_url: string;
  size_bytes: number;
  sha256?: string;
  os: string;
  arch: string;
  kind: string;
}

export interface AppDetail {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  stars: number;
  forks: number;
  license: string;
  latest_version: string;
  changelog: string;
  is_verified: boolean;
  readme_markdown: string;
  releases: ReleaseAsset[];
  category: string;
  category_name: string;
  forge: string;
  forge_host: string;
  cached_at?: number;
  is_stale?: boolean;
  homepage: string | null;
  platforms: string[];
}

// 纯前端视图态：加载/刷新/错误状态不属于后端 AppDetail，独立存放
export interface AppDetailViewModel extends AppDetail {
  isLoading?: boolean;
  isRefreshing?: boolean;
  loadError?: string;
}

export interface InstalledApp {
  app_id: string;
  app_name: string;
  version: string;
  installed_at: number;
  install_method: string;
  install_path: string;
  asset_name: string;
  asset_sha256: string;
  uninstall_command?: string;
  icon?: string;
  icon_bg?: string;
}

export interface MirrorNodeStatus {
  id: string;
  name: string;
  base_url: string;
  latency_ms: number;
  is_active: boolean;
}

export interface ProxyTestResult {
  success: boolean;
  latency_ms: number;
  message: string;
}

export interface UpdateItem {
  app_id: string;
  app_name: string;
  current_version: string;
  latest_version: string;
  changelog: string;
  icon?: string;
  icon_bg?: string;
}

export interface UpdateCheckProgressPayload {
  checked: number;
  total: number;
  app_id: string;
  app_name: string;
}

export interface DownloadProgressPayload {
  task_id: string;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bytes_per_sec: number;
  state: 'downloading' | 'verifying' | 'verified' | 'completed_unverified' | 'installing' | 'completed' | 'error' | 'tampered';
  message?: string;
}

export type ViewType = 'home' | 'trends' | 'categories' | 'favorites' | 'installed' | 'updates' | 'settings';

export interface ToastMessage {
  id: string;
  text: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  // P1-8: 界面语言（后端导入白名单已先行支持，前端类型与默认值在此补齐）。
  language: string;
  ui_scale: '90' | '100' | '110' | '125';
  font_size: '12' | '14' | '16' | '18' | '20' | 'small' | 'standard' | 'medium' | 'large';
  portable_dir: string;
  download_dir: string;
  active_mirror: string;
  max_concurrent_downloads: number;
  github_token: string;
  close_to_tray: boolean;
  launch_on_startup: boolean;
  update_frequency: 'startup' | 'daily' | 'manual';
  detail_cache_ttl_minutes: number;
  catalog_source_url: string;
  // FR-6.2: 关注更新的应用内提醒频率（每次启动检查 / 每天汇总）
  watch_notify_frequency: 'startup' | 'daily';
}

export interface SyncCatalogResult {
  updated: boolean;
  count: number;
  message: string;
}

export interface ScannedRawApp {
  display_name: string;
  display_version: string;
  publisher?: string;
  install_location?: string;
  display_icon?: string;
  uninstall_string?: string;
}

export interface AppMatchResult {
  scanned: ScannedRawApp;
  catalog_id: string;
  name: string;
  chinese_name?: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  local_version: string;
  catalog_version: string;
  confidence: number;
  confidence_tier: 'high' | 'medium' | 'low';
  resolved_executable_path?: string;
}

export interface ImportAppRequest {
  app_id: string;
  app_name: string;
  version: string;
  install_path?: string;
  uninstall_command?: string;
}

export interface UpdateRule {
  app_id: string;
  skipped_version?: string | null;
  is_frozen: boolean;
  is_hidden: boolean;
  updated_at: number;
}

export interface SignatureInfo {
  is_signed: boolean;
  is_valid: boolean;
  status: string;
  status_message?: string;
  subject?: string;
  issuer?: string;
  serial_number?: string;
  thumbprint_sha1?: string;
  thumbprint_sha256?: string;
  error_message?: string;
}

export interface DeveloperProfile {
  login: string;
  name?: string | null;
  avatar_url: string;
  html_url: string;
  bio?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  public_repos: number;
  followers: number;
  following: number;
  repos: DeveloperRepoItem[];
}

export interface DeveloperRepoItem {
  id: string;
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  stars: number;
  forks: number;
  language?: string | null;
  has_releases: boolean;
  in_catalog: boolean;
  latest_release_tag?: string | null;
}

export interface StarredSyncResult {
  total_starred: number;
  catalog_matches: AppSummary[];
  other_repos: DeveloperRepoItem[];
}

export interface HostTokenEntry {
  host: string;
  token: string;
  rate_limit_remaining?: number;
  rate_limit_limit?: number;
  rate_limit_reset?: number;
  updated_at: number;
}

export interface HostRateLimitStatus {
  host: string;
  is_connected: boolean;
  rate_limit_remaining?: number;
  rate_limit_limit?: number;
  message?: string;
}

export interface QuotaUpdatePayload {
  host: string;
  rate_limit_remaining?: number;
  rate_limit_limit?: number;
  rate_limit_reset?: number;
}

export type DeepLinkAction =
  | { action: 'app_detail'; payload: { app_id: string } }
  | { action: 'install_app'; payload: { app_id: string } }
  | { action: 'search'; payload: { query: string } }
  | { action: 'developer_profile'; payload: { owner: string } }
  | { action: 'open_view'; payload: { view: string } };

export interface ForgeRepoInfo {
  name: string;
  description?: string | null;
  stars: number;
  forks: number;
  language?: string | null;
  default_branch: string;
}

// FR-6.2: 关注（Watch）/ 订阅更新 —— 后端事件 `zstore://watch-updated` 载荷
export interface WatchUpdatedPayload {
  app_id: string;
  version: string;
  app_name?: string;
}

// FR-7: GitHub OAuth Device Flow（IPCs 由 Rust 侧并发实现，前端防御性调用）
export interface OAuthDeviceStartResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type OAuthPollStatus = 'pending' | 'complete' | 'expired' | 'denied' | 'error';

export interface OAuthPollResult {
  status: OAuthPollStatus;
  message?: string;
}

export interface OAuthUser {
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
  has_list_scope: boolean;
  is_expired: boolean;
}

export interface StarAppResult {
  starred: boolean;
  in_list: boolean;
  warning?: string | null;
}

// FR-6.3-manual: 用户数据手动导出 / 导入（纯文件同步，M2 服务端同步为远期规划）
// P1-8: 备份覆盖除 github_token 之外的全部设置项。github_token（PAT 凭据）
// 出于安全考虑被刻意排除：永不写入备份文件，导入侧白名单同样拒绝该键。
export interface UserDataBackupSettings {
  theme?: string;
  language?: string;
  ui_scale?: string;
  font_size?: string;
  portable_dir?: string;
  download_dir?: string;
  active_mirror?: string;
  max_concurrent_downloads?: number;
  close_to_tray?: boolean;
  launch_on_startup?: boolean;
  update_frequency?: string;
  detail_cache_ttl_minutes?: number;
  catalog_source_url?: string;
  watch_notify_frequency?: string;
}

export interface UserDataBackup {
  version: 1;
  favorites: string[];
  watched: string[];
  settings: UserDataBackupSettings;
}

export interface ImportUserDataCounts {
  favorites_added: number;
  watched_added: number;
  settings_applied: boolean;
  installed_skipped: number;
}

// P3-4: 客户端自更新契约（正式确立为产品需求，绝非待废弃项）。
// 实现面：`src/components/ClientUpdateRow.tsx` 经 `@tauri-apps/plugin-updater`
// 执行 check / downloadAndInstall；签名与更新源以 `src-tauri/tauri.conf.json`
// `plugins.updater`（endpoints + pubkey）为准。此处仅做类型层面的加法声明，
// 不改变任何运行时行为。
export type ClientUpdatePhaseKind =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface ClientUpdateAvailable {
  version: string;
  currentVersion: string;
  notes: string;
}

export interface ClientUpdateDownloadProgress {
  version: string;
  percent: number | null;
}

export interface ClientUpdaterConfig {
  endpoints: string[];
  pubkey: string;
}
