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
import { tauriApi } from '../api';
import { peekFreshRepoCard } from '../repoEnrichCache';
import { clearTrendEnrichCache } from '../trends/enrich';
import {
  buildSearchListDbKey,
  clearPrivateSearchListCacheEntries,
  readDbSearchListCache,
  saveDbSearchListCache,
  SEARCH_LIST_FRESH_MS,
  SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE,
  SEARCH_LIST_TTL_MS,
  clearSearchListCache,
  clearSearchListCacheNamespace,
  findInSearchListCache,
  readSearchListCacheEntry,
  patchSearchListCacheIcon,
  patchSearchListCacheRows,
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

    expect(readSearchListCacheEntry({ query: 'q', page: 1, perPage: 12 })?.rows[0].icon).toBe(REAL);
    expect(readSearchListCacheEntry({ query: 'q', page: 2, perPage: 12 })?.rows[0].icon).toBe(REAL);
    // 同条目他行不动。
    expect(readSearchListCacheEntry({ query: 'q', page: 1, perPage: 12 })?.rows[1].icon).toBe('');
    // 未知 id 无操作（不抛错、不改行）。
    patchSearchListCacheIcon('o/missing', REAL);
    expect(readSearchListCacheEntry({ query: 'q', page: 2, perPage: 12 })?.rows[1].icon).toBe('');
  });

  it('大小写归一命中（`O/R` 写透 `o/r` 行）', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 12 }, [row('o/r', '')]);
    patchSearchListCacheIcon('O/R', REAL);
    expect(readSearchListCacheEntry({ query: 'q', page: 1, perPage: 12 })?.rows[0].icon).toBe(REAL);
  });

  it('L5 显式空写透（旧实图行即徽章，不复活）', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 12 }, [row('o/r', REAL)]);
    patchSearchListCacheIcon('o/r', '');
    expect(readSearchListCacheEntry({ query: 'q', page: 1, perPage: 12 })?.rows[0].icon).toBe('');
  });

  it('patchSearchListCacheRows 同步写透缓存并通知活跃订阅者', () => {
    writeSearchListCache({ namespace: 'starred', query: 'u', page: 1, perPage: 20 }, [row('o/r', '')]);
    const listener = vi.fn();
    const unsub = subscribeSearchListCachePatches(listener);

    const patcher = (rows: AppSummary[]) =>
      rows.map((r) => (r.id === 'o/r' ? { ...r, platforms: ['linux'] } : r));
    patchSearchListCacheRows(patcher);

    expect(
      readSearchListCacheEntry({ namespace: 'starred', query: 'u', page: 1, perPage: 20 })?.rows[0].platforms,
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
      expect(readSearchListCacheEntry({ query: 'q', page: p, perPage: 20 })).toBeDefined();
    }
    for (let p = 1; p <= 10; p += 1) {
      expect(
        readSearchListCacheEntry({ namespace: 'starred', query: 'alice', page: p, perPage: 20 }),
      ).toBeUndefined();
    }
    for (let p = 11; p <= 60; p += 1) {
      expect(
        readSearchListCacheEntry({ namespace: 'starred', query: 'alice', page: p, perPage: 20 }),
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
      readSearchListCacheEntry({ namespace: 'starred', query: '@me:alice', page: 1, perPage: 20 }),
    ).toBeUndefined();
    expect(
      readSearchListCacheEntry({ namespace: 'starred', query: 'torvalds', page: 1, perPage: 20 }),
    ).toBeDefined();
    expect(readSearchListCacheEntry({ query: '@me:alice', page: 1, perPage: 20 })).toBeDefined();
    clearSearchListCacheNamespace('starred');
    expect(
      readSearchListCacheEntry({ namespace: 'starred', query: 'torvalds', page: 1, perPage: 20 }),
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

describe('slim id index', () => {
  beforeEach(() => {
    clearTrendEnrichCache();
  });

  it('L1 条目只记有序 id 与 hasMore，同 id 卡片单份共享并写入共享富卡镜像', () => {
    writeSearchListCache({ query: 'q', page: 1, perPage: 2 }, [row('O/R', ''), row('o/b', '')]);
    writeSearchListCache({ query: 'q', page: 2, perPage: 2 }, [row('o/r', '')], { hasMore: false });
    const p1 = readSearchListCacheEntry({ query: 'q', page: 1, perPage: 2 });
    expect(p1?.ids).toEqual(['o/r', 'o/b']);
    expect(p1?.hasMore).toBe(true);
    const p2 = readSearchListCacheEntry({ query: 'q', page: 2, perPage: 2 });
    expect(p2?.hasMore).toBe(false);
    expect(p1?.rows[0]).toBe(p2?.rows[0]);
    expect(peekFreshRepoCard('o/r')).toBeDefined();
  });

  it('clearPrivateSearchListCacheEntries 只清含私有仓的搜索分页', () => {
    writeSearchListCache({ query: 'mine', page: 1, perPage: 12 }, [row('me/secret', '')], { hasPrivate: true });
    writeSearchListCache({ query: 'pub', page: 1, perPage: 12 }, [row('o/r', '')]);
    clearPrivateSearchListCacheEntries();
    expect(readSearchListCacheEntry({ query: 'mine', page: 1, perPage: 12 })).toBeUndefined();
    expect(readSearchListCacheEntry({ query: 'pub', page: 1, perPage: 12 })?.rows[0].id).toBe('o/r');
    expect(findInSearchListCache('me/secret')).toBeUndefined();
  });
});

describe('L2 search_list_cache', () => {
  const api = tauriApi as unknown as {
    getSearchListCache: (k: string) => Promise<{ payload_json: string; cached_at: number } | null>;
    saveSearchListCache: (k: string, q: string, p: string, h?: boolean) => Promise<void>;
  };

  it('buildSearchListDbKey 归一词 + 页码 + 页大小', () => {
    expect(buildSearchListDbKey('  Rust   GUI ', 2, 20)).toEqual({
      cacheKey: 'rust gui|2|20',
      normQuery: 'rust gui',
    });
  });

  it('saveDbSearchListCache 写 { v: 2, ids, hasMore } 并可往返读出', async () => {
    const store = new Map<string, { payload_json: string; cached_at: number }>();
    const save = vi
      .spyOn(api, 'saveSearchListCache')
      .mockImplementation(async (k: string, _q: string, p: string) => {
        store.set(k, { payload_json: p, cached_at: Math.floor(Date.now() / 1000) });
      });
    vi.spyOn(api, 'getSearchListCache').mockImplementation(async (k: string) => store.get(k) ?? null);
    const key = { query: 'Rust', page: 1, perPage: 20 };
    await saveDbSearchListCache(key, ['A/B', 'a/b', 'c/d'], true, true);
    expect(save).toHaveBeenCalledWith('rust|1|20', 'rust', expect.any(String), true);
    const payload = JSON.parse(save.mock.calls[0][2]);
    expect(payload).toEqual({ v: 2, ids: ['a/b', 'c/d'], hasMore: true });
    const hit = await readDbSearchListCache(key);
    expect(hit?.ids).toEqual(['a/b', 'c/d']);
    expect(hit?.hasMore).toBe(true);
    expect(hit?.isFresh).toBe(true);
    expect(hit?.withinTtl).toBe(true);
    // 空 id 不写。
    save.mockClear();
    await saveDbSearchListCache(key, [], false);
    expect(save).not.toHaveBeenCalled();
  });

  it('readDbSearchListCache 拒绝旧格式、未来时间戳，过期快照仅 allowStale 返回', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const rows: Record<string, { payload_json: string; cached_at: number }> = {
      'v1|1|20': { payload_json: JSON.stringify({ v: 1, rows: [] }), cached_at: nowSecs },
      'future|1|20': { payload_json: JSON.stringify({ v: 2, ids: ['a/b'], hasMore: false }), cached_at: nowSecs + 3600 },
      'old|1|20': { payload_json: JSON.stringify({ v: 2, ids: ['a/b'], hasMore: false }), cached_at: nowSecs - 3600 },
    };
    vi.spyOn(api, 'getSearchListCache').mockImplementation(async (k: string) => rows[k] ?? null);
    expect(await readDbSearchListCache({ query: 'v1', page: 1, perPage: 20 })).toBeUndefined();
    expect(await readDbSearchListCache({ query: 'future', page: 1, perPage: 20 })).toBeUndefined();
    expect(await readDbSearchListCache({ query: 'old', page: 1, perPage: 20 })).toBeUndefined();
    const stale = await readDbSearchListCache({ query: 'old', page: 1, perPage: 20 }, { allowStale: true });
    expect(stale?.ids).toEqual(['a/b']);
    expect(stale?.isFresh).toBe(false);
    expect(stale?.withinTtl).toBe(false);
  });
});
