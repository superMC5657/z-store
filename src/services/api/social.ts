import { listen } from '@tauri-apps/api/event';
import type {
  DeveloperProfile,
  FavoriteEntry,
  HostRateLimitStatus,
  HostTokenEntry,
  OAuthDeviceStartResult,
  OAuthPollResult,
  OAuthUser,
  QuotaUpdatePayload,
  StarAppResult,
  StarredSyncResult,
  WatchedAppEntry,
  WatchUpdatedPayload,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';

export async function getFavorites(): Promise<string[]> {
  return tauriInvoke<string[]>(CMD.getFavorites);
}

// 收藏记录（含收录标记）：徽标/富卡标记以记录为准；后端缺席时调用方以空数组计。
export async function getFavoriteEntries(): Promise<FavoriteEntry[]> {
  const rows = await tauriInvoke<FavoriteEntry[]>(CMD.getFavoriteEntries);
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && typeof r.app_id === 'string' && r.app_id.trim() !== '');
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

export async function getWatchedApps(): Promise<WatchedAppEntry[]> {
  const rows = await tauriInvoke<Array<{ app_id?: unknown; is_cataloged?: unknown } | string>>(
    CMD.getWatchedApps,
  );
  if (!Array.isArray(rows)) return [];
  const out: WatchedAppEntry[] = [];
  for (const r of rows) {
    const appId = typeof r === 'string' ? r : r?.app_id;
    if (typeof appId !== 'string' || appId.trim() === '') continue;
    out.push({
      app_id: appId,
      // 旧快照缺字段时默认已收录（与历史渲染一致）。
      is_cataloged:
        typeof r === 'object' && r !== null && typeof r.is_cataloged === 'boolean'
          ? r.is_cataloged
          : true,
    });
  }
  return out;
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
  if (!deviceCode || !deviceCode.trim()) {
    throw new Error('设备验证码缺失，请取消后重新点击登录');
  }
  const raw = await tauriInvoke<{ status: string; message?: string }>(CMD.oauthDevicePoll, {
    deviceCode,
  });
  const status =
    raw.status === 'authorized' ||
    raw.status === 'expired' ||
    raw.status === 'denied' ||
    raw.status === 'error'
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
