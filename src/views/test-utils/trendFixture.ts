import type { TrendRepo } from '../../types';

/**
 * 趋势榜单测试夹具。
 *
 * - boardFixture：一份四仓快照，纯 ranker 排序互不相同
 *   （增速比 / 活跃代理 / 新仓兜底口径）。
 * - trendingHtmlFixture：github.com/trending 页片段，3 个 Box-row：
 *   atlas（逗号增量 + 总量）、beacon（单数 "1 star today" + 缺 forks 链接）、
 *   comet（stargazers 三段链接在前 + 无增量 span + k 缩写总量 + 无描述）。
 * - doforceFixture：doforce 条目（repo 带前导斜杠），rising 与 healthy 排序故意分叉；
 *   doforceEdgeFixture：缺 change 与字符串数字 change 的边缘条目。
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

/** 将 TrendRepo 还原为 GitHub Search item 结构（增量未知，不含 starsGained 口径）。 */
export function ghItemOf(r: TrendRepo): Record<string, unknown> {
  return {
    full_name: r.id,
    stargazers_count: r.stars,
    forks_count: r.forks,
    description: r.description,
    html_url: `https://github.com/${r.id}`,
  };
}

/** github.com/trending 页片段：3 个 Box-row，覆盖单数/逗号/缺 span/三段链接/k 缩写。 */
export function trendingHtmlFixture(): string {
  return [
    '<div class="Box">',
    '<article class="Box-row">',
    '<h2 class="h3 lh-condensed"><a href="/acme/atlas">atlas</a></h2>',
    '<p class="col-9 color-fg-muted my-1 pr-4">Atlas desc</p>',
    '<div class="f6 color-fg-muted mt-2">',
    '<a class="muted-link d-inline-block mr-3" href="/acme/atlas/stargazers">12,000</a>',
    '<a class="muted-link d-inline-block mr-3" href="/acme/atlas/forks">400</a>',
    '<span class="d-inline-block float-sm-right">1,234 stars today</span>',
    '</div>',
    '</article>',
    '<article class="Box-row">',
    '<h2 class="h3 lh-condensed"><a href="/acme/beacon">beacon</a></h2>',
    '<p class="col-9 color-fg-muted my-1 pr-4">Beacon desc</p>',
    '<div class="f6 color-fg-muted mt-2">',
    '<a class="muted-link d-inline-block mr-3" href="/acme/beacon/stargazers">1,500</a>',
    '<span class="d-inline-block float-sm-right">1 star today</span>',
    '</div>',
    '</article>',
    '<article class="Box-row">',
    '<a class="d-inline-block" href="/acme/comet/stargazers">1.2k</a>',
    '<h2 class="h3 lh-condensed"><a href="/acme/comet">comet</a></h2>',
    '<div class="f6 color-fg-muted mt-2">',
    '<a class="muted-link d-inline-block mr-3" href="/acme/comet/forks">60</a>',
    '</div>',
    '</article>',
    '</div>',
  ].join('\n');
}

/**
 * doforce 条目夹具（`repo` 带前导斜杠）：rising（按 change）为 dune > beacon > atlas；
 * healthy（按 forks + change）为 atlas > dune > beacon，两榜故意分叉。
 */
export function doforceFixture(): Record<string, unknown>[] {
  return [
    {
      repo: '/acme/atlas',
      desc: 'Atlas desc',
      lang: 'TypeScript',
      stars: 12000,
      forks: 5000,
      change: 300,
      build_by: [{ username: 'u1' }],
    },
    {
      repo: '/acme/dune',
      desc: 'Dune desc',
      lang: 'Rust',
      stars: 9000,
      forks: 100,
      change: 2500,
    },
    {
      repo: '/acme/beacon',
      desc: 'Beacon desc',
      lang: 'Python',
      stars: 1500,
      forks: 200,
      change: 1400,
    },
  ];
}

/** doforce 边缘条目：缺 change（ghost）与字符串数字 change（str）。 */
export function doforceEdgeFixture(): Record<string, unknown>[] {
  return [
    { repo: '/acme/ghost', desc: 'Ghost desc', lang: 'Go', stars: 50, forks: 2 },
    { repo: '/acme/str', desc: 'Str desc', lang: 'Java', stars: 800, forks: 30, change: '1,234' },
  ];
}

export function repoIds(repos: TrendRepo[]): string[] {
  return repos.map((r) => r.id);
}
