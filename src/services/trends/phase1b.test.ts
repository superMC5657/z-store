import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  buildDoforceCacheKey,
  buildTrendsCacheKey,
  clearTrendsCache,
  saveDbTrendCache,
} from './cache';
import {
  compareStarsGainedDesc,
  filterNewReposFallback,
  sortByHealthyScore,
} from './parse';
import {
  hydrateTrendEnrichCache,
  matchCatalogApp,
  snapshotTrendEnrichCache,
  clearTrendEnrichCache,
} from './enrich';
import { makeTrendRepo, makeEnrichedApp } from '../../views/test-utils/trendFixture';
import { makeApp } from '../../views/test-utils/filterFixture';

describe('Phase1B C1：match 需 owner 佐证，跨 owner 永不命中', () => {
  beforeEach(() => clearTrendEnrichCache());

  it('同 repo 名不同 owner 永不命中', () => {
    const catalog = [
      makeApp({ id: 'evil/atlas', name: 'Atlas', owner: 'evil', repo: 'atlas', category: 'dev' }),
    ];
    const trend = makeTrendRepo({ id: 'acme/atlas', owner: 'acme', repo: 'atlas', stars: 100 });
    expect(matchCatalogApp(trend, catalog)).toBeUndefined();
  });

  it('同 name 不同 owner 永不命中（模糊分支已删）', () => {
    const catalog = [
      makeApp({ id: 'evil/atlas', name: 'atlas', owner: 'evil', repo: 'atlas', category: 'dev' }),
    ];
    const trend = makeTrendRepo({ id: 'acme/atlas', owner: 'acme', repo: 'atlas', stars: 100 });
    (trend as { name: string }).name = 'atlas';
    expect(matchCatalogApp(trend, catalog)).toBeUndefined();
  });

  it('owner+repo 同时相等才命中；id 全等命中', () => {
    const catalog = [
      makeApp({ id: 'acme/atlas', name: 'Atlas', owner: 'acme', repo: 'atlas', category: 'dev' }),
    ];
    expect(
      matchCatalogApp(makeTrendRepo({ id: 'acme/atlas', owner: 'acme', repo: 'atlas' }), catalog)?.id,
    ).toBe('acme/atlas');
    // 大小写归一仍命中
    expect(
      matchCatalogApp(makeTrendRepo({ id: 'ACME/ATLAS', owner: 'ACME', repo: 'ATLAS' }), catalog)?.id,
    ).toBe('acme/atlas');
  });
});

describe('Phase1B C2：undefined 恒沉底，tie 按 id 升序', () => {
  it('compareStarsGainedDesc：undefined 恒沉底', () => {
    const undef = makeTrendRepo({ id: 'acme/ghost', stars: 100000, starsGained: undefined });
    const tiny = makeTrendRepo({ id: 'acme/tiny', stars: 10, starsGained: 1 });
    expect([undef, tiny].sort(compareStarsGainedDesc).map((r) => r.id)).toEqual([
      'acme/tiny',
      'acme/ghost',
    ]);
    // 双 undefined 按 id 升序
    const b = makeTrendRepo({ id: 'acme/b', starsGained: undefined });
    const a = makeTrendRepo({ id: 'acme/a', starsGained: undefined });
    expect([b, a].sort(compareStarsGainedDesc).map((r) => r.id)).toEqual(['acme/a', 'acme/b']);
  });

  it('双 defined 比大小，tie 按 id 升序', () => {
    const z = makeTrendRepo({ id: 'acme/z', starsGained: 100 });
    const a = makeTrendRepo({ id: 'acme/a', starsGained: 100 });
    expect([z, a].sort(compareStarsGainedDesc).map((r) => r.id)).toEqual(['acme/a', 'acme/z']);
    const big = makeTrendRepo({ id: 'acme/big', starsGained: 200 });
    expect([z, big].sort(compareStarsGainedDesc).map((r) => r.id)).toEqual(['acme/big', 'acme/z']);
  });

  it('healthyScore 公式不变，排序 tie 按 id 升序', () => {
    const r1 = makeTrendRepo({ id: 'acme/b', stars: 100, starsGained: 10, forks: 5 });
    const r2 = makeTrendRepo({ id: 'acme/a', stars: 100, starsGained: 10, forks: 5 });
    expect(sortByHealthyScore([r1, r2]).map((r) => r.id)).toEqual(['acme/a', 'acme/b']);
  });

  it('new-fallback：undefined 沉底', () => {
    const ghost = makeTrendRepo({ id: 'acme/ghost', stars: 50, starsGained: undefined, forks: 2 });
    const str = makeTrendRepo({ id: 'acme/str', stars: 800, starsGained: 1234, forks: 30 });
    expect(filterNewReposFallback([ghost, str]).map((r) => r.id)).toEqual(['acme/str', 'acme/ghost']);
  });
});

describe('Phase1B C3：key 归一读写一致', () => {
  it('language/category 归一 trim().toLowerCase()', () => {
    expect(buildTrendsCacheKey('weekly', { language: 'Python' })).toBe('weekly|python|');
    expect(buildTrendsCacheKey('weekly', { language: ' Python ', category: ' Media ' })).toBe(
      'weekly|python|media',
    );
    expect(buildDoforceCacheKey({ language: 'Rust', category: 'CLI' })).toBe('doforce|rust|cli');
    expect(buildDoforceCacheKey({ language: ' Rust ', category: ' CLI ' })).toBe('doforce|rust|cli');
  });

  it('读写同源：同 board+opts 读写 key 一致', () => {
    // boards.ts:204/214/240 读路径与 TrendsView 写透路径同源（同 builder + 同 opts）
    const opts = { language: 'Python', category: 'Media' };
    expect(buildTrendsCacheKey('weekly', opts)).toBe(buildTrendsCacheKey('weekly', { ...opts }));
    expect(buildTrendsCacheKey('weekly', { language: 'PYTHON' })).toBe(
      buildTrendsCacheKey('weekly', { language: 'python' }),
    );
    expect(buildDoforceCacheKey(opts)).toBe(buildDoforceCacheKey({ ...opts }));
    expect(buildDoforceCacheKey({ language: 'RUST' })).toBe(buildDoforceCacheKey({ language: 'rust' }));
  });
});

describe('Phase1B C5（SWR）：pending 空平台进盘直展，data: URI 永不进 payload', () => {
  beforeEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  it('hydrate/snapshot 守卫：pending 空平台进缓存直展，data: URI 永不进', () => {
    const empty = makeEnrichedApp({ id: 'acme/empty', platforms: [] });
    const dataUri = makeEnrichedApp({ id: 'acme/img', platforms: ['windows'], icon: 'data:image/png;base64,xxx' });
    const good = makeEnrichedApp({ id: 'acme/good', platforms: ['windows'], icon: 'https://x/icon.png' });
    hydrateTrendEnrichCache({
      'acme/empty': empty,
      'acme/img': dataUri,
      'acme/good': good,
    });
    const snap = snapshotTrendEnrichCache();
    expect(snap['acme/good']).toBeDefined();
    // SWR：pending 空平台保留进盘，首屏直展 pending 卡（Other 待确认语义）
    expect(snap['acme/empty']).toBeDefined();
    expect(snap['acme/empty']?.platforms).toEqual([]);
    expect(snap['acme/img']).toBeUndefined();
  });

  it('saveDbTrendCache 消毒：pending 进盘，data: URI 兜底不进 L2', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 10 })];
    const empty = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
    const dataUri = makeEnrichedApp({
      id: 'acme/beacon',
      platforms: ['windows'],
      icon: 'data:image/png;base64,xxx',
    });
    const good = makeEnrichedApp({
      id: 'acme/good',
      platforms: ['windows'],
      icon: 'https://x/icon.png',
    });
    await saveDbTrendCache('weekly|python|', 'weekly', repos, {
      'acme/atlas': empty,
      'acme/beacon': dataUri,
      'acme/good': good,
    });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0]?.[1] as { payload_json: string };
    const payload = JSON.parse(args.payload_json) as {
      v: number;
      repos: unknown[];
      enrich: Record<string, { platforms: string[]; icon: string }>;
    };
    expect(payload.v).toBe(1);
    expect(payload.enrich['acme/good']).toBeDefined();
    // SWR：pending 空平台随信封落盘，首屏直展 pending 卡
    expect(payload.enrich['acme/atlas']).toBeDefined();
    expect(payload.enrich['acme/atlas']?.platforms).toEqual([]);
    expect(payload.enrich['acme/beacon']).toBeUndefined();
    for (const summary of Object.values(payload.enrich)) {
      expect(Array.isArray(summary.platforms)).toBe(true);
      expect(summary.icon.startsWith('data:')).toBe(false);
    }
  });
});
