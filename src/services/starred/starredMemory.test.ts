import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSummary } from '../../types';
import { clearSearchListCache, readSearchListCache, writeSearchListCache } from '../search/searchListCache';
import {
  STARRED_CACHE_NAMESPACE,
  getLastQueryMemory,
  getQueryMemory,
  isNetworkSynced,
  markNetworkSynced,
  noteStarredLogin,
  rememberQuery,
  resetStarredMemory,
  selfQueryKey,
} from './starredMemory';

const row = { id: 'acme/app' } as AppSummary;
const pageKey = (query: string) => ({ namespace: STARRED_CACHE_NAMESPACE, query, page: 1, perPage: 20 });

function seed(key: string, username?: string): void {
  rememberQuery({ target: { key, username, input: username ?? '' }, pages: 1, hasMore: false, emptyPages: [] });
  markNetworkSynced(key);
  writeSearchListCache(pageKey(key), [row]);
}

beforeEach(() => {
  resetStarredMemory();
  clearSearchListCache();
});

describe('noteStarredLogin', () => {
  it('first login and repeated reports keep private entries', () => {
    noteStarredLogin(undefined);
    noteStarredLogin('alice');
    seed(selfQueryKey('alice'));
    noteStarredLogin('alice');
    expect(getQueryMemory('@me:alice')).toBeDefined();
    expect(isNetworkSynced('@me:alice')).toBe(true);
    expect(readSearchListCache(pageKey('@me:alice'))).toBeDefined();
  });

  it('logout clears every @me entry and keeps public ones', () => {
    noteStarredLogin('alice');
    seed('octocat', 'octocat');
    seed(selfQueryKey('alice'));
    noteStarredLogin(undefined);
    expect(getQueryMemory('@me:alice')).toBeUndefined();
    expect(getLastQueryMemory()).toBeUndefined();
    expect(isNetworkSynced('@me:alice')).toBe(false);
    expect(readSearchListCache(pageKey('@me:alice'))).toBeUndefined();
    expect(getQueryMemory('octocat')).toBeDefined();
    expect(isNetworkSynced('octocat')).toBe(true);
    expect(readSearchListCache(pageKey('octocat'))).toBeDefined();
  });

  it('switching accounts clears the previous account', () => {
    noteStarredLogin('alice');
    seed(selfQueryKey('alice'));
    noteStarredLogin('bob');
    expect(getQueryMemory('@me:alice')).toBeUndefined();
  });
});

describe('logout clears private data across caches', () => {
  it('forgetPrivateStarredQueries 清 @me: 列表、含私有仓的搜索分页与私有富卡', async () => {
    const { recordSharedPrivateRepos, recordSharedRepoCards, peekFreshRepoCard } = await import(
      '../repoEnrichCache'
    );
    const { forgetPrivateStarredQueries } = await import('./starredMemory');
    const secret = { id: 'me/secret', owner: 'me', repo: 'secret', platforms: [], name: 'secret' } as unknown as AppSummary;
    const pub = { id: 'pub/tool', owner: 'pub', repo: 'tool', platforms: [], name: 'tool' } as unknown as AppSummary;
    seed(selfQueryKey('alice'));
    writeSearchListCache({ query: 'mine', page: 1, perPage: 20 }, [secret], { hasPrivate: true });
    writeSearchListCache({ query: 'pub', page: 1, perPage: 20 }, [pub]);
    recordSharedRepoCards([secret, pub]);
    recordSharedPrivateRepos(['me/secret']);

    forgetPrivateStarredQueries();

    expect(readSearchListCache(pageKey(selfQueryKey('alice')))).toBeUndefined();
    expect(readSearchListCache({ query: 'mine', page: 1, perPage: 20 })).toBeUndefined();
    expect(readSearchListCache({ query: 'pub', page: 1, perPage: 20 })?.[0].id).toBe('pub/tool');
    expect(peekFreshRepoCard('me/secret')).toBeUndefined();
    expect(peekFreshRepoCard('pub/tool')).toBeDefined();
  });
});
