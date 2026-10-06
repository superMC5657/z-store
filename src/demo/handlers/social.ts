import type {
  DeveloperProfile,
  HostRateLimitStatus,
  HostTokenEntry,
  StarAppResult,
  StarredSyncResult,
} from '../../types';
import { summaries } from '../fixtures';
import { getFavSet, getStarSet, getWatchSet, persistSets } from '../demoState';
import { argStr, type InvokeArgs } from './common';

export function handleGetFavorites(): string[] {
  const favSet = getFavSet();
  return summaries.filter((s) => favSet.has(s.id.toLowerCase())).map((s) => s.id);
}

export function handleToggleFavorite(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  if (!id) return false;
  const favSet = getFavSet();
  if (favSet.has(id)) favSet.delete(id);
  else favSet.add(id);
  persistSets();
  return favSet.has(id);
}

export function handleGetWatchedApps(): Array<{ app_id: string }> {
  return [...getWatchSet()].map((id) => ({ app_id: id }));
}

export function handleWatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  if (id) {
    getWatchSet().add(id);
    persistSets();
  }
  return true;
}

export function handleUnwatchApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  getWatchSet().delete(id);
  persistSets();
  return true;
}

export function handleStarApp(a: InvokeArgs): StarAppResult {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  if (id) {
    getStarSet().add(id);
    persistSets();
  }
  return { starred: true, in_list: true };
}

export function handleUnstarApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  getStarSet().delete(id);
  persistSets();
  return true;
}

export function handleIsStarred(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
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

export function handleSyncGithubStarred(): StarredSyncResult {
  return { total_starred: 0, catalog_matches: [], other_repos: [] };
}

export function handleGetHostTokens(): HostTokenEntry[] {
  return [];
}

export function handleSetHostToken(): null {
  return null;
}

export function handleRemoveHostToken(): null {
  return null;
}

export function handleRefreshHostRateLimit(a: InvokeArgs): HostTokenEntry {
  const host = argStr(a, 'host') || 'github.com';
  return { host, token: '', updated_at: Math.floor(Date.now() / 1000) };
}

export function handleTestHostConnection(a: InvokeArgs): HostRateLimitStatus {
  const host = argStr(a, 'host') || 'github.com';
  return { host, is_connected: false, message: 'demo' };
}

export function handleGetOAuthUser(): null {
  return null;
}

export function handleOAuthLogout(): boolean {
  return true;
}

export function handleOAuthDeviceStart(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}

export function handleOAuthDevicePoll(): never {
  throw new Error('demo: GitHub OAuth is disabled in the live demo');
}
