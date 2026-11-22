import type {
  DeveloperProfile,
  FavoriteEntry,
  StarAppResult,
  StarredFeedCacheEntry,
  StarredPageResult,
  WatchDismissedEntry,
  WatchedAppEntry,
  WatchUpdatedPayload,
} from '../../types';
import { summaries } from '../fixtures';
import { demoStore, isCatalogedId, persistDemo } from '../demoState';
import { argNum, argStr, nowSecs, warnUnknownArgs, type InvokeArgs } from './common';

/** 与后端 `user_favorites ORDER BY favorited_at DESC` 同序：最近收藏在前，未收录项照常保留。 */
export function handleGetFavorites(): string[] {
  return [...demoStore().favorites].reverse();
}

// demo 同形收藏记录：精选目录或本地库命中即已收录，附当前秒级时间戳。
export function handleGetFavoriteEntries(): FavoriteEntry[] {
  const now = nowSecs();
  return handleGetFavorites().map((id) => ({
    app_id: id,
    is_cataloged: isCatalogedId(id),
    favorited_at: now,
  }));
}

export function handleToggleFavorite(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  if (!id) return false;
  const favSet = demoStore().favorites;
  if (favSet.has(id)) favSet.delete(id);
  else favSet.add(id);
  persistDemo('favorites');
  return favSet.has(id);
}

export function handleGetWatchedApps(): WatchedAppEntry[] {
  return [...demoStore().watched].map((id) => ({ app_id: id, is_cataloged: isCatalogedId(id) }));
}

export function handleWatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    demoStore().watched.add(id);
    persistDemo('watched');
  }
  return true;
}

export function handleUnwatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  demoStore().watched.delete(id);
  persistDemo('watched');
  return true;
}

// 关注提醒挂载在关注项上，取消关注后过滤不返回。

function loadWatchNotes() {
  return demoStore().watchNotifications;
}

function isWatched(appId: string): boolean {
  return demoStore().watched.has(appId.toLowerCase());
}

export function handleGetWatchNotifications(): WatchUpdatedPayload[] {
  return loadWatchNotes()
    .pending.filter((n) => isWatched(n.app_id))
    .map((n) => ({ ...n }));
}

// 演示无网络：关注检查即读回种子中的待处理提醒。
export function handleCheckWatchedUpdates(a: InvokeArgs): WatchUpdatedPayload[] {
  warnUnknownArgs(['forceRefresh'], a, 'handleCheckWatchedUpdates');
  return handleGetWatchNotifications();
}

export function handleGetDismissedWatchNotifications(): WatchDismissedEntry[] {
  return loadWatchNotes()
    .dismissed.filter((n) => isWatched(n.app_id))
    .sort((x, y) => y.dismissed_at - x.dismissed_at)
    .map((n) => ({ ...n }));
}

export function handleDismissWatchNotification(a: InvokeArgs): boolean {
  warnUnknownArgs(['appId'], a, 'handleDismissWatchNotification');
  const id = argStr(a, 'appId').toLowerCase();
  const notes = loadWatchNotes();
  const hit = notes.pending.find((n) => n.app_id.toLowerCase() === id);
  if (!hit) return false;
  notes.pending = notes.pending.filter((n) => n !== hit);
  notes.dismissed = [
    ...notes.dismissed.filter((n) => n.app_id.toLowerCase() !== id),
    { app_id: hit.app_id, version: hit.version, dismissed_at: nowSecs() },
  ];
  persistDemo('watchNotifications');
  return true;
}

export function handleRestoreWatchNotification(a: InvokeArgs): boolean {
  warnUnknownArgs(['appId'], a, 'handleRestoreWatchNotification');
  const id = argStr(a, 'appId').toLowerCase();
  const notes = loadWatchNotes();
  const hit = notes.dismissed.find((n) => n.app_id.toLowerCase() === id);
  if (!hit) return false;
  notes.dismissed = notes.dismissed.filter((n) => n !== hit);
  notes.pending = [{ app_id: hit.app_id, version: hit.version }, ...notes.pending];
  persistDemo('watchNotifications');
  return true;
}

export function handleStarApp(a: InvokeArgs): StarAppResult {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    demoStore().starred.add(id);
    persistDemo('starred');
  }
  return { starred: true, in_list: true };
}

export function handleUnstarApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  demoStore().starred.delete(id);
  persistDemo('starred');
  return true;
}

export function handleFetchStarredStatus(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  return demoStore().starred.has(id);
}

export function handleGetDeveloperProfile(a: InvokeArgs): DeveloperProfile {
  const login = argStr(a, 'developer', 'login') || 'demo';
  return {
    login,
    avatar_url: '',
    html_url: `https://github.com/${login}`,
    public_repos: 0,
    followers: 0,
    following: 0,
    repos: [],
  };
}

/** demo Star 列表：固定取目录前 45 个当作「已 Star」，按页切片，形态与后端一致。 */
const DEMO_STARRED_TOTAL = 45;

export function handleListGithubStarred(a: InvokeArgs): StarredPageResult {
  const page = Math.max(1, Math.floor(argNum(a, 'page') ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(argNum(a, 'perPage') ?? 20)));
  const starred = summaries.slice(0, DEMO_STARRED_TOTAL);
  const start = (page - 1) * perPage;
  return {
    rows: starred.slice(start, start + perPage).map((s) => ({ ...s, is_cataloged: true })),
    has_more: start + perPage < starred.length,
  };
}

/** demo Star 同步快照：会话态透存（刷新页面即清空），与后端 64 KiB 上限同口径。 */
const DEMO_STARRED_FEED_MAX_BYTES = 64 * 1024;

export function handleGetStarredFeedCache(a: InvokeArgs): StarredFeedCacheEntry | null {
  const key = argStr(a, 'cacheKey').trim();
  const row = key ? demoStore().starredFeedCache.get(key) : undefined;
  return row ? { payload_json: row.payload_json, cached_at: row.cached_at } : null;
}

export function handleSaveStarredFeedCache(a: InvokeArgs): null {
  const key = argStr(a, 'cacheKey').trim();
  const scope = argStr(a, 'ownerScope').trim();
  const payload = argStr(a, 'payloadJson').trim();
  if (!key || !scope || !payload) return null;
  if (new TextEncoder().encode(payload).length > DEMO_STARRED_FEED_MAX_BYTES) {
    throw new Error('starred_feed_payload_too_large');
  }
  demoStore().starredFeedCache.set(key, {
    payload_json: payload,
    cached_at: Math.floor(Date.now() / 1000),
    owner_scope: scope,
  });
  return null;
}

export function handleGetOAuthUser(): null {
  return null;
}

/** 登出：清除 `@me:` 作用域的 Star 快照与含私有仓库的搜索列表快照。 */
export function handleOAuthLogout(): boolean {
  const store = demoStore();
  for (const [key, row] of store.starredFeedCache) {
    if (row.owner_scope.startsWith('@me:')) store.starredFeedCache.delete(key);
  }
  for (const [key, row] of store.searchListCache) {
    if (row.has_private) store.searchListCache.delete(key);
  }
  return true;
}

export function handleOAuthDeviceStart(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}

export function handleOAuthDevicePoll(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}
