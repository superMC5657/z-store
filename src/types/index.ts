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
  category: string;
  category_name: string;
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
  state: 'downloading' | 'verifying' | 'verified' | 'installing' | 'completed' | 'error' | 'tampered';
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
  font_size: 'small' | 'standard' | 'medium' | 'large';
  always_on_top: boolean;
  portable_dir: string;
  download_dir: string;
  auto_clean_cache: boolean;
  active_mirror: string;
  max_concurrent_downloads: number;
  github_token: string;
  close_to_tray: boolean;
  launch_on_startup: boolean;
  update_frequency: 'startup' | 'daily' | 'manual';
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
