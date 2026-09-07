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
  forge?: string;
  forge_host?: string;
  homepage?: string;
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
  signature_fingerprint?: string;
  readme_markdown: string;
  releases: ReleaseAsset[];
  assets?: ReleaseAsset[];
  category: string;
  category_name: string;
  forge?: string;
  forge_host?: string;
  cached_at?: number;
  is_stale_fallback?: boolean;
  isLoading?: boolean;
  isRefreshing?: boolean;
  loadError?: string;
  homepage?: string;
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

export type ForgeType = 'github' | 'codeberg' | 'gitea' | 'gitlab';

export interface UniversalRepoCoord {
  forge: ForgeType;
  host: string;
  owner: string;
  repo: string;
}

export interface ForgeRepoInfo {
  coord: UniversalRepoCoord;
  name: string;
  description?: string | null;
  stars: number;
  forks: number;
  language?: string | null;
  default_branch: string;
}
