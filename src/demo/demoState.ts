// 只引类型：services/custom 的运行时依赖 services/api，提前求值会抢在 mock 安装前判定 isTauri。
import type { DraftEntryWire } from '../services/custom';
import type {
  AppSummary,
  InstalledApp,
  LaunchpadDiscussionComment,
  LaunchpadReactionGroup,
  SearchListCacheEntry,
  StarredFeedCacheEntry,
  UpdateItem,
  UpdateRule,
} from '../types';
import { canonicalAppId, parseCanonicalCoord } from '../services/normalizeId';
import { DEFAULT_ICON_BG } from '../styles/tokens';
import { demoExternalFallback, findExternalTrend, findSummary, summaries } from './fixtures';
import {
  buildSeedCustomApps,
  buildSeedInstalled,
  buildSeedRecentViewTimes,
  buildSeedUpdateRules,
  buildSeedWatchNotifications,
  SEED_FAVORITES,
  SEED_RECENT_VIEWS,
  SEED_SEARCH_HISTORY,
  SEED_WATCHED,
  type SeedWatchNotifications,
} from './seed';
import { nowSecs } from './handlers/common';
import { findLaunchpadSummary } from './handlers/launchpad';
import { zlogWarn } from '../lib/z-log';

/**
 * `DemoStore`：演示站 Adapter 的唯一可变状态与目录查询底座。
 *
 * 持久化切片按键写回 localStorage（只写变更的那一键）；会话态（搜索/Star 列表快照、
 * 精选负反馈、开源广场互动、图标档位）只在内存，页面刷新即重置，与桌面端「DB 有、内存无」
 * 的边界无关——演示站没有数据库。
 */

export const LS = {
  favorites: 'zstore:demo:favorites:v1',
  watched: 'zstore:demo:watched:v1',
  starred: 'zstore:demo:starred:v1',
  searchHistory: 'zstore:demo:search_history:v1',
  recentViews: 'zstore:demo:recent_views:v1',
  recentViewTimes: 'zstore:demo:recent_view_times:v1',
  installed: 'zstore:demo:installed:v2',
  settings: 'zstore:demo:settings:v1',
  updateRules: 'zstore:demo:update_rules:v1',
  watchNotifications: 'zstore:demo:watch_notifications:v1',
  customApps: 'zstore:demo:custom_apps:v1',
} as const;

export type DemoPersistedKey = keyof typeof LS;

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 无痕模式 / 配额超出——保留内存中的状态
  }
}

function lsHas(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function lsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

function lsStringArray(key: string): string[] {
  const v = lsGet<unknown>(key, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export interface DemoLaunchpadState {
  upvotes: Map<number, { count: number; mine: boolean }>;
  comments: Map<number, LaunchpadDiscussionComment[]>;
  postReactions: Map<number, LaunchpadReactionGroup[]>;
  commentSeq: number;
}

export interface DemoStoreState {
  favorites: Set<string>;
  watched: Set<string>;
  starred: Set<string>;
  searchHistory: string[];
  recentIds: string[];
  recentViewTimes: Record<string, number>;
  installed: InstalledApp[];
  settings: Record<string, string>;
  updateRules: UpdateRule[];
  watchNotifications: SeedWatchNotifications;
  customApps: DraftEntryWire[];
  /** 更新缓存快照（DB 同形）：首读冻结，此后安装/卸载不改其内容。 */
  cachedUpdates: UpdateItem[] | null;
  searchListCache: Map<string, SearchListCacheEntry & { has_private: boolean }>;
  starredFeedCache: Map<string, StarredFeedCacheEntry & { owner_scope: string }>;
  featured: { dismissedApps: Set<string>; dismissedCategories: Set<string>; interestSeeds: string[] };
  launchpad: DemoLaunchpadState;
  iconLevel: Map<string, number>;
}

function emptyState(): DemoStoreState {
  return {
    favorites: new Set(),
    watched: new Set(),
    starred: new Set(),
    searchHistory: [],
    recentIds: [],
    recentViewTimes: {},
    installed: [],
    settings: {},
    updateRules: [],
    watchNotifications: { pending: [], dismissed: [] },
    customApps: [],
    cachedUpdates: null,
    searchListCache: new Map(),
    starredFeedCache: new Map(),
    featured: { dismissedApps: new Set(), dismissedCategories: new Set(), interestSeeds: [] },
    launchpad: { upvotes: new Map(), comments: new Map(), postReactions: new Map(), commentSeq: 0 },
    iconLevel: new Map(),
  };
}

let state: DemoStoreState = emptyState();

/** 当前状态（重置后换新对象，调用方勿跨调用缓存返回值）。 */
export function demoStore(): DemoStoreState {
  return state;
}

/** 首次访问（localStorage 键不存在）时写入演示种子数据；用户清空后保持为空。 */
function seedFirstVisit(): void {
  const now = nowSecs();
  const seedIfMissing = (key: string, build: () => unknown): void => {
    if (!lsHas(key)) lsSet(key, build());
  };
  seedIfMissing(LS.favorites, () => SEED_FAVORITES.map((s) => s.toLowerCase()));
  seedIfMissing(LS.watched, () => SEED_WATCHED.map((s) => s.toLowerCase()));
  seedIfMissing(LS.searchHistory, () => [...SEED_SEARCH_HISTORY]);
  if (!lsHas(LS.recentViews)) {
    lsSet(LS.recentViews, [...SEED_RECENT_VIEWS]);
    lsSet(LS.recentViewTimes, buildSeedRecentViewTimes(now));
  }
  seedIfMissing(LS.installed, () => buildSeedInstalled(now));
  seedIfMissing(LS.updateRules, () => buildSeedUpdateRules(now));
  seedIfMissing(LS.watchNotifications, () => buildSeedWatchNotifications(now));
  seedIfMissing(LS.customApps, () => buildSeedCustomApps(now));
}

function loadRecentViewTimes(): Record<string, number> {
  const stored = lsGet<unknown>(LS.recentViewTimes, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const parsed: Record<string, number> = {};
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) parsed[k.toLowerCase()] = Math.floor(v);
  }
  return parsed;
}

function loadSettings(): Record<string, string> {
  const s = lsGet<unknown>(LS.settings, null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  return Object.fromEntries(
    Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
}

function loadWatchNotifications(): SeedWatchNotifications {
  const stored = lsGet<Partial<SeedWatchNotifications> | null>(LS.watchNotifications, null);
  return {
    pending: Array.isArray(stored?.pending) ? stored.pending : [],
    dismissed: Array.isArray(stored?.dismissed) ? stored.dismissed : [],
  };
}

function loadArray<T>(key: string, valid: (row: T) => boolean): T[] {
  const stored = lsGet<unknown>(key, []);
  return Array.isArray(stored) ? (stored as T[]).filter((row) => row && valid(row)) : [];
}

/**
 * 模拟一次页面加载：缺失的键写入种子，持久化切片从 localStorage 读回，会话态清空。
 * `installDemoMock` 与测试共用。
 */
export function hydrateDemoStore(): void {
  seedFirstVisit();
  const next = emptyState();
  next.favorites = new Set(lsStringArray(LS.favorites).map((s) => s.toLowerCase()));
  next.watched = new Set(lsStringArray(LS.watched).map((s) => s.toLowerCase()));
  next.starred = new Set(lsStringArray(LS.starred).map((s) => s.toLowerCase()));
  next.searchHistory = lsStringArray(LS.searchHistory).slice(0, 20);
  next.recentIds = lsStringArray(LS.recentViews).slice(0, 30);
  next.recentViewTimes = loadRecentViewTimes();
  next.installed = loadArray<InstalledApp>(LS.installed, (i) => typeof i.app_id === 'string');
  next.settings = loadSettings();
  next.updateRules = loadArray<UpdateRule>(LS.updateRules, (r) => typeof r.app_id === 'string');
  next.watchNotifications = loadWatchNotifications();
  next.customApps = loadArray<DraftEntryWire>(LS.customApps, (e) => typeof e.id === 'string');
  state = next;
}

/** 清掉全部演示持久化键与会话态后重新注水种子：单次调用即隔离跨用例状态。 */
export function resetDemoStore(): void {
  for (const key of Object.values(LS)) lsRemove(key);
  hydrateDemoStore();
}

/** 只写回变更的那一个持久化切片。 */
export function persistDemo(key: DemoPersistedKey): void {
  const s = state;
  switch (key) {
    case 'favorites':
      return lsSet(LS.favorites, [...s.favorites]);
    case 'watched':
      return lsSet(LS.watched, [...s.watched]);
    case 'starred':
      return lsSet(LS.starred, [...s.starred]);
    case 'searchHistory':
      return lsSet(LS.searchHistory, s.searchHistory);
    case 'recentViews':
      return lsSet(LS.recentViews, s.recentIds);
    case 'recentViewTimes':
      return lsSet(LS.recentViewTimes, s.recentViewTimes);
    case 'installed':
      return lsSet(LS.installed, s.installed);
    case 'settings':
      return lsSet(LS.settings, s.settings);
    case 'updateRules':
      return lsSet(LS.updateRules, s.updateRules);
    case 'watchNotifications':
      return lsSet(LS.watchNotifications, s.watchNotifications);
    case 'customApps':
      return lsSet(LS.customApps, s.customApps);
  }
}

// ---------------------------------------------------------------------------
// 目录查询底座（与后端 `CatalogService` 同构：远端精选 + 本地库 overlay，远端优先）
// ---------------------------------------------------------------------------

/** 与 `db::custom_apps::is_local_library_entry` 同口径：未归档且已收录或已提交。 */
export function isLocalLibraryEntry(e: DraftEntryWire): boolean {
  return !e.archived && (e.status === 'collected' || e.status === 'local_collected' || e.status === 'submitted');
}

/** 草稿行转卡片摘要；本地库行盖章 `source: 'local'`、`is_cataloged: true`，其余行不入目录。 */
function draftEntryToSummary(e: DraftEntryWire): AppSummary {
  const item = e.item;
  const local = isLocalLibraryEntry(e);
  return {
    id: e.id.toLowerCase(),
    name: item.name || e.id,
    owner: item.owner,
    repo: item.repo,
    icon: item.icon ?? '',
    icon_bg: item.icon_bg || DEFAULT_ICON_BG,
    description: item.description ?? '',
    ...(item.description_en ? { description_en: item.description_en } : {}),
    stars: Number.isFinite(item.stars) ? item.stars : 0,
    forks: Number.isFinite(item.forks) ? item.forks : 0,
    license: item.license,
    latest_version: item.default_version || 'v0.1.0',
    category: item.category || 'dev',
    category_name: item.category_name || item.category || 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: item.homepage ?? null,
    platforms: [...(item.platforms ?? [])],
    ...(item.added_at ? { added_at: item.added_at } : {}),
    is_cataloged: local,
    ...(local ? { source: 'local' as const } : {}),
  };
}

function lookupKey(id: string): string {
  return canonicalAppId(id) ?? id.trim().toLowerCase();
}

function findCustomEntry(id: string): DraftEntryWire | undefined {
  const key = lookupKey(id);
  return state.customApps.find((e) => e.id.toLowerCase() === key);
}

/** `UpdateRule.is_hidden` 命中的应用 id（小写）。 */
export function hiddenAppIds(): Set<string> {
  return new Set(state.updateRules.filter((r) => r.is_hidden).map((r) => r.app_id.toLowerCase()));
}

/**
 * 统一目录视图：静态精选目录 + 未归档本地库条目（远端同 id 优先），默认剔除隐藏应用。
 * 搜索、分类、最新入库、首页、精选与相似推荐共用。
 */
export function visibleCatalogSummaries(opts: { includeHidden?: boolean } = {}): AppSummary[] {
  const remoteIds = new Set(summaries.map((s) => s.id.toLowerCase()));
  const local = state.customApps
    .filter((e) => isLocalLibraryEntry(e) && !remoteIds.has(e.id.toLowerCase()))
    .map(draftEntryToSummary);
  const merged = local.length > 0 ? [...summaries, ...local] : summaries;
  if (opts.includeHidden) return merged;
  const hidden = hiddenAppIds();
  return hidden.size > 0 ? merged.filter((s) => !hidden.has(s.id.toLowerCase())) : merged;
}

/** 收录判定（精选目录或本地库），与后端 `CatalogService::is_cataloged` 同口径。 */
export function findCatalogedSummary(id: string): AppSummary | undefined {
  const remote = findSummary(id);
  if (remote) return remote;
  const entry = findCustomEntry(id);
  return entry && isLocalLibraryEntry(entry) ? draftEntryToSummary(entry) : undefined;
}

export function isCatalogedId(id: string): boolean {
  return findCatalogedSummary(id) !== undefined;
}

/** 合法坐标的占位摘要（未收录、无图标、无平台，供详情与合集展示）。 */
export function placeholderSummary(id: string): AppSummary | undefined {
  const coord = parseCanonicalCoord(id);
  if (!coord) return undefined;
  return {
    id: coord.id,
    name: coord.repo,
    owner: coord.owner,
    repo: coord.repo,
    icon: '',
    icon_bg: DEFAULT_ICON_BG,
    description: '',
    stars: 0,
    forks: 0,
    license: '',
    latest_version: 'latest',
    category: 'external',
    category_name: '跨平台开源',
    is_verified: false,
    forge: coord.forge,
    forge_host: coord.forge_host,
    homepage: null,
    platforms: [],
    is_cataloged: false,
  };
}

/**
 * 任意卡片 id 的摘要解析：精选目录 → 本地库（含草稿行）→ 开源广场清单 → 外部趋势样本 →
 * 合法 `owner/repo` / `forge:` 坐标合成占位（`placeholder: false` 时跳过最后一步）。
 */
export function resolveAnyAppSummary(
  id: string,
  opts: { placeholder?: boolean } = {},
): AppSummary | undefined {
  if (!id.trim()) return undefined;
  const remote = findSummary(id);
  if (remote) return remote;
  const entry = findCustomEntry(id);
  if (entry) return draftEntryToSummary(entry);
  const launchpad = findLaunchpadSummary(id);
  if (launchpad) return launchpad;
  const coord = parseCanonicalCoord(id);
  if (coord && coord.forge === 'github') {
    const ext = findExternalTrend(coord.owner, coord.repo);
    if (ext) return demoExternalFallback(ext);
  }
  return opts.placeholder === false ? undefined : placeholderSummary(id);
}

// ---------------------------------------------------------------------------
// 最小化 __TAURI_INTERNALS__ 事件系统（invoke/listen/emit）
// ---------------------------------------------------------------------------

export const demoCallbacks = new Map<number, (data: unknown) => void>();
export const demoListeners = new Map<string, number[]>();
let nextCallbackId = 1;

export function demoTransformCallback(cb?: (data: unknown) => void, once = false): number {
  const id = nextCallbackId;
  nextCallbackId = nextCallbackId >= 0x7fffffff ? 1 : nextCallbackId + 1;
  demoCallbacks.set(id, (data: unknown) => {
    if (once) demoCallbacks.delete(id);
    try {
      cb?.(data);
    } catch {
      // 监听器抛错不得破坏 mock
    }
  });
  return id;
}

export function demoRunCallback(id: number, data: unknown): void {
  const fn = demoCallbacks.get(id);
  if (fn) {
    fn(data);
  } else {
    zlogWarn(`[demo-mock] missing callback ${id}`);
  }
}

export function demoUnregisterCallback(id: number): void {
  demoCallbacks.delete(id);
}

export function demoUnregisterListener(event: string, eventId: number): void {
  const list = demoListeners.get(event);
  if (list) {
    const idx = list.indexOf(eventId);
    if (idx >= 0) list.splice(idx, 1);
  }
  demoUnregisterCallback(eventId);
}

export function emitDemoEvent(event: string, payload: unknown): void {
  const ids = demoListeners.get(event) ?? [];
  for (const id of [...ids]) {
    demoRunCallback(id, { event, id, payload });
  }
}

const warned = new Set<string>();

export function warnOnce(cmd: string): void {
  if (warned.has(cmd)) return;
  warned.add(cmd);
  zlogWarn(`[demo-mock] unmocked command "${cmd}" → shape-safe fallback`);
}

export const LIST_FALLBACK = new Set([
  'search_apps',
  'search_apps_online',
  'enrich_trend_repos',
  'get_installed_apps',
  'check_for_updates',
  'get_favorites',
  'get_category_apps',
  'scan_and_match_local_apps',
  'get_update_rules',
  'get_search_history',
  'get_recently_viewed_apps',
  'get_watched_apps',
  'resolve_collection_apps',
  'sync_launchpad_discussions',
]);
