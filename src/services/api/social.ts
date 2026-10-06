import { listen } from '@tauri-apps/api/event';
import type {
  DeveloperProfile,
  HostRateLimitStatus,
  HostTokenEntry,
  OAuthDeviceStartResult,
  OAuthPollResult,
  OAuthUser,
  QuotaUpdatePayload,
  StarAppResult,
  StarredSyncResult,
  WatchUpdatedPayload,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';

export async function getFavorites(): Promise<string[]> {
  return tauriInvoke<string[]>(CMD.getFavorites);
}

export async function toggleFavorite(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.toggleFavorite, { appId });
}

export async function getDeveloperProfile(developer: string): Promise<DeveloperProfile> {
  return tauriInvoke<DeveloperProfile>(CMD.getDeveloperProfile, { developer });
}

export async function syncGithubStarred(username?: string): Promise<StarredSyncResult> {
  return tauriInvoke<StarredSyncResult>(CMD.syncGithubStarred, { username });
}

export async function getHostTokens(): Promise<HostTokenEntry[]> {
  return tauriInvoke<HostTokenEntry[]>(CMD.getHostTokens);
}

export async function setHostToken(host: string, token: string): Promise<void> {
  return tauriInvoke<void>(CMD.setHostToken, { host, token });
}

export async function removeHostToken(host: string): Promise<void> {
  return tauriInvoke<void>(CMD.removeHostToken, { host });
}

export async function onQuotaUpdated(
  callback: (payload: QuotaUpdatePayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<QuotaUpdatePayload>('zstore://quota-updated', (e) => {
    callback(e.payload);
  });
}

export async function refreshHostRateLimit(host?: string): Promise<HostTokenEntry> {
  return tauriInvoke<HostTokenEntry>(CMD.refreshHostRateLimit, { host });
}

export async function testHostConnection(host: string, token?: string): Promise<HostRateLimitStatus> {
  return tauriInvoke<HostRateLimitStatus>(CMD.testHostConnection, { host, token });
}

export async function getWatchedApps(): Promise<string[]> {
  const rows = await tauriInvoke<Array<{ app_id: string }>>(CMD.getWatchedApps);
  return rows.map((r) => r.app_id);
}

export async function watchApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.watchApp, { appId });
}

export async function unwatchApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.unwatchApp, { appId });
}

export async function onWatchUpdated(
  callback: (payload: WatchUpdatedPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<WatchUpdatedPayload>('zstore://watch-updated', (e) => {
    callback(e.payload);
  });
}

export async function onOAuthExpired(callback: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen('zstore://oauth-expired', () => {
    callback();
  });
}

export async function oauthDeviceStart(): Promise<OAuthDeviceStartResult> {
  return tauriInvoke<OAuthDeviceStartResult>(CMD.oauthDeviceStart);
}

export async function oauthDevicePoll(deviceCode: string): Promise<OAuthPollResult> {
  const raw = await tauriInvoke<{ status: string; message?: string }>(CMD.oauthDevicePoll, {
    deviceCode,
  });
  const status =
    raw.status === 'authorized'
      ? 'complete'
      : raw.status === 'expired' || raw.status === 'denied' || raw.status === 'error'
      ? raw.status
      : 'pending';
  return { status, message: raw.message } as OAuthPollResult;
}

export async function getOAuthUser(): Promise<OAuthUser | null> {
  try {
    return await tauriInvoke<OAuthUser | null>(CMD.getOAuthUser);
  } catch {
    return null;
  }
}

export async function oauthLogout(): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>(CMD.oauthLogout);
  } catch {
    return false;
  }
}

export async function starApp(appId: string): Promise<StarAppResult> {
  return tauriInvoke<StarAppResult>(CMD.starApp, { appId });
}

export async function unstarApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.unstarApp, { appId });
}

export async function isStarred(appId: string): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>(CMD.isStarred, { appId });
  } catch {
    return false;
  }
}
