export interface AppSummary {
  id: string;
  name: string;
  description_en?: string;
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
  /**
   * 收录态（后端目录投影盖章）：`true` 表示远端精选或本地收录命中，`false` 明确未收录。
   * 缺席时展示层按 `category !== 'external'` 兜底。
   */
  is_cataloged?: boolean;
  /** 目录来源：`remote`（远端精选）/ `local`（本地收录补位）；未收录时缺席。 */
  source?: 'remote' | 'local' | 'custom';
  /** 本地收录行状态（`collected` 系），仅徽标判定用；远端行缺席。 */
  status?: string;
  forge: string;
  forge_host: string;
  homepage: string | null;
  platforms: string[];
  added_at?: string;
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
  description_en?: string;
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
  /**
   * 显式收录标记（详情经目录 id 集标注，未命中即 false fail-closed）：
   * 展示层（Header）以该标记为准。
   */
  is_cataloged?: boolean;
  /** 目录来源：`remote`（远端精选）/ `local`（本地收录补位）；未收录缺席。 */
  source?: 'remote' | 'local' | 'custom';
  /** 本地收录行状态（`collected` 系），仅徽标判定用；远端行缺席。 */
  status?: string;
  added_at?: string;
}

// 纯前端视图态：加载/刷新/错误/认证状态不属于后端 AppDetail，独立存放
export interface AppDetailViewModel extends AppDetail {
  isLoading?: boolean;
  isRefreshing?: boolean;
  loadError?: string;
  isAuthExpired?: boolean;
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
  // 后端实际 emit 的终态为 verified / completed_unverified；installing 预留给安装阶段进度
  state: 'downloading' | 'verified' | 'completed_unverified' | 'installing' | 'error' | 'tampered';
  message?: string;
}

export interface DownloadAssetResult {
  file_path: string;
  file_name: string;
  dir: string;
  sha256: string;
  verified: boolean;
}

/**
 * 全部合法视图，顺序即侧栏渲染顺序。
 * 与 `ViewType` / `isViewType` / `createNavigate` 同源收口于此，供 App/Sidebar/深链共享。
 */
export const VIEW_TYPES = [
  'home',
  'latest',
  'categories',
  'trends',
  'pending',
  'installed',
  'favorites',
  'settings',
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

/** 运行时守卫：未知值（深链载荷/URL 参数等）判定为非法视图。 */
export function isViewType(value: unknown): value is ViewType {
  return typeof value === 'string' && (VIEW_TYPES as readonly string[]).includes(value);
}

/** 视图内的落点：`updates` = 「我的应用」的「有更新」筛选签。 */
export type ViewFocus = 'updates';

/** 外部入口解析出的目标：视图 + 可选的视图内落点。 */
export interface ViewTarget {
  view: ViewType;
  focus?: ViewFocus;
}

/**
 * 不在 `VIEW_TYPES` 里、但外部链接仍会用到的视图 id。仅供外部入口（深链载荷）解析：
 * `zstore://view/updates` 打开「我的应用」并落在「有更新」筛选签。
 */
const VIEW_LINK_ALIASES: Readonly<Record<string, ViewTarget>> = {
  updates: { view: 'installed', focus: 'updates' },
};

/** 外部字符串 → 视图目标：先认现行视图，再认别名；都不是则返回 null。 */
export function resolveViewTarget(value: unknown): ViewTarget | null {
  if (isViewType(value)) return { view: value };
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(VIEW_LINK_ALIASES, value)) {
    return VIEW_LINK_ALIASES[value];
  }
  return null;
}

/** 集中导航函数签名：编译期仅接受合法视图。 */
export type Navigate = (view: ViewType) => void;

/** 以 App 持有的 setCurrentView 构造集中导航入口。 */
export function createNavigate(setCurrentView: (view: ViewType) => void): Navigate {
  return (view) => {
    // 类型已收窄，运行时仍守一道：绕过类型系统的调用方不得写入非法视图。
    if (!isViewType(view)) return;
    setCurrentView(view);
  };
}

export interface ToastMessage {
  id: string;
  text: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}

export type ShowToast = (message: string, type?: ToastMessage['type']) => void;

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  // 界面语言（支持中英文）
  language: 'zh-CN' | 'en-US';
  ui_scale: '100' | '110' | '125' | '150';
  font_size: '12' | '14' | '16' | '18' | '20' | 'small' | 'standard' | 'medium' | 'large';
  portable_dir: string;
  download_dir: string;
  active_mirror: string;
  launch_on_startup: boolean;
  update_frequency: 'startup' | 'daily' | 'manual';
  detail_cache_ttl_minutes: number;
  catalog_source_url: string;
  // 关注更新的应用内提醒频率（每次启动检查 / 每天汇总）
  watch_notify_frequency: 'startup' | 'daily';
  // 本地亲和度个性化推荐开关（默认开启）
  enable_local_affinity?: boolean;
}

interface AffinityCategoryStat {
  category: string;
  weight: number;
}

export interface AffinityProfileSummary {
  enabled: boolean;
  starred_repo_count: number;
  forked_repo_count: number;
  owned_repo_count: number;
  favorites_count: number;
  watched_count: number;
  top_categories: AffinityCategoryStat[];
  top_languages: string[];
  last_synced_at?: number | null;
}

export interface SyncCatalogResult {
  updated: boolean;
  count: number;
  message: string;
}

interface ScannedRawApp {
  display_name: string;
  display_version: string;
  publisher?: string;
  install_location?: string;
  display_icon?: string;
  uninstall_string?: string;
  installed_at?: number;
}

export interface AppMatchResult {
  scanned: ScannedRawApp;
  catalog_id: string;
  name: string;
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
  installed_at?: number;
}

export interface UpdateRule {
  app_id: string;
  skipped_version?: string | null;
  is_frozen: boolean;
  is_hidden: boolean;
  updated_at: number;
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
  /** 列表截断标记：仓库列表单次拉取无翻页，public_repos > 行数即 true，前端明示截断。 */
  repos_truncated?: boolean;
}

interface DeveloperRepoItem {
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

/** Star 列表单页（按 Star 时间倒序的应用卡片）。 */
export interface StarredPageResult {
  rows: AppSummary[];
  has_more: boolean;
}

export type DeepLinkAction =
  | { action: 'app_detail'; payload: { app_id: string } }
  | { action: 'install_app'; payload: { app_id: string } }
  | { action: 'search'; payload: { query: string } }
  | { action: 'developer_profile'; payload: { owner: string } }
  | { action: 'open_view'; payload: { view: string } };

// 关注（Watch）/ 订阅更新 —— 后端事件 `zstore://watch-updated` 载荷
export interface WatchUpdatedPayload {
  app_id: string;
  version: string;
  app_name?: string;
}

// 已确认（「知道了」）的关注提醒 —— `get_dismissed_watch_notifications` 行，规则管理中可恢复
export interface WatchDismissedEntry {
  app_id: string;
  version: string;
  dismissed_at: number;
}

// 收藏/关注收录标记行（写入时按 catalog index 落 `is_cataloged`，启动与同步时回填校验）：
// `get_favorite_entries` / `get_watched_apps` 逐行携带，展示层徽标以记录为准
// （记录优先；`apps` 目录列表仅作结构去重/驱逐补充，永不覆盖记录标记）。
export interface FavoriteEntry {
  app_id: string;
  is_cataloged: boolean;
  favorited_at: number;
}

export interface WatchedAppEntry {
  app_id: string;
  is_cataloged: boolean;
}

// GitHub OAuth Device Flow（IPCs 由 Rust 侧并发实现，前端防御性调用）
export interface OAuthDeviceStartResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

type OAuthPollStatus = 'pending' | 'authorized' | 'expired' | 'denied' | 'error';

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

// 用户数据手动导出 / 导入（纯文件同步；备份覆盖除 github_token 之外的全部设置项）。
export interface UserDataBackupSettings {
  theme?: string;
  language?: string;
  ui_scale?: string;
  font_size?: string;
  portable_dir?: string;
  download_dir?: string;
  active_mirror?: string;
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
}

// 趋势榜单数据层契约（SSOT）：services/trends/ 负责抓取与排序实现，本文件只承载可序列化的类型定义，
// UI 直接从 types 或具体子模块导入。
export type TrendBoardId =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'new'
  | 'rising'
  | 'healthy';

export interface TrendRepo {
  id: string;
  name: string;
  owner: string;
  repo: string;
  stars: number;
  /**
   * 本周期新增星数。仅当上游明确提供速度口径（trending 页增量文本、
   * doforce change 等）时为 defined；缺失/不可解析时一律为 undefined，
   * 绝不回退为总 stars。UI 契约：仅在 defined 时渲染 +N 徽标，
   * undefined 一律不渲染。
   * 排序契约：`compareStarsGainedDesc` 中 undefined 恒沉底，
   * 双 defined 比大小，tie 按 id 升序（见 `services/trends/parse.ts`）。
   */
  starsGained?: number;
  forks?: number;
  description?: string;
  url?: string;
  category?: string;
}

export interface FetchTrendsOptions {
  language?: string;
  category?: string;
  forceRefresh?: boolean;
  /**
   * 代理前缀（保留字段，仅为契约稳定；趋势抓取忽略本字段）。
   */
  proxyPrefix?: string;
}

// 趋势抓取结果契约（UI 空态/错误 lane 依赖，保持 STABLE）。
// status: 'ok' = 有数据；'empty' = 远端合法空结果；'error' = 失败（见 errorKind）。
type TrendsStatus = 'ok' | 'empty' | 'error';

export type TrendsErrorKind = 'network' | 'timeout' | 'rate-limited' | 'unavailable';

export interface TrendsResult {
  repos: TrendRepo[];
  status: TrendsStatus;
  errorKind?: TrendsErrorKind;
  /**
   * 新鲜度标记：`true` = 陈旧降级（stale 缓存兜底，调用方可据此区分真零与失败空）；
   * `false`/`undefined` = 新鲜（网络/L1/L2 新鲜命中）。空态文案/设计不动，仅供调用方区分。
   */
  stale?: boolean;
}
