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
  clearPrivateSharedRepoCards,
  hasSettledRepoPlatforms,
  healSummaryPlaceholders,
  hydrateCardsByIds,
  hydrateRowFromSharedEnrich,
  isSharedRepoConfirmedOther,
  peekFreshRepoCard,
  readSharedRepoEnrich,
  recordSharedConfirmedOthers,
  recordSharedPrivateRepos,
  recordSharedRepoCards,
  recordSharedRepoPlatforms,
  subscribeRepoCardHeals,
  upsertRepoCardFromDetail,
  type RepoCardHeal,
} from './repoEnrichCache';
import { tauriApi } from './api';
import { getBufferedIcon } from './iconStore';
import { clearTrendEnrichCache, putTrendEnrichMemory } from './trends/enrich';
import type { AppDetail, HydratedRepoCard } from '../types';
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

describe('三态单仓富卡镜像', () => {
  it('平台未知 / 已确认 Other / 具平台三态均入池，剥离 data: 与收录标注', () => {
    recordSharedRepoCards([
      row('acme/unknown', { description: 'Unknown tool', icon: 'data:image/png;base64,AA', source: 'remote' }),
      row('acme/other', { description: 'Other tool' }),
      row('acme/win', { platforms: ['windows'], latest_version: 'v1.0.0' }),
    ]);
    recordSharedConfirmedOthers(['acme/other']);

    const unknown = peekFreshRepoCard('acme/unknown');
    expect(unknown?.description).toBe('Unknown tool');
    expect(unknown?.icon).toBe('');
    expect(unknown?.source).toBeUndefined();
    expect(getBufferedIcon('acme/unknown')).toBe('data:image/png;base64,AA');
    expect(hasSettledRepoPlatforms('acme/unknown')).toBe(false);
    expect(hasSettledRepoPlatforms('acme/other')).toBe(true);
    expect(isSharedRepoConfirmedOther('acme/other')).toBe(true);
    expect(readSharedRepoEnrich('acme/win')?.platforms).toEqual(['windows']);
  });

  it('未知平台与占位字段写入不覆盖已有具平台、真实版本与简介', () => {
    recordSharedRepoCards([
      row('acme/win', {
        platforms: ['windows'],
        latest_version: 'v1.0.0',
        description: 'Real desc',
        license: 'MIT',
      }),
    ]);
    recordSharedRepoCards([row('acme/win', { description: '开源软件项目', license: '', stars: 99 })]);
    const card = peekFreshRepoCard('acme/win');
    expect(card?.platforms).toEqual(['windows']);
    expect(card?.latest_version).toBe('v1.0.0');
    expect(card?.description).toBe('Real desc');
    expect(card?.license).toBe('MIT');
    expect(card?.stars).toBe(99);
  });

  it('收录卡不入池', () => {
    recordSharedRepoCards([row('acme/curated', { is_cataloged: true, platforms: ['linux'] })]);
    expect(peekFreshRepoCard('acme/curated')).toBeUndefined();
  });

  it('裸壳行从池内卡片补简介、协议与图标，无可改进保持引用', () => {
    recordSharedRepoCards([
      row('acme/tool', {
        description: 'Pooled desc',
        license: 'Apache-2.0',
        icon: 'https://example.com/i.png',
      }),
    ]);
    const bare = row('acme/tool', { description: '开源软件项目', license: 'OpenSource' });
    const out = hydrateRowFromSharedEnrich(bare);
    expect(out).not.toBe(bare);
    expect(out.description).toBe('Pooled desc');
    expect(out.license).toBe('Apache-2.0');
    expect(out.icon).toBe('https://example.com/i.png');
    const rich = row('acme/tool', {
      description: 'Own desc',
      description_en: 'Own desc',
      license: 'MIT',
      homepage: 'https://own.example',
      icon: 'https://example.com/own.png',
    });
    expect(hydrateRowFromSharedEnrich(rich)).toBe(rich);
  });

  it('clearPrivateSharedRepoCards 只清私有仓库', () => {
    recordSharedRepoCards([row('me/secret', { description: 's' }), row('pub/tool', { description: 'p' })]);
    recordSharedConfirmedOthers(['me/secret']);
    recordSharedPrivateRepos(['Me/Secret']);
    clearPrivateSharedRepoCards();
    expect(peekFreshRepoCard('me/secret')).toBeUndefined();
    expect(isSharedRepoConfirmedOther('me/secret')).toBe(false);
    expect(peekFreshRepoCard('pub/tool')?.description).toBe('p');
  });
});

describe('hydrateCardsByIds', () => {
  const api = tauriApi as unknown as {
    getRepoCardsBatch?: (ids: string[]) => Promise<(HydratedRepoCard | null)[]>;
  };

  function card(
    id: string,
    patch: Partial<HydratedRepoCard> = {},
    summary: Partial<AppSummary> = {},
  ): HydratedRepoCard {
    return {
      summary: row(id, { description: `${id} desc`, ...summary }),
      confirmed_other: false,
      updated_at: Math.floor(Date.now() / 1000),
      ...patch,
    };
  }

  it('M1 热命中零 IPC，目录优先，按入参顺序返回', async () => {
    const batch = vi.fn(async () => [] as (HydratedRepoCard | null)[]);
    api.getRepoCardsBatch = batch;
    recordSharedRepoCards([row('acme/warm', { description: 'warm' })]);
    const curated = row('acme/curated', { description: 'curated', is_cataloged: true });
    const out = await hydrateCardsByIds(['acme/warm', 'ACME/Curated', 'acme/warm'], {
      catalogApps: [curated],
    });
    expect(batch).not.toHaveBeenCalled();
    expect(out.rows.map((r) => r.id)).toEqual(['acme/warm', 'acme/curated']);
    expect(out.byId.get('acme/curated')?.description).toBe('curated');
    expect(out.freshCardIds.has('acme/warm')).toBe(true);
  });

  it('只为 M1 缺失项批量取数，恢复 data: 图标、已确认 Other、私有与新鲜度', async () => {
    recordSharedRepoCards([row('acme/warm', { description: 'warm' })]);
    const staleSecs = Math.floor((Date.now() - 13 * 3600 * 1000) / 1000);
    const batch = vi.fn(async (ids: string[]) =>
      ids.map((id) => {
        if (id === 'acme/icon') return card(id, {}, { icon: 'data:image/png;base64,ZZ' });
        if (id === 'acme/other') return card(id, { confirmed_other: true });
        if (id === 'me/secret') return card(id, { is_private: true });
        if (id === 'acme/old') return card(id, { updated_at: staleSecs });
        return null;
      }),
    );
    api.getRepoCardsBatch = batch;
    const out = await hydrateCardsByIds([
      'acme/warm',
      'acme/icon',
      'acme/other',
      'me/secret',
      'acme/old',
      'acme/missing',
    ]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual([
      'acme/icon',
      'acme/other',
      'me/secret',
      'acme/old',
      'acme/missing',
    ]);
    expect(out.rows.map((r) => r.id)).toEqual([
      'acme/warm',
      'acme/icon',
      'acme/other',
      'me/secret',
      'acme/old',
    ]);
    // data: 只在返回对象上，池内卡片无 data:。
    expect(out.byId.get('acme/icon')?.icon).toBe('data:image/png;base64,ZZ');
    expect(peekFreshRepoCard('acme/icon')?.icon).toBe('');
    expect(out.confirmedOtherIds).toEqual(['acme/other']);
    expect(isSharedRepoConfirmedOther('acme/other')).toBe(true);
    expect([...out.freshCardIds].sort()).toEqual(['acme/icon', 'acme/other', 'acme/warm', 'me/secret']);
    // 超 12h 的卡片仍可展示，但不进 M1、不计新鲜。
    expect(peekFreshRepoCard('acme/old')).toBeUndefined();

    clearPrivateSharedRepoCards();
    expect(peekFreshRepoCard('me/secret')).toBeUndefined();
    expect(peekFreshRepoCard('acme/icon')).toBeDefined();
  });

  it('IPC 失败按全部缺失计，不抛错', async () => {
    api.getRepoCardsBatch = vi.fn(async () => {
      throw new Error('boom');
    });
    const out = await hydrateCardsByIds(['acme/x']);
    expect(out.rows).toEqual([]);
  });
});

function detail(id: string, patch: Partial<AppDetail> = {}): AppDetail {
  return {
    ...row(id),
    changelog: '',
    readme_markdown: '',
    releases: [],
    ...patch,
  };
}

describe('healSummaryPlaceholders', () => {
  it('以池内实质值治愈占位/空白简介与主页，无可改进保持引用', () => {
    putTrendEnrichMemory({
      'acme/atlas': row('acme/atlas', {
        description: '真实简介',
        description_en: 'Real description',
        homepage: 'https://atlas.example',
        platforms: ['windows'],
      }),
    });
    const healed = healSummaryPlaceholders(
      row('acme/atlas', { description: 'GitHub 社区开源项目', description_en: '' }),
    );
    expect(healed.description).toBe('真实简介');
    expect(healed.description_en).toBe('Real description');
    expect(healed.homepage).toBe('https://atlas.example');

    const real = row('acme/atlas', {
      description: '自有简介',
      description_en: 'Own',
      homepage: 'https://own.example',
    });
    expect(healSummaryPlaceholders(real)).toBe(real);
    const miss = row('acme/none', { description: 'GitHub 社区开源项目' });
    expect(healSummaryPlaceholders(miss)).toBe(miss);
  });

  it('extraKeys 补充查找键（详情 id 与打开 id 不一致）', () => {
    putTrendEnrichMemory({ 'acme/atlas': row('acme/atlas', { description: '真实简介' }) });
    const healed = healSummaryPlaceholders(
      { id: 'mirror/atlas', owner: 'mirror', repo: 'atlas', description: '' },
      { extraKeys: ['acme/atlas'] },
    );
    expect(healed.description).toBe('真实简介');
  });
});

describe('upsertRepoCardFromDetail', () => {
  it('三态平台单调：空平台记为已确认 Other，具平台撤销确认，空平台不回退具平台', () => {
    upsertRepoCardFromDetail(detail('acme/atlas', { platforms: [] }));
    expect(isSharedRepoConfirmedOther('acme/atlas')).toBe(true);
    expect(hasSettledRepoPlatforms('acme/atlas')).toBe(true);

    upsertRepoCardFromDetail(detail('acme/atlas', { platforms: ['linux'] }));
    expect(isSharedRepoConfirmedOther('acme/atlas')).toBe(false);
    expect(readSharedRepoEnrich('acme/atlas')?.platforms).toEqual(['linux']);

    upsertRepoCardFromDetail(detail('acme/atlas', { platforms: [] }));
    expect(isSharedRepoConfirmedOther('acme/atlas')).toBe(false);
    expect(readSharedRepoEnrich('acme/atlas')?.platforms).toEqual(['linux']);

    const monotonicHeals: RepoCardHeal[] = [];
    const stopMonotonic = subscribeRepoCardHeals((h) => monotonicHeals.push(h));
    try {
      upsertRepoCardFromDetail(detail('acme/atlas', { platforms: [] }));
      expect(monotonicHeals).toHaveLength(1);
      expect(monotonicHeals[0].platforms).toEqual(['linux']);
      expect(monotonicHeals[0].confirmedOther).toBeUndefined();
      expect(isSharedRepoConfirmedOther('acme/atlas')).toBe(false);
    } finally {
      stopMonotonic();
    }
  });

  it('is_stale 详情不写池、不扇出', () => {
    const heals: RepoCardHeal[] = [];
    const unsubscribe = subscribeRepoCardHeals((h) => heals.push(h));
    try {
      expect(upsertRepoCardFromDetail(detail('acme/atlas', { is_stale: true, platforms: ['linux'] }))).toBeNull();
      expect(peekFreshRepoCard('acme/atlas')).toBeUndefined();
      expect(heals).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('向订阅方扇出合并后的补丁：占位简介保留旧值、data: 图标剥空、别名入键', () => {
    putTrendEnrichMemory({
      'acme/atlas': row('acme/atlas', { description: '真实简介', stars: 1, platforms: ['windows'] }),
    });
    const heals: RepoCardHeal[] = [];
    const unsubscribe = subscribeRepoCardHeals((h) => heals.push(h));
    try {
      upsertRepoCardFromDetail(
        detail('acme/atlas', {
          description: 'GitHub 社区开源项目',
          icon: 'data:image/png;base64,AAA',
          stars: 5,
          platforms: ['windows', 'macos'],
        }),
        { aliases: ['github.com/acme/atlas'] },
      );
      expect(heals).toHaveLength(1);
      const [heal] = heals;
      expect(heal.keys).toContain('acme/atlas');
      expect(heal.summary.description).toBe('真实简介');
      expect(heal.summary.icon).toBe('');
      expect(heal.dirtyFields).toContain('stars');
      expect(heal.dirtyFields).not.toContain('description');
      expect(heal.platforms).toEqual(['windows', 'macos']);
      expect(peekFreshRepoCard('acme/atlas')?.stars).toBe(5);
    } finally {
      unsubscribe();
    }
  });

  it('登出清理私有仓库详情卡', () => {
    upsertRepoCardFromDetail(detail('acme/secret', { platforms: ['linux'] }));
    upsertRepoCardFromDetail(detail('acme/public', { platforms: ['linux'] }));
    recordSharedPrivateRepos(['acme/secret']);
    clearPrivateSharedRepoCards();
    expect(peekFreshRepoCard('acme/secret')).toBeUndefined();
    expect(peekFreshRepoCard('acme/public')).toBeDefined();
  });
});
