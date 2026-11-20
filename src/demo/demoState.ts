import type { InstalledApp } from '../types';
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
} from './seed';
import { nowSecs } from './handlers/common';
import { zlogWarn } from '../lib/z-log';

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

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown): void {
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

function lsStringArray(key: string): string[] {
  const v = lsGet<unknown>(key, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// 内存工作状态（安装时从 localStorage 注水还原）
let favSet = new Set<string>();
let watchSet = new Set<string>();
let starSet = new Set<string>();
let searchHistory: string[] = [];
let recentIds: string[] = [];
let recentViewTimes: Record<string, number> = {};
let installedApps: InstalledApp[] = [];
let demoSettingsSaved: Record<string, string> = {};
export const iconLevel = new Map<string, number>();

export function getFavSet(): Set<string> {
  return favSet;
}

export function getWatchSet(): Set<string> {
  return watchSet;
}

export function getStarSet(): Set<string> {
  return starSet;
}

export function getSearchHistory(): string[] {
  return searchHistory;
}

export function setSearchHistory(list: string[]): void {
  searchHistory = list;
}

export function getRecentIds(): string[] {
  return recentIds;
}

export function setRecentIds(list: string[]): void {
  recentIds = list;
}

export function getRecentViewTimes(): Record<string, number> {
  return recentViewTimes;
}

export function setRecentViewTime(id: string, ts: number): void {
  recentViewTimes = { ...recentViewTimes, [id.toLowerCase()]: ts };
}

export function getInstalledApps(): InstalledApp[] {
  return installedApps;
}

export function setInstalledApps(apps: InstalledApp[]): void {
  installedApps = apps;
}

export function getDemoSettingsSaved(): Record<string, string> {
  return demoSettingsSaved;
}

export function persistSets(): void {
  lsSet(LS.favorites, [...favSet]);
  lsSet(LS.watched, [...watchSet]);
  lsSet(LS.starred, [...starSet]);
  lsSet(LS.searchHistory, searchHistory);
  lsSet(LS.recentViews, recentIds);
  lsSet(LS.recentViewTimes, recentViewTimes);
  lsSet(LS.installed, installedApps);
}

export function hydrate(): void {
  seedFirstVisit();
  favSet = new Set(lsStringArray(LS.favorites).map((s) => s.toLowerCase()));
  watchSet = new Set(lsStringArray(LS.watched).map((s) => s.toLowerCase()));
  starSet = new Set(lsStringArray(LS.starred).map((s) => s.toLowerCase()));
  searchHistory = lsStringArray(LS.searchHistory).slice(0, 20);
  recentIds = lsStringArray(LS.recentViews).slice(0, 30);
  const storedTimes = lsGet<unknown>(LS.recentViewTimes, null);
  if (storedTimes && typeof storedTimes === 'object' && !Array.isArray(storedTimes)) {
    const parsed: Record<string, number> = {};
    for (const [k, v] of Object.entries(storedTimes as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        parsed[k.toLowerCase()] = Math.floor(v);
      }
    }
    recentViewTimes = parsed;
  } else {
    recentViewTimes = {};
  }
  const stored = lsGet<unknown>(LS.installed, []);
  installedApps = Array.isArray(stored)
    ? (stored as InstalledApp[]).filter((i) => typeof i?.app_id === 'string')
    : [];
  try {
    const s = lsGet<unknown>(LS.settings, null);
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      demoSettingsSaved = Object.fromEntries(
        Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    } else {
      demoSettingsSaved = {};
    }
  } catch {
    demoSettingsSaved = {};
  }
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
  'sync_launchpad_discussions',
]);
