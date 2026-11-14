/**
 * 05 回归：图标就绪写透搜索列表缓存行（翻页一致性）。
 * - 同一规范应用标识的图标到达后，全部缓存条目（各页）中同 id 行即换新图，
 *   翻页回访/重搜命中即新图，不出现翻页丢图；
 * - 大小写归一（`normalizeId`，遵 ADR-0010），未知 id 即无操作；
 * - 写透不续 TTL（`at` 不动）、`ids` 不变；
 * - L5 显式空（`''`）亦写透（切徽章后回访同页即徽章，不复活旧图）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../../types';
import {
  SEARCH_LIST_FRESH_MS,
  SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE,
  SEARCH_LIST_TTL_MS,
  clearSearchListCache,
  clearSearchListCacheNamespace,
  findInSearchListCache,
  readSearchListCacheEntry,
  touchSearchListCache,
  patchSearchListCacheIcon,
  patchSearchListCacheRows,
  readSearchListCache,
  subscribeSearchListCachePatches,
  writeSearchListCache,
} from './searchListCache';

function row(id: string, icon: string): AppSummary {
  return {
    id,
    name: id,
    description_en: '',
    owner: id.split('/')[0] ?? '',
    repo: id.split('/')[1] ?? '',
    icon,
    icon_bg: '',
    description: '',
    stars: 0,
    forks: 0,
    license: '',
    latest_version: 'latest',
    category: 'external',
    category_name: '',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
  };
}

const REAL = 'https://cdn.simpleicons.org/r';

beforeEach(() => {
  clearSearchListCache();
});

describe('patchSearchListCacheIcon', () => {
  it('写透全部条目中同 id 行（跨页一致），未知 id 无操作', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 12 }, [row('o/r', ''), row('o/other', '')]);
    writeSearchListCache({ query: 'q', page: 2, perPage: 12 }, [row('o/r', ''), row('o/third', '')]);

    patchSearchListCacheIcon('o/r', REAL);

    expect(readSearchListCache({ query: 'q', page: 1, perPage: 12 })?.[0].icon).toBe(REAL);
    expect(readSearchListCache({ query: 'q', page: 2, perPage: 12 })?.[0].icon).toBe(REAL);
    // 同条目他行不动。
    expect(readSearchListCache({ query: 'q', page: 1, perPage: 12 })?.[1].icon).toBe('');
    // 未知 id 无操作（不抛错、不改行）。
    patchSearchListCacheIcon('o/missing', REAL);
    expect(readSearchListCache({ query: 'q', page: 2, perPage: 12 })?.[1].icon).toBe('');
  });

  it('大小写归一命中（`O/R` 写透 `o/r` 行）', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 12 }, [row('o/r', '')]);
    patchSearchListCacheIcon('O/R', REAL);
    expect(readSearchListCache({ query: 'q', page: 1, perPage: 12 })?.[0].icon).toBe(REAL);
  });

  it('L5 显式空写透（旧实图行即徽章，不复活）', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 12 }, [row('o/r', REAL)]);
    patchSearchListCacheIcon('o/r', '');
    expect(readSearchListCache({ query: 'q', page: 1, perPage: 12 })?.[0].icon).toBe('');
  });

  it('patchSearchListCacheRows 同步写透缓存并通知活跃订阅者', () => {
    writeSearchListCache({ namespace: 'starred', query: 'u', page: 1, perPage: 20 }, [row('o/r', '')]);
    const listener = vi.fn();
    const unsub = subscribeSearchListCachePatches(listener);

    const patcher = (rows: AppSummary[]) =>
      rows.map((r) => (r.id === 'o/r' ? { ...r, platforms: ['linux'] } : r));
    patchSearchListCacheRows(patcher);

    expect(
      readSearchListCache({ namespace: 'starred', query: 'u', page: 1, perPage: 20 })?.[0].platforms,
    ).toEqual(['linux']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    patchSearchListCacheRows(patcher);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('findInSearchListCache 按归一 id 查找未过期摘要（支持 starred 命名空间）', () => {
    const r = { ...row('Acme/StarTool', REAL), stars: 321, description: 'starred desc' };
    writeSearchListCache({ namespace: 'starred', query: 'octocat', page: 1, perPage: 20 }, [r]);

    expect(findInSearchListCache('acme/startool')?.stars).toBe(321);
    expect(findInSearchListCache('ACME/STARTOOL', 'starred')?.description).toBe('starred desc');
    expect(findInSearchListCache('acme/startool', 'search')).toBeUndefined();
  });
});

describe('namespace buckets and freshness tiers', () => {
  it('starred 写满 60 条只淘汰 starred 自身，search 条目完整保留', () => {
    for (let p = 1; p <= 5; p += 1) {
      writeSearchListCache({ query: 'q', page: p, perPage: 20 }, [row(`s/${p}`, '')]);
    }
    for (let p = 1; p <= 60; p += 1) {
      writeSearchListCache({ namespace: 'starred', query: 'alice', page: p, perPage: 20 }, [
        row(`a/${p}`, ''),
      ]);
    }
    for (let p = 1; p <= 5; p += 1) {
      expect(readSearchListCache({ query: 'q', page: p, perPage: 20 })).toBeDefined();
    }
    for (let p = 1; p <= 10; p += 1) {
      expect(
        readSearchListCache({ namespace: 'starred', query: 'alice', page: p, perPage: 20 }),
      ).toBeUndefined();
    }
    for (let p = 11; p <= 60; p += 1) {
      expect(
        readSearchListCache({ namespace: 'starred', query: 'alice', page: p, perPage: 20 }),
      ).toBeDefined();
    }
    expect(SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE).toBe(50);
  });

  it('readSearchListCacheEntry 报告 5min 新鲜、5–30min 可用、30min 或时钟回拨驱逐', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
      const key = { query: 'rustdesk', page: 1, perPage: 20 };
      writeSearchListCache(key, [row('o/r', '')]);
      expect(readSearchListCacheEntry(key)?.isFresh).toBe(true);
      vi.setSystemTime(Date.now() + SEARCH_LIST_FRESH_MS - 1);
      expect(readSearchListCacheEntry(key)?.isFresh).toBe(true);
      vi.setSystemTime(Date.now() + 2);
      const stale = readSearchListCacheEntry(key);
      expect(stale?.isFresh).toBe(false);
      expect(stale?.rows).toHaveLength(1);
      // 续期后回到新鲜。
      touchSearchListCache(key);
      expect(readSearchListCacheEntry(key)?.isFresh).toBe(true);
      vi.setSystemTime(Date.now() + SEARCH_LIST_TTL_MS);
      expect(readSearchListCacheEntry(key)).toBeUndefined();

      writeSearchListCache(key, [row('o/r', '')]);
      vi.setSystemTime(Date.now() - 1000);
      expect(readSearchListCacheEntry(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearSearchListCacheNamespace('starred', '@me:') 只清私有条目", () => {
    writeSearchListCache({ namespace: 'starred', query: '@me:alice', page: 1, perPage: 20 }, [
      row('o/1', ''),
    ]);
    writeSearchListCache({ namespace: 'starred', query: 'torvalds', page: 1, perPage: 20 }, [
      row('o/2', ''),
    ]);
    writeSearchListCache({ query: '@me:alice', page: 1, perPage: 20 }, [row('o/3', '')]);
    clearSearchListCacheNamespace('starred', '@me:');
    expect(
      readSearchListCache({ namespace: 'starred', query: '@me:alice', page: 1, perPage: 20 }),
    ).toBeUndefined();
    expect(
      readSearchListCache({ namespace: 'starred', query: 'torvalds', page: 1, perPage: 20 }),
    ).toBeDefined();
    expect(readSearchListCache({ query: '@me:alice', page: 1, perPage: 20 })).toBeDefined();
    clearSearchListCacheNamespace('starred');
    expect(
      readSearchListCache({ namespace: 'starred', query: 'torvalds', page: 1, perPage: 20 }),
    ).toBeUndefined();
  });

  it('findInSearchListCache 可限定命名空间', () => {
    writeSearchListCache({ namespace: 'starred', query: 'alice', page: 1, perPage: 20 }, [
      row('o/only-starred', ''),
    ]);
    expect(findInSearchListCache('o/only-starred')).toBeDefined();
    expect(findInSearchListCache('o/only-starred', 'starred')).toBeDefined();
    expect(findInSearchListCache('o/only-starred', 'search')).toBeUndefined();
  });
});
