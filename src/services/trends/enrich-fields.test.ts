/**
 * 已确认 Other 回归 + pending 永不持久化：
 * pending 空平台永不持久化（不进 trendEnrichCache 内存，不落库），只活当次 out 渲染；
 * 只有具平台才进缓存（12h/500 FIFO）；后续靠应用详情刷新治愈（upsert from detail）。
 * - fresh 不自动确认，需 lite/详情确认标记才为 Other；
 * - concrete 到场驱逐确认；stale 到期重验；
 * - 兼容：无内存条目时 L2 确认标记仍有效（L2 confirmedOther 输入）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  enrichTrendRepos,
  hydrateTrendConfirmedOtherCache,
  hydrateTrendEnrichCache,
  isTrendConfirmedOtherFresh,
  markTrendConfirmedOther,
  markTrendConfirmedOthers,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
  subscribeTrendConfirmedOtherChanges,
  unmarkTrendConfirmedOther,
  upsertTrendEnrichFromDetail,
} from './enrich';
import { tauriApi } from '../api';
import { makeEnrichedApp, makeTrendRepo } from '../../views/test-utils/trendFixture';
import type { AppDetail } from '../../types';

const HOUR_MS = 3600 * 1000;

function makeDetail(overrides: Partial<AppDetail> & { id: string }): AppDetail {
  const [owner = 'acme', ...rest] = overrides.id.split('/');
  const repo = rest.join('/') || overrides.id;
  const base: AppDetail = {
    id: overrides.id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${overrides.id} detail desc`,
    stars: 1500,
    forks: 200,
    license: 'MIT',
    latest_version: 'v1.0.0',
    changelog: '',
    is_verified: false,
    readme_markdown: '',
    releases: [],
    category: 'dev',
    category_name: '开发工具',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  clearTrendEnrichCache();
  clearTrendConfirmedOtherCache();
  vi.restoreAllMocks();
});
afterEach(() => {
  clearTrendEnrichCache();
  clearTrendConfirmedOtherCache();
  vi.restoreAllMocks();
});

describe('per-field TTL：icon sticky / summary 12h（仅具平台）', () => {
  it('新鲜命中不重拉', async () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'], description: 'old' }),
    });
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) => rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })));
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(out.get('acme/atlas')?.description).toBe('old');
  });

  it('stale summary 重拉，fresh icon 粘性保留（out 与内存一致）', async () => {
    const t0 = Date.now();
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: ['windows'],
        icon: 'https://x/icon.png',
        description: 'old desc',
      }),
    });
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 13 * HOUR_MS);
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => ({
          ...makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] }),
          icon: '',
          description: 'new desc',
        })),
      );
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.get('acme/atlas')?.description).toBe('new desc');
    expect(out.get('acme/atlas')?.icon).toBe('https://x/icon.png');
    expect(snapshotTrendEnrichCache()['acme/atlas']?.icon).toBe('https://x/icon.png');
  });
});

describe('pending 永不持久化', () => {
  it('hydrate pending 直接跳过（快照无条目）', () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'pending' }),
    });
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
    expect(snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })])).not.toHaveProperty(
      'acme/atlas',
    );
  });

  it('enrich pending 只活当次 out，二次进榜无缓存命中走重拉', async () => {
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] })),
      );
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    const first = await enrichTrendRepos(repos);
    expect(first.get('acme/atlas')?.platforms).toEqual([]);
    // pending 永不进内存：快照无条目。
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
    const second = await enrichTrendRepos(repos);
    expect(second.get('acme/atlas')?.platforms).toEqual([]);
    // 二次进榜无缓存命中：再次走重拉。
    expect(spy).toHaveBeenCalledTimes(2);
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
  });

  it('详情治愈后命中（具平台进缓存，不再重拉）', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] })),
    );
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    const pendingOut = await enrichTrendRepos(repos);
    expect(pendingOut.get('acme/atlas')?.platforms).toEqual([]);
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
    // 应用详情刷新治愈：具平台回填唯一写口。
    upsertTrendEnrichFromDetail(makeDetail({ id: 'acme/atlas', platforms: ['windows'] }));
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
    const spy2 = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) => rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })));
    const healed = await enrichTrendRepos(repos);
    expect(spy2).not.toHaveBeenCalled();
    expect(healed.get('acme/atlas')?.platforms).toEqual(['windows']);
  });
});

describe('已确认 Other（需确认标记）', () => {
  it('fresh 不自动确认，需标记才为 Other', () => {
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
    markTrendConfirmedOther('acme/atlas');
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
  });

  it('concrete→evicted（残留标记同步清除）', () => {
    markTrendConfirmedOther('acme/atlas');
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
  });

  it('stale 确认→非 Other（到期重验，快照排除）', () => {
    const t0 = Date.now();
    markTrendConfirmedOther('acme/atlas');
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 13 * HOUR_MS);
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
  });

  it('无内存条目时 L2 标记仍有效', () => {
    hydrateTrendConfirmedOtherCache(['acme/ghost']);
    expect(isTrendConfirmedOtherFresh('acme/ghost')).toBe(true);
    expect(snapshotTrendConfirmedOthers()).toContain('acme/ghost');
  });
});

describe('已确认 pending 进内存（Other 写透联动）', () => {
  it('先 mark 后 hydrate：已确认 pending 进内存并可快照', () => {
    markTrendConfirmedOther('acme/atlas');
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'other' }),
    });
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual([]);
    expect(snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })])['acme/atlas']).toBeDefined();
  });

  it('pending 回填永不覆盖内存已具平台值（即使已标记）', () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    markTrendConfirmedOthers(['acme/atlas']);
    // 已具平台则 mark 跳过，仍非 Other
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
    });
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
  });

  it('已确认 pending 新鲜命中 enrich（免重拉），stale 到期重拉', async () => {
    markTrendConfirmedOther('acme/atlas');
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'other' }),
    });
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] })),
      );
    // 新鲜命中：不重拉
    const hit = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(hit.get('acme/atlas')?.platforms).toEqual([]);
    // stale 到期：重拉并治愈为具平台
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 13 * HOUR_MS);
    const healed = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(healed.get('acme/atlas')?.platforms).toEqual(['windows']);
  });
});

describe('已确认变更订阅（写透联动钩子）', () => {
  it('mark/unmark 触发订阅，hydrate/sweep 不触发', () => {
    const events: Array<{ kind: string; keys: readonly string[] }> = [];
    const unsubscribe = subscribeTrendConfirmedOtherChanges((kind, keys) => {
      events.push({ kind, keys });
    });
    try {
      markTrendConfirmedOther('acme/atlas');
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('mark');
      expect(events[0]?.keys).toEqual(['acme/atlas']);
      // 读路径 hydrate 不触发
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
      });
      hydrateTrendConfirmedOtherCache(['acme/beacon']);
      expect(events).toHaveLength(1);
      unmarkTrendConfirmedOther('acme/atlas');
      expect(events).toHaveLength(2);
      expect(events[1]?.kind).toBe('unmark');
      // 空键/重复 unmark 不触发
      unmarkTrendConfirmedOther('acme/atlas');
      unmarkTrendConfirmedOther('  ');
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
    markTrendConfirmedOther('acme/atlas');
    expect(events).toHaveLength(2);
  });
});

describe('is_stale 透出：stale 条目永不进内存/快照（真零与失败空可区分）', () => {
  it('hydrate stale 直接跳过（快照无条目）', () => {
    markTrendConfirmedOther('acme/atlas');
    hydrateTrendEnrichCache({
      'acme/atlas': {
        ...makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
        is_stale: true,
      } as unknown as ReturnType<typeof makeEnrichedApp>,
    });
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
  });
});
