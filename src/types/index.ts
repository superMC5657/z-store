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
  /** 收录态：`true` 表示远端精选或本地收录命中，`false` 未收录；缺席时按 `category !== 'external'` 兜底。 */
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
  /** 最近一次浏览时间戳（Unix 秒），仅 `get_recently_viewed_apps` 返回，用于前端清空遮罩判断。 */
  viewed_at?: number;
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
  /** 显式收录标记，未命中目录时为 `false`。 */
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

/** 全部合法视图，顺序即侧栏渲染顺序。 */
export const VIEW_TYPES = [
  'home',
  'latest',
  'categories',
  'trends',
  'launchpad',
  'pending',
  'favorites',
  'installed',
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

/** 外部链接视图别名（如 `zstore://view/updates` 指向已安装页的「有更新」筛选）。 */
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
  // 推荐画像信号源开关（默认开启）：本地应用信息 / GitHub 用户信息
  enable_local_affinity?: boolean;
  enable_github_affinity?: boolean;
}

interface AffinityCategoryStat {
  category: string;
  weight: number;
}

export interface AffinityProfileSummary {
  /** 任一信号源开启即为个性化推荐。 */
  enabled: boolean;
  /** 本地应用信息信号源（收藏、关注、已安装、浏览、搜索）；缺省随 `enabled`。 */
  local_enabled?: boolean;
  /** GitHub 用户信息信号源（Star、Fork、自有仓库）；缺省随 `enabled`。 */
  github_enabled?: boolean;
  starred_repo_count: number;
  forked_repo_count: number;
  owned_repo_count: number;
  favorites_count: number;
  watched_count: number;
  top_categories: AffinityCategoryStat[];
  top_languages: string[];
  last_synced_at?: number | null;
  installed_count?: number;
  viewed_count?: number;
  search_query_count?: number;
  interest_seeds?: string[];
  feedback_count?: number;
  signal_count?: number;
}

/** 推荐种子与用户的关系（「因为你 X 了 Y」中的 X）。 */
export type SeedRelation = 'favorite' | 'installed' | 'watched' | 'starred' | 'forked' | 'owned';

/** 推荐理由：与后端打分同源（`affinity_explain`）。 */
export type FeaturedReason =
  | { kind: 'seed'; seed_id: string; relation: SeedRelation }
  | { kind: 'category'; category: string }
  | { kind: 'owner'; owner: string }
  | { kind: 'keywords'; tokens: string[] }
  | { kind: 'fresh'; added_at: string }
  | { kind: 'explore'; category: string };

export interface FeaturedPick {
  app: AppSummary;
  reasons: FeaturedReason[];
}

export type FeaturedShelfKind = 'because_you' | 'category_pick' | 'explore' | 'fresh';

export interface FeaturedShelf {
  kind: FeaturedShelfKind;
  seed_id?: string;
  seed_relation?: SeedRelation;
  category?: string;
  items: FeaturedPick[];
}

export type ProfileState = 'off' | 'cold' | 'warm' | 'rich';

/** 精选页整页货架（`get_featured_page`）。 */
export interface FeaturedPage {
  profile_state: ProfileState;
  signal_count: number;
  top_categories: string[];
  hero: FeaturedPick[];
  shelves: FeaturedShelf[];
}

export type FeedbackScope = 'app' | 'category';

export interface SyncCatalogResult {
  updated: boolean;
  count: number;
  message: string;
}

export type ScanSourceKind =
  | 'registry'
  | 'scoop'
  | 'shortcut'
  | 'desktop'
  | 'appimage'
  | 'macos_app';

export type ConfidenceTier = 'high' | 'medium' | 'low';

export const HIGH_CONFIDENCE_THRESHOLD = 0.7;
export const MEDIUM_CONFIDENCE_THRESHOLD = 0.55;

export function confidenceTierForScore(confidence: number): ConfidenceTier {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) return 'medium';
  return 'low';
}

export const MATCH_REASONS = [
  'exact_name',
  'prefix_name',
  'alias',
  'executable',
  'bundle_id',
  'install_dir',
  'publisher',
  'version',
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

export function isKnownMatchReason(reason: string): reason is MatchReason {
  return (MATCH_REASONS as readonly string[]).includes(reason);
}

interface ScannedRawApp {
  display_name: string;
  display_version: string;
  publisher?: string;
  install_location?: string;
  display_icon?: string;
  uninstall_string?: string;
  installed_at?: number;
  registry_key?: string;
  source_kind?: ScanSourceKind;
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
  confidence_tier: ConfidenceTier;
  resolved_executable_path?: string;
  match_reasons?: (MatchReason | (string & {}))[];
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
  /** 网络或限流失败时后端回退了本地旧载荷。 */
  is_stale?: boolean;
  /** 本页 `repo_card_cache` 已确认无可安装资产的未收录行规范 id。 */
  confirmed_other_ids?: string[];
  /** 本页私有仓库的规范 id（登出时清理内存私有卡）。 */
  private_ids?: string[];
}

/** 按 id 批量水合的单仓富卡（`get_repo_cards_batch`，DB-only）。 */
export interface HydratedRepoCard {
  summary: AppSummary;
  confirmed_other: boolean;
  is_private?: boolean;
  /** 完整卡片元数据写入时间（秒）；仅详情缓存回退命中时为 0。 */
  updated_at: number;
}

/** 在线搜索列表快照条目（`search_list_cache` 纯透存，`cached_at` 为秒级时间戳）。 */
export interface SearchListCacheEntry {
  payload_json: string;
  cached_at: number;
  /** 本页含私有仓库：回填 L1 时保留标记，登出随之清除。 */
  has_private?: boolean;
}

/** Star 同步快照条目（`starred_feed_cache` 纯透存，`cached_at` 为秒级时间戳）。 */
export interface StarredFeedCacheEntry {
  payload_json: string;
  cached_at: number;
}

export interface CollectionModalData {
  title: string;
  note?: string | null;
  app_ids: string[];
}

export type CollectionPreviewState = CollectionModalData;

export type DeepLinkAction =
  | { action: 'app_detail'; payload: { app_id: string } }
  | { action: 'install_app'; payload: { app_id: string } }
  | { action: 'search'; payload: { query: string } }
  | { action: 'developer_profile'; payload: { owner: string } }
  | { action: 'open_view'; payload: { view: string } }
  | { action: 'launchpad_app'; payload: { app_id: string } }
  | { action: 'collection'; payload: CollectionModalData };

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

// 收藏/关注条目：携带落盘时的 `is_cataloged` 标记，展示层以该标记为准。
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
  /** 本周期新增星数；仅上游明确提供增量时有值，绝不回退为总 stars。 */
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
  /** 保留字段（趋势抓取忽略）。 */
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
  /** `true` 表示使用陈旧缓存降级兜底；`false`/`undefined` 为新鲜数据。 */
  stale?: boolean;
}

// ── 开源广场（Launchpad）IPC 契约（响应字段 snake_case，与 Rust `launchpad::models` 一致）──

export interface LaunchpadMaker {
  login: string;
  name?: string | null;
  avatar_url: string;
  html_url: string;
}

/** 广场卡片：`summary` 复用全站卡片/详情契约。 */
export interface LaunchpadEntry {
  summary: AppSummary;
  maker_note: string;
  maker_note_en?: string | null;
  maker: LaunchpadMaker;
  launched_at: string;
  latest_release_at?: string | null;
  stars_7d_delta: number;
  discussion_repo: string;
  discussion_number: number;
  discussion_node_id?: string | null;
  discussion_url: string;
  discussion_comments_count: number;
  discussion_upvotes: number;
  is_pinned: boolean;
  pin_until?: string | null;
  pin_tier?: string | null;
  viewer_has_starred: boolean;
  viewer_has_upvoted?: boolean;
}

export interface LaunchpadPulseItem {
  id: string;
  discussion_repo: string;
  discussion_number: number;
  discussion_node_id?: string | null;
  discussion_upvotes?: number | null;
  discussion_comments_count?: number | null;
  viewer_has_upvoted?: boolean | null;
  stars?: number | null;
  forks?: number | null;
  latest_version?: string | null;
  viewer_has_starred?: boolean | null;
}

export interface LaunchpadFeedResponse {
  spotlight: LaunchpadEntry[];
  items: LaunchpadEntry[];
  discussions_repo: string;
  submit_issue_url: string;
  submit_web_url: string;
  generated_at?: string | null;
  cached_at?: number | null;
  is_stale: boolean;
}

export type LaunchpadSortMode = 'recommended' | 'latest' | 'discussions';

export interface LaunchpadDiscussionAuthor {
  login: string;
  avatar_url: string;
  html_url: string;
}

export type LaunchpadReactionContent =
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'LAUGH'
  | 'HOORAY'
  | 'CONFUSED'
  | 'HEART'
  | 'ROCKET'
  | 'EYES';

export interface LaunchpadReactionGroup {
  content: LaunchpadReactionContent;
  count: number;
  viewer_has_reacted: boolean;
}

export interface LaunchpadDiscussionComment {
  id: string;
  body: string;
  created_at: string;
  author_association: string;
  author: LaunchpadDiscussionAuthor | null;
  upvote_count: number;
  viewer_has_upvoted: boolean;
  reaction_groups?: LaunchpadReactionGroup[];
  replies: LaunchpadDiscussionComment[];
}

export interface LaunchpadDiscussionDetail {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  created_at: string;
  locked: boolean;
  closed: boolean;
  author: LaunchpadDiscussionAuthor | null;
  category_name: string;
  upvote_count: number;
  viewer_has_upvoted: boolean;
  viewer_can_upvote: boolean;
  viewer_can_comment: boolean;
  auth_required_for_write: boolean;
  comments_total: number;
  has_next_page: boolean;
  end_cursor: string | null;
  reaction_groups?: LaunchpadReactionGroup[];
  comments: LaunchpadDiscussionComment[];
  is_stale: boolean;
}

export interface LaunchpadUpvoteResult {
  subject_id: string;
  upvote_count: number;
  viewer_has_upvoted: boolean;
  mode: 'upvote' | 'reaction';
}

export type LaunchpadTier = 'free' | 'spotlight-7d' | 'spotlight-14d' | 'spotlight-30d';

export type PreflightCheckKey = 'coord' | 'duplicate' | 'license' | 'release' | 'icon';

export type PreflightCheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheckItem {
  key: PreflightCheckKey;
  status: PreflightCheckStatus;
  detail: string;
}

export interface LaunchpadPreflightResult {
  ok: boolean;
  canonical_id: string;
  forge: string;
  forge_host: string;
  owner: string;
  repo: string;
  repo_name: string;
  description: string;
  homepage: string | null;
  license: string;
  latest_version: string;
  platforms: string[];
  installable_asset_count: number;
  has_checksum_manifest: boolean;
  resolved_icon_url: string;
  stars: number;
  forks: number;
  maker_avatar_url: string;
  already_in_launchpad: boolean;
  already_in_catalog: boolean;
  checks: PreflightCheckItem[];
}
