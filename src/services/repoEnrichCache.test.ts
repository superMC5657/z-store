import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../types';

vi.mock('./api', () => ({
  tauriApi: {},
  CMD: {},
}));
vi.mock('./api/catalog', () => ({
  getOrFetchIcon: vi.fn(async () => null),
}));

import {
  hydrateRowFromSharedEnrich,
  isSharedRepoConfirmedOther,
  readSharedRepoEnrich,
  recordSharedConfirmedOthers,
  recordSharedRepoPlatforms,
} from './repoEnrichCache';
import { clearTrendEnrichCache, putTrendEnrichMemory } from './trends/enrich';
import { assembleOnlineRowsWithIcons } from './search/onlineRows';

function row(id: string, patch: Partial<AppSummary> = {}): AppSummary {
  const [owner, repo] = id.split('/');
  return {
    id,
    name: repo ?? id,
    description_en: '',
    owner: owner ?? '',
    repo: repo ?? '',
    icon: '',
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
    ...patch,
  };
}

beforeEach(() => {
  clearTrendEnrichCache();
});

describe('repoEnrichCache', () => {
  it('趋势写入的具平台摘要首帧回填搜索/Star 行，并剥离 data: 与收录标注', () => {
    putTrendEnrichMemory({
      'acme/tool': row('acme/tool', {
        platforms: ['windows', 'linux'],
        latest_version: 'v2.0.0',
        icon: 'data:image/png;base64,AAAA',
        is_cataloged: false,
        source: 'remote',
        status: 'collected',
      }),
    });
    const pooled = readSharedRepoEnrich('acme/tool');
    expect(pooled?.icon).toBe('');
    expect(pooled?.is_cataloged).toBeUndefined();
    expect(pooled?.source).toBeUndefined();
    expect(pooled?.status).toBeUndefined();

    const [hydrated, untouched] = assembleOnlineRowsWithIcons(
      [],
      [row('Acme/Tool', { is_cataloged: false }), row('other/repo')],
    );
    expect(hydrated.platforms).toEqual(['windows', 'linux']);
    expect(hydrated.latest_version).toBe('v2.0.0');
    // 行自身的收录标注不受影响。
    expect(hydrated.is_cataloged).toBe(false);
    expect(untouched.platforms).toEqual([]);
  });

  it('不覆盖已有平台与真实版本，无命中保持引用', () => {
    putTrendEnrichMemory({ 'acme/tool': row('acme/tool', { platforms: ['macos'], latest_version: 'v9' }) });
    const known = row('acme/tool', { platforms: ['linux'] });
    expect(hydrateRowFromSharedEnrich(known)).toBe(known);
    const realVersion = row('acme/tool', { latest_version: 'v1.0.0' });
    const out = hydrateRowFromSharedEnrich(realVersion);
    expect(out.platforms).toEqual(['macos']);
    expect(out.latest_version).toBe('v1.0.0');
    const miss = row('nobody/here');
    expect(hydrateRowFromSharedEnrich(miss)).toBe(miss);
  });

  it('recordSharedRepoPlatforms 撤销已确认 Other，空平台行永不覆盖具平台', () => {
    recordSharedConfirmedOthers(['acme/tool']);
    expect(isSharedRepoConfirmedOther('acme/tool')).toBe(true);

    recordSharedRepoPlatforms([row('acme/tool')], new Map([['acme/tool', ['windows']]]));
    expect(isSharedRepoConfirmedOther('acme/tool')).toBe(false);
    expect(readSharedRepoEnrich('acme/tool')?.platforms).toEqual(['windows']);

    // loading 空平台写入与确认 Other 均不覆盖具平台。
    recordSharedRepoPlatforms([row('acme/tool')]);
    recordSharedConfirmedOthers(['acme/tool']);
    expect(readSharedRepoEnrich('acme/tool')?.platforms).toEqual(['windows']);
    expect(isSharedRepoConfirmedOther('acme/tool')).toBe(false);
  });

  it('未确认的空平台不入池', () => {
    recordSharedRepoPlatforms([row('empty/repo')]);
    expect(readSharedRepoEnrich('empty/repo')).toBeUndefined();
  });
});
