import type { InstalledApp } from '../types';
import { summaries, summaryToInstalled } from './fixtures';

export const LS = {
  favorites: 'zstore:demo:favorites:v1',
  watched: 'zstore:demo:watched:v1',
  starred: 'zstore:demo:starred:v1',
  searchHistory: 'zstore:demo:search_history:v1',
  recentViews: 'zstore:demo:recent_views:v1',
  installed: 'zstore:demo:installed:v1',
  settings: 'zstore:demo:settings:v1',
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

export function lsStringArray(key: string): string[] {
  const v = lsGet<unknown>(key, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// 内存工作状态（安装时从 localStorage 注水还原）
let favSet = new Set<string>();
let watchSet = new Set<string>();
let starSet = new Set<string>();
let searchHistory: string[] = [];
let recentIds: string[] = [];
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
  lsSet(LS.installed, installedApps);
}

export function hydrate(): void {
  favSet = new Set(lsStringArray(LS.favorites).map((s) => s.toLowerCase()));
  watchSet = new Set(lsStringArray(LS.watched).map((s) => s.toLowerCase()));
  starSet = new Set(lsStringArray(LS.starred).map((s) => s.toLowerCase()));
  searchHistory = lsStringArray(LS.searchHistory).slice(0, 20);
  recentIds = lsStringArray(LS.recentViews).slice(0, 20);
  const stored = lsGet<unknown>(LS.installed, null);
  if (Array.isArray(stored) && stored.length > 0) {
    const valid = (stored as InstalledApp[]).filter((i) => typeof i?.app_id === 'string');
    installedApps = valid.slice(0, 10);
  } else {
    installedApps = summaries.slice(0, 2).map((s) => summaryToInstalled(s));
    lsSet(LS.installed, installedApps);
  }
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
    console.warn(`[demo-mock] missing callback ${id}`);
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
  console.warn(`[demo-mock] unmocked command "${cmd}" → shape-safe fallback`);
}

export const LIST_FALLBACK = new Set([
  'search_apps',
  'search_apps_online',
  'enrich_trend_repos',
  'get_installed_apps',
  'check_for_updates',
  'get_mirror_status',
  'get_favorites',
  'get_category_apps',
  'scan_and_match_local_apps',
  'get_detected_installed_app_ids',
  'get_update_rules',
  'get_search_history',
  'get_recently_viewed_apps',
  'get_host_tokens',
  'search_forge_repos',
  'get_watched_apps',
]);
