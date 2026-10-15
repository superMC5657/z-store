/**
 * 05 回归：图标就绪写透搜索列表缓存行（翻页一致性）。
 * - 同一规范应用标识的图标到达后，全部缓存条目（各页）中同 id 行即换新图，
 *   翻页回访/重搜命中即新图，不出现翻页丢图；
 * - 大小写归一（`normalizeId`，遵 ADR-0010），未知 id 即无操作；
 * - 写透不续 TTL（`at` 不动）、`ids` 不变；
 * - L5 显式空（`''`）亦写透（切徽章后回访同页即徽章，不复活旧图）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSummary } from '../../types';
import {
  clearSearchListCache,
  patchSearchListCacheIcon,
  readSearchListCache,
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
});
