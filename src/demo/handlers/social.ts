import type {
  DeveloperProfile,
  FavoriteEntry,
  StarAppResult,
  StarredFeedCacheEntry,
  StarredPageResult,
  WatchedAppEntry,
} from '../../types';
import { summaries, findSummary } from '../fixtures';
import { getFavSet, getStarSet, getWatchSet, persistSets } from '../demoState';
import { argNum, argStr, type InvokeArgs } from './common';

export function handleGetFavorites(): string[] {
  const favSet = getFavSet();
  return summaries.filter((s) => favSet.has(s.id.toLowerCase())).map((s) => s.id);
}

// demo 同形收藏记录：收录快照命中即已收录（`findSummary` 归一口径），附当前秒级时间戳。
export function handleGetFavoriteEntries(): FavoriteEntry[] {
  const now = Math.floor(Date.now() / 1000);
  return handleGetFavorites().map((id) => ({
    app_id: id,
    is_cataloged: findSummary(id) !== undefined,
    favorited_at: now,
  }));
}

export function handleToggleFavorite(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  if (!id) return false;
  const favSet = getFavSet();
  if (favSet.has(id)) favSet.delete(id);
  else favSet.add(id);
  persistSets();
  return favSet.has(id);
}

export function handleGetWatchedApps(): WatchedAppEntry[] {
  return [...getWatchSet()].map((id) => ({ app_id: id, is_cataloged: findSummary(id) !== undefined }));
}

export function handleWatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    getWatchSet().add(id);
    persistSets();
  }
  return true;
}

export function handleUnwatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  getWatchSet().delete(id);
  persistSets();
  return true;
}

export function handleStarApp(a: InvokeArgs): StarAppResult {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    getStarSet().add(id);
    persistSets();
  }
  return { starred: true, in_list: true };
}

export function handleUnstarApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  getStarSet().delete(id);
  persistSets();
  return true;
}

export function handleFetchStarredStatus(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId').toLowerCase();
  return getStarSet().has(id);
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

/** demo Star 同步快照：内存态透存（刷新页面即清空），与后端 512 KiB 上限同口径。 */
const demoStarredFeedCache = new Map<string, StarredFeedCacheEntry & { owner_scope: string }>();
const DEMO_STARRED_FEED_MAX_BYTES = 512 * 1024;

export function handleGetStarredFeedCache(a: InvokeArgs): StarredFeedCacheEntry | null {
  const key = argStr(a, 'cacheKey').trim();
  const row = key ? demoStarredFeedCache.get(key) : undefined;
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
  demoStarredFeedCache.set(key, {
    payload_json: payload,
    cached_at: Math.floor(Date.now() / 1000),
    owner_scope: scope,
  });
  return null;
}

export function handleGetOAuthUser(): null {
  return null;
}

export function handleOAuthLogout(): boolean {
  for (const [key, row] of demoStarredFeedCache) {
    if (row.owner_scope.startsWith('@me:')) demoStarredFeedCache.delete(key);
  }
  return true;
}

export function handleOAuthDeviceStart(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}

export function handleOAuthDevicePoll(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}
