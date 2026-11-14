import { listen } from '@tauri-apps/api/event';
import type {
  DeveloperProfile,
  FavoriteEntry,
  OAuthDeviceStartResult,
  OAuthPollResult,
  OAuthUser,
  StarAppResult,
  StarredFeedCacheEntry,
  StarredPageResult,
  WatchDismissedEntry,
  WatchedAppEntry,
  WatchUpdatedPayload,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';
import { isCatalogedFailClosed } from '../../utils/appHelper';

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

// Star 列表单页：`username` 缺省即当前登录账号（含私有 Star）；缺字段回包按空页计。
// 后端走 ETag 条件请求（未变 304 零配额）；`forceRefresh` 为手动同步透传位。
export async function listGithubStarred(
  username: string | undefined,
  page: number,
  perPage: number,
  forceRefresh = false,
): Promise<StarredPageResult> {
  const res = await tauriInvoke<StarredPageResult>(CMD.listGithubStarred, {
    username,
    page,
    perPage,
    forceRefresh,
  });
  const out: StarredPageResult = {
    rows: Array.isArray(res?.rows) ? res.rows : [],
    has_more: res?.has_more === true,
  };
  if (res?.is_stale === true) out.is_stale = true;
  const pickIds = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
  const confirmedOther = pickIds(res?.confirmed_other_ids);
  if (confirmedOther.length > 0) out.confirmed_other_ids = confirmedOther;
  const privateIds = pickIds(res?.private_ids);
  if (privateIds.length > 0) out.private_ids = privateIds;
  return out;
}

// Star 同步快照读：后端缺席或形态不符时按未命中计。
export async function getStarredFeedCache(cacheKey: string): Promise<StarredFeedCacheEntry | null> {
  const row = await tauriInvoke<StarredFeedCacheEntry | null>(CMD.getStarredFeedCache, { cacheKey });
  if (!row || typeof row.payload_json !== 'string' || typeof row.cached_at !== 'number') return null;
  return row;
}

// Star 同步快照写：`ownerScope` 以 `@me:` 开头的快照随登出清除。
export async function saveStarredFeedCache(
  cacheKey: string,
  ownerScope: string,
  payloadJson: string,
): Promise<void> {
  await tauriInvoke(CMD.saveStarredFeedCache, { cacheKey, ownerScope, payloadJson });
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
      // 读值语义见 isCatalogedFailClosed（utils/appHelper）。
      is_cataloged: isCatalogedFailClosed(
        (r as unknown as { is_cataloged?: unknown } | null)?.is_cataloged,
      ),
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

// 待处理的关注提醒（后端持久化，重启后可读回）；后端缺席时以空数组计。
export async function getWatchNotifications(): Promise<WatchUpdatedPayload[]> {
  const rows = await tauriInvoke<WatchUpdatedPayload[]>(CMD.getWatchNotifications);
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r) => r && typeof r.app_id === 'string' && r.app_id.trim() !== '' && typeof r.version === 'string',
  );
}

export async function dismissWatchNotification(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.dismissWatchNotification, { appId });
}

// 已确认的关注提醒（规则管理「关注已读」）；后端缺席时以空数组计。
export async function getDismissedWatchNotifications(): Promise<WatchDismissedEntry[]> {
  const rows = await tauriInvoke<WatchDismissedEntry[]>(CMD.getDismissedWatchNotifications);
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r) => r && typeof r.app_id === 'string' && r.app_id.trim() !== '' && typeof r.version === 'string',
  );
}

export async function restoreWatchNotification(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.restoreWatchNotification, { appId });
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

export async function fetchStarredStatus(appId: string): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>(CMD.fetchStarredStatus, { appId });
  } catch {
    return false;
  }
}
