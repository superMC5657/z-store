import type { TrendRepo } from '../../types';

/**
 * 趋势榜单测试夹具：一份四仓快照，各口径排序互不相同。
 *
 * - 按总星 (top):        atlas(12000) > dune(9000) > beacon(1500) > comet(400)
 * - 按增量 (time boards): dune(2500) > beacon(1400) > comet(380) > atlas(120)
 * - 按增速比 (rising):    comet(19) > beacon(14) > dune(≈0.39) > atlas(≈0.01)
 * - 按活跃代理 (healthy): dune(2600) > beacon(1600) > atlas(520) > comet(440)
 * - 新仓兜底 (new):       beacon, comet（stars<2000 && forks<500）
 * - 类目分组 (category):  dev[dune, atlas] / media[beacon, comet]
 */
export function makeTrendRepo(overrides: Partial<TrendRepo> & { id: string }): TrendRepo {
  const [owner = 'acme', ...rest] = overrides.id.split('/');
  const repo = rest.join('/') || overrides.id;
  return {
    name: overrides.id,
    owner,
    repo,
    stars: 0,
    description: `${overrides.id} desc`,
    url: `https://github.com/${overrides.id}`,
    ...overrides,
    id: overrides.id,
  };
}

export function boardFixture(): TrendRepo[] {
  return [
    makeTrendRepo({ id: 'acme/atlas', stars: 12000, starsGained: 120, forks: 400, category: 'dev' }),
    makeTrendRepo({ id: 'acme/dune', stars: 9000, starsGained: 2500, forks: 100, category: 'dev' }),
    makeTrendRepo({ id: 'acme/beacon', stars: 1500, starsGained: 1400, forks: 200, category: 'media' }),
    makeTrendRepo({ id: 'acme/comet', stars: 400, starsGained: 380, forks: 60, category: 'media' }),
  ];
}

/** 将 TrendRepo 还原为 OSSInsight 行结构（starsGained 经 current_period_growth 往返）。 */
export function ossRowOf(r: TrendRepo): Record<string, unknown> {
  return {
    repo_name: r.id,
    stars: r.stars,
    forks: r.forks,
    current_period_growth: r.starsGained,
    description: r.description,
  };
}

export function repoIds(repos: TrendRepo[]): string[] {
  return repos.map((r) => r.id);
}
