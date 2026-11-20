/** Star 同步会话内存：记录查询进度、本会话网络同步状态，并在登出/换号时清理私有条目。 */
import { clearPrivateSharedRepoCards } from '../repoEnrichCache';
import {
  clearPrivateSearchListCacheEntries,
  clearSearchListCacheNamespace,
} from '../search/searchListCache';

/** 分页缓存命名空间。 */
export const STARRED_CACHE_NAMESPACE = 'starred';
/** 查自己（含私有 Star）的查询键前缀，后接小写登录名。 */
const PRIVATE_QUERY_PREFIX = '@me:';

/** 一次查询：`username` 缺省即查登录账号（`/user/starred`，含私有 Star）；`input` 为当时输入框原文。 */
export interface StarredTarget {
  username?: string;
  key: string;
  input: string;
}

/** 一次查询的进度（切页/切目标回来据此从分页缓存恢复）。 */
export interface StarredQueryMemory {
  target: StarredTarget;
  pages: number;
  hasMore: boolean;
  /** 空页不进分页缓存，恢复时据此跳过。 */
  emptyPages: number[];
}

/** 最近查询过的目标（按查询键，最多 15 个，FIFO）。 */
const MAX_QUERY_MEMORIES = 15;
const queryMemories = new Map<string, StarredQueryMemory>();
let lastQueryKey: string | null = null;
/** 本次会话内与 GitHub 同步过的查询键：只有这些目标的结果写透 L2 快照（未经网络的快照不续期）。 */
const networkSyncedKeys = new Set<string>();
/** 最近一次见到的登录名（`undefined` 为未登录或尚未加载）。 */
let lastSeenLogin: string | undefined;

/** 查自己的缓存键绑定登录名：换账号后不会读到上个账号的私有 Star。 */
export function selfQueryKey(login: string): string {
  return `${PRIVATE_QUERY_PREFIX}${login.toLowerCase()}`;
}

function isPrivateKey(key: string): boolean {
  return key.startsWith(PRIVATE_QUERY_PREFIX);
}

export function rememberQuery(memory: StarredQueryMemory): void {
  const key = memory.target.key;
  queryMemories.delete(key);
  queryMemories.set(key, memory);
  while (queryMemories.size > MAX_QUERY_MEMORIES) {
    const oldest = queryMemories.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) break;
    queryMemories.delete(oldest);
  }
  lastQueryKey = key;
}

export function getQueryMemory(key: string): StarredQueryMemory | undefined {
  return queryMemories.get(key);
}

export function getLastQueryMemory(): StarredQueryMemory | undefined {
  return lastQueryKey ? queryMemories.get(lastQueryKey) : undefined;
}

export function markNetworkSynced(key: string): void {
  networkSyncedKeys.add(key);
}

export function isNetworkSynced(key: string): boolean {
  return networkSyncedKeys.has(key);
}

/** 清除所有 `@me:` 私有查询记忆及关联的私有缓存条目。 */
export function forgetPrivateStarredQueries(): void {
  clearSearchListCacheNamespace(STARRED_CACHE_NAMESPACE, PRIVATE_QUERY_PREFIX);
  clearPrivateSearchListCacheEntries();
  clearPrivateSharedRepoCards();
  for (const key of [...queryMemories.keys()]) {
    if (isPrivateKey(key)) queryMemories.delete(key);
  }
  for (const key of [...networkSyncedKeys]) {
    if (isPrivateKey(key)) networkSyncedKeys.delete(key);
  }
  if (lastQueryKey !== null && isPrivateKey(lastQueryKey)) lastQueryKey = null;
}

/** App 报告当前登录名：与上次见到的已登录账号不同（登出或换账号）即清私有查询；重复报告同一值无副作用。 */
export function noteStarredLogin(login: string | undefined): void {
  const prev = lastSeenLogin;
  lastSeenLogin = login;
  if (prev && prev !== login) forgetPrivateStarredQueries();
}

/** 测试用：清掉全部会话内存。 */
export function resetStarredMemory(): void {
  queryMemories.clear();
  lastQueryKey = null;
  networkSyncedKeys.clear();
  lastSeenLogin = undefined;
}
