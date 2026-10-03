/**
 * 趋势数据层测试（P1/P2/P3 + Standards 修复后）。
 *
 * 覆盖八榜契约 `fetchTrends(board, opts)`：
 * daily/weekly → OSSInsight 对应 period 速度顺序（HN 降级）；
 * monthly → OSSInsight past_month 并显式按 starsGained 降序（速度榜）；
 * top → 纯离线榜：fetchTrends 零远端请求返回 []，UI 用 trendReposFromCatalog；
 * new → GitHub search，失败/空一律返回 []（不再隐式复用 weekly）；
 * rising/category/healthy → weekly 快照之上的客户端视图
 *  （增速比 / 类目分组 / 活跃代理，非独立上游），new-fallback 为同族纯函数。
 *
 * 核心断言：
 * - 上游缺失增量 => starsGained 为 undefined（绝不回退总量），UI 仅 defined 渲染 +N；
 * - 5 种纯函数排序互不相同；monthly 与 top 口径彻底区分（past_month vs 零fetch）。
 * - 远端为空一律返回 []，绝不回退本地加权排序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as trendsModule from '../services/trends';
import {
  buildTrendsCacheKey,
  CACHE_TTL_MS,
  clearTrendsCache,
  enrichWithCatalogCategory,
  fetchTrends,
  filterNewReposFallback,
  formatStars,
  growthRatio,
  healthyScore,
  matchCatalogApp,
  rankByGrowthRatio,
  sortByCategoryGroup,
  sortByHealthyScore,
  sortByStarsTotal,
  trendReposFromCatalog,
} from '../services/trends';
import type { TrendRepo } from '../services/trends';
import { boardFixture, makeTrendRepo, ossRowOf, repoIds } from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';

let fetchMock: ReturnType<typeof vi.fn>;
let requestedPeriods: (string | undefined)[];
let hnHits: unknown[];
let ghItems: unknown[] | Error;
let ossRows: Record<string, unknown>[] | Error;

function ossOk(rows: unknown[]) {
  return { ok: true, json: async () => ({ data: { rows }, data_quality: { status: 'available' } }) };
}

beforeEach(() => {
  clearTrendsCache();
  requestedPeriods = [];
  hnHits = [];
  ghItems = [];
  ossRows = [];
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('api.ossinsight.io')) {
      if (ossRows instanceof Error) throw ossRows;
      requestedPeriods.push(u.match(/period=([^&]+)/)?.[1]);
      return ossOk(ossRows);
    }
    if (u.includes('hn.algolia.com')) {
      return { ok: true, json: async () => ({ hits: hnHits }) };
    }
    if (u.includes('api.github.com')) {
      if (ghItems instanceof Error) throw ghItems;
      return { ok: true, json: async () => ({ items: ghItems }) };
    }
    throw new Error(`unexpected url: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P0: 旧加权公式与 period 兼容层已彻底删除', () => {
  it('不再导出 sortAppsLocally', () => {
    expect('sortAppsLocally' in trendsModule).toBe(false);
  });

  it('CACHE_TTL_MS 保持 5 分钟', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('旧 TrendPeriod 取值不再是合法 board（无兼容层，直接抛错）', async () => {
    await expect(fetchTrends('day' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrends('week' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrends('all' as never)).rejects.toThrow(/unknown board/);
  });

  it('缓存键 = board + language + category', () => {
    expect(buildTrendsCacheKey('weekly')).toBe('weekly||');
    expect(buildTrendsCacheKey('weekly', { language: 'Python' })).toBe('weekly|Python|');
    expect(buildTrendsCacheKey('category', { category: 'media' })).toBe('category||media');
    expect(buildTrendsCacheKey('weekly', { language: 'Go', category: 'dev' })).toBe('weekly|Go|dev');
  });
});

describe('daily/weekly/monthly：一榜一 period + HN 降级', () => {
  it('各时间榜命中各自 OSSInsight period，且 starsGained 取 current_period_growth', async () => {
    ossRows = boardFixture().map(ossRowOf);
    const weekly = await fetchTrends('weekly');
    expect(requestedPeriods).toEqual(['past_week']);
    expect(repoIds(weekly)).toEqual(['acme/atlas', 'acme/dune', 'acme/beacon', 'acme/comet']);
    // 远端顺序原样保留（源端已按增量排好，不做本地二次加权）
    const dune = weekly.find((r) => r.id === 'acme/dune')!;
    expect(dune.stars).toBe(9000);
    expect(dune.starsGained).toBe(2500);
    expect(dune.forks).toBe(100);
    expect(dune.url).toBe('https://github.com/acme/dune');

    const daily = await fetchTrends('daily', { forceRefresh: true });
    expect(requestedPeriods.at(-1)).toBe('past_24_hours');
    expect(daily.length).toBe(4);

    const monthly = await fetchTrends('monthly', { forceRefresh: true });
    expect(requestedPeriods.at(-1)).toBe('past_month');
    expect(monthly.length).toBe(4);
  });

  it('monthly 按 starsGained 降序显式重排（速度榜，与 top 总星榜区分）', async () => {
    // 远端故意乱序：monthly 必须按增量重排为 dune > beacon > comet > atlas
    const shuffled = [boardFixture()[0], boardFixture()[3], boardFixture()[1], boardFixture()[2]];
    ossRows = shuffled.map(ossRowOf);
    const monthly = await fetchTrends('monthly');
    expect(requestedPeriods).toEqual(['past_month']);
    expect(monthly.map((r) => r.starsGained)).toEqual([2500, 1400, 380, 120]);
    expect(repoIds(monthly)).toEqual(['acme/dune', 'acme/beacon', 'acme/comet', 'acme/atlas']);
  });

  it('P1：上游缺失增量 => starsGained 为 undefined（绝不回退总量）', async () => {
    ossRows = [
      { repo_name: 'acme/nogrowth', stars: 9876, description: 'no growth field' },
      { repo_name: 'acme/emptygrowth', stars: 500, current_period_growth: '', description: 'empty' },
      { repo_name: 'acme/badgrowth', stars: 500, current_period_growth: 'not-a-number' },
    ];
    const repos = await fetchTrends('weekly');
    expect(repos).toHaveLength(3);
    for (const r of repos) {
      expect(r.starsGained).toBeUndefined();
    }
    expect(repos[0].stars).toBe(9876);
    // UI 契约：仅 defined 才渲染 +N，undefined 一律不渲染（此处不断言 UI，只锁定数据层）。
  });

  it('language 透传为 OSSInsight 查询参数', async () => {
    ossRows = boardFixture().map(ossRowOf);
    await fetchTrends('weekly', { language: 'Python' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('language=Python');
  });

  it('请求携带 AbortSignal（5s 熔断）', async () => {
    ossRows = boardFixture().map(ossRowOf);
    await fetchTrends('weekly');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('OSSInsight 异常时降级 HN，并按 GITHUB_REPO_REGEX 解析/去重/过滤', async () => {
    ossRows = new Error('oss down');
    hnHits = [
      { url: 'https://github.com/acme/dune', points: 42, title: 'Dune story' },
      { url: 'https://github.com/acme/dune', points: 42, title: 'Dune dup' },
      { url: 'https://github.com/trending/python', points: 99, title: 'ignored segment' },
      { url: 'https://example.com/not-a-repo', points: 10, title: 'noise' },
    ];
    const repos = await fetchTrends('weekly');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('hn.algolia.com'))).toBe(true);
    expect(repoIds(repos)).toEqual(['acme/dune']);
    expect(repos[0].stars).toBe(42);
    expect(repos[0].starsGained).toBe(42);
  });

  it('远端全空（OSSInsight 空行 + HN 空 hits）返回 []，不做本地加权假榜', async () => {
    ossRows = [];
    hnHits = [];
    await expect(fetchTrends('daily')).resolves.toEqual([]);
    await expect(fetchTrends('weekly')).resolves.toEqual([]);
    await expect(fetchTrends('monthly')).resolves.toEqual([]);
  });

  it('同 board+lang 走缓存，不同 language 重新请求，forceRefresh 强制刷新', async () => {
    ossRows = boardFixture().map(ossRowOf);
    await fetchTrends('weekly', { language: 'Python' });
    await fetchTrends('weekly', { language: 'Python' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchTrends('weekly', { language: 'Go' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchTrends('weekly', { language: 'Go', forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('各榜单返回互不相同的排序（取代旧 Top3 固定顺序）', () => {
  it('纯函数：top / rising / healthy / new兜底 / category 全部分叉', () => {
    const fixture = boardFixture();
    const top = repoIds(sortByStarsTotal(fixture));
    const rising = repoIds(rankByGrowthRatio(fixture));
    const healthy = repoIds(sortByHealthyScore(fixture));
    const fresh = repoIds(filterNewReposFallback(fixture));
    const grouped = repoIds(sortByCategoryGroup(fixture));

    expect(top).toEqual(['acme/atlas', 'acme/dune', 'acme/beacon', 'acme/comet']);
    expect(rising).toEqual(['acme/comet', 'acme/beacon', 'acme/dune', 'acme/atlas']);
    expect(healthy).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas', 'acme/comet']);
    expect(fresh).toEqual(['acme/beacon', 'acme/comet']);
    expect(grouped).toEqual(['acme/dune', 'acme/atlas', 'acme/beacon', 'acme/comet']);

    const orders = new Set([top, rising, healthy, fresh, grouped].map((o) => o.join(',')));
    expect(orders.size).toBe(5);
  });

  it('增速比公式 = starsGained / max(1, stars - starsGained)', () => {
    const [atlas, dune, beacon, comet] = boardFixture();
    expect(growthRatio(comet)).toBeCloseTo(380 / 20);
    expect(growthRatio(beacon)).toBeCloseTo(1400 / 100);
    expect(growthRatio(dune)).toBeCloseTo(2500 / 6500);
    expect(growthRatio(atlas)).toBeCloseTo(120 / 11880);
    expect(healthyScore(dune)).toBe(100 + 2500);
  });

  it('fetchTrends rising/healthy 派生自 weekly 快照但顺序不同', async () => {
    ossRows = boardFixture().map(ossRowOf);
    const rising = await fetchTrends('rising');
    // 派生榜复用 weekly 缓存：rising 后再取 healthy 不触发第二次 weekly 远端请求
    const healthy = await fetchTrends('healthy');
    expect(repoIds(rising)).toEqual(['acme/comet', 'acme/beacon', 'acme/dune', 'acme/atlas']);
    expect(repoIds(healthy)).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas', 'acme/comet']);
    expect(requestedPeriods).toEqual(['past_week']);
    // forceRefresh 向下穿透到底层 weekly 快照
    await fetchTrends('healthy', { forceRefresh: true });
    expect(requestedPeriods).toEqual(['past_week', 'past_week']);
  });

  it('fetchTrends top 为纯离线榜：零远端请求，返回 []（与 monthly 彻底区分）', async () => {
    ossRows = boardFixture().map(ossRowOf);
    const callsBefore = fetchMock.mock.calls.length;
    const top = await fetchTrends('top');
    expect(top).toEqual([]);
    // 零 fetch：monthly 会命中 past_month，top 不得触发任何请求
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(requestedPeriods).toEqual([]);
  });

  it('top 远端为空返回 []（HN points 不是 stars，不做降级污染口径）', async () => {
    ossRows = [];
    await expect(fetchTrends('top')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('new 榜：GitHub search 首选，失败/空一律返回 []（P3，不再隐式复用 weekly）', () => {
  const ghItem = {
    full_name: 'acme/nova',
    stargazers_count: 320,
    forks_count: 12,
    description: 'fresh repo',
    html_url: 'https://github.com/acme/nova',
  };

  it('GitHub search 可用时按 created:>6mo 取新仓（无增量口径，starsGained 为 undefined）', async () => {
    ghItems = [ghItem];
    const repos = await fetchTrends('new');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.github.com'))).toBe(true);
    expect(repoIds(repos)).toEqual(['acme/nova']);
    expect(repos[0].stars).toBe(320);
    // P1：GitHub search 不提供周期增量，缺失即 undefined，绝不回退总量
    expect(repos[0].starsGained).toBeUndefined();
    expect(repos[0].forks).toBe(12);
  });

  it('GitHub 限流/异常时返回 []（不再隐式复用 weekly；显式降级请调用 filterNewReposFallback）', async () => {
    ghItems = new Error('rate limited');
    ossRows = boardFixture().map(ossRowOf);
    const repos = await fetchTrends('new');
    expect(repos).toEqual([]);
  });

  it('GitHub 返回空 items 同样返回 []（remote-empty=>[]）', async () => {
    ghItems = [];
    ossRows = boardFixture().map(ossRowOf);
    const repos = await fetchTrends('new');
    expect(repos).toEqual([]);
  });

  it('filterNewReposFallback 仍为可用纯函数（显式客户端视图，非隐式 fallback）', async () => {
    const fallback = filterNewReposFallback(boardFixture());
    expect(repoIds(fallback)).toEqual(['acme/beacon', 'acme/comet']);
  });
});

describe('category 榜：本地类目分组 + 组内按 starsGained', () => {
  const catalog = [
    makeApp({ id: 'acme/atlas', name: 'Atlas', owner: 'acme', repo: 'atlas', category: 'dev', stars: 12000 }),
    makeApp({ id: 'acme/dune', name: 'Dune', owner: 'acme', repo: 'dune', category: 'dev', stars: 9000 }),
    makeApp({ id: 'acme/beacon', name: 'Beacon', owner: 'acme', repo: 'beacon', category: 'media', stars: 1500 }),
    makeApp({ id: 'acme/comet', name: 'Comet', owner: 'acme', repo: 'comet', category: 'media', stars: 400 }),
  ];

  it('enrichWithCatalogCategory 经 matchCatalogApp 补齐类目', () => {
    const bare: TrendRepo[] = boardFixture().map(({ category: _omit, ...r }) => ({ ...r }));
    expect(bare.every((r) => r.category === undefined)).toBe(true);
    const enriched = enrichWithCatalogCategory(bare, catalog);
    expect(enriched.map((r) => r.category)).toEqual(['dev', 'dev', 'media', 'media']);
    expect(matchCatalogApp(enriched[0], catalog)?.id).toBe('acme/atlas');
  });

  it('组内按 starsGained 降序；按 category 过滤大小写不敏感', () => {
    const enriched = enrichWithCatalogCategory(
      boardFixture().map(({ category: _omit, ...r }) => ({ ...r })),
      catalog,
    );
    expect(repoIds(sortByCategoryGroup(enriched))).toEqual([
      'acme/dune',
      'acme/atlas',
      'acme/beacon',
      'acme/comet',
    ]);
    expect(repoIds(sortByCategoryGroup(enriched, 'media'))).toEqual(['acme/beacon', 'acme/comet']);
    expect(repoIds(sortByCategoryGroup(enriched, 'Media'))).toEqual(['acme/beacon', 'acme/comet']);
  });

  it('fetchTrends category 在 service 内兑现 category 过滤（含 catalogApps enrich）', async () => {
    ossRows = boardFixture().map((r) => {
      const { category: _omit, ...bare } = ossRowOf(r);
      return bare;
    });
    // 不传 catalogApps：远端行无类目，按 category 过滤恒得 []（不在 UI 补救）
    const withoutEnrich = await fetchTrends('category', { category: 'media' });
    expect(withoutEnrich).toEqual([]);
    // 传入 catalogApps：service 内 enrich 后再过滤，兑现 media 分组
    const withEnrich = await fetchTrends('category', { category: 'media', catalogApps: catalog, forceRefresh: true });
    expect(repoIds(withEnrich)).toEqual(['acme/beacon', 'acme/comet']);
  });
});

describe('top 离线路径：本地快照零 fetch 只按总星排序（starsGained 恒为 undefined）', () => {
  it('trendReposFromCatalog 不触发任何网络请求', async () => {
    const apps = [
      makeApp({ id: 'b', name: 'B', owner: 'acme', repo: 'b', stars: 100, forks: 10 }),
      makeApp({ id: 'a', name: 'A', owner: 'acme', repo: 'a', stars: 5000, forks: 300 }),
      makeApp({ id: 'c', name: 'C', owner: 'acme', repo: 'c', stars: 900, forks: 20 }),
    ];
    const repos = trendReposFromCatalog(apps);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repos.map((r) => r.stars)).toEqual([5000, 900, 100]);
    expect(repos[0].category).toBe('system');
    expect(repos[0].url).toBe('https://github.com/acme/a');
    // P1：本地 catalog 无速度口径，starsGained 一律 undefined（UI 不渲染 +N）
    for (const r of repos) {
      expect(r.starsGained).toBeUndefined();
    }
  });
});

describe('保留的展示工具函数', () => {
  it('formatStars 与 AppCard 规范对齐', () => {
    expect(formatStars(999)).toBe('999');
    expect(formatStars(1500)).toBe('1.5k');
  });

  it('makeTrendRepo 兜底 owner/repo 解析', () => {
    const r = makeTrendRepo({ id: 'acme/nova', stars: 10 });
    expect(r.owner).toBe('acme');
    expect(r.repo).toBe('nova');
    expect(r.url).toBe('https://github.com/acme/nova');
  });
});
