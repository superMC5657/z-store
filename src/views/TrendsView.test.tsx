/** 测试趋势榜一榜一源拉取、重试与按榜 TTL 缓存策略及视图交互。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import type { AppSummary } from '../types';
import * as trendsFacade from '../services/trends';
import {
  clearTrendEnrichCache,
  clearTrendsCache,
  fetchTrendsResult,
  formatStars,
  matchCatalogApp,
  normalizeProxyPrefix,
  putTrendEnrichMemory,
  resolveTrendBoard,
} from '../services/trends';
import { TrendsView } from './TrendsView';
import {
  doforceEdgeFixture,
  doforceFixture,
  ghItemOf,
  makeEnrichedApp,
  makeTrendRepo,
  repoIds,
  trendingHtmlFixture,
} from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';
import {
  loadPersistedTrendBoard,
  persistTrendBoard,
  TREND_BOARD_STORAGE_KEY,
} from './TrendsView/useTrendBoard';
import { tauriApi } from '../services/api';
import { patchIconMirror } from '../services/iconStore';
import { zlogInfo, zlogWarn } from '../lib/z-log';

vi.mock('../lib/z-log', () => ({
  zlogInfo: vi.fn(),
  zlogWarn: vi.fn(),
  zlogError: vi.fn(),
}));

let trendSpy: MockInstance<(url: string) => Promise<string>>;
let rawFetchMock: ReturnType<typeof vi.fn>;
let requestedUrls: string[];
let trendingHtml: string | Error;
let trendingStatus: number | null;
let doforceItems: unknown[] | Error;
let doforceStatus: number | null;
let ghItems: unknown[] | Error;
let ghHttpStatus: number | null;

/** 模拟 Rust 命令失败形态：message 含 status 并附带 .status（与 wrapper 输出一致）。 */
function httpErr(status: number): Error {
  const err = new Error(`trends: upstream status ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

beforeEach(() => {
  clearTrendsCache();
  requestedUrls = [];
  trendingHtml = '';
  trendingStatus = null;
  doforceItems = [];
  doforceStatus = null;
  ghItems = [];
  ghHttpStatus = null;
  rawFetchMock = vi.fn(async () => {
    throw new Error('raw fetch must not be used by trends');
  });
  vi.stubGlobal('fetch', rawFetchMock);
  trendSpy = vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('trend.doforce.dpdns.org')) {
      if (doforceItems instanceof Error) throw doforceItems;
      if (doforceStatus != null) throw httpErr(doforceStatus);
      return JSON.stringify({ items: doforceItems });
    }
    if (u.includes('github.com/trending')) {
      if (trendingHtml instanceof Error) throw trendingHtml;
      if (trendingStatus != null) throw httpErr(trendingStatus);
      return trendingHtml;
    }
    if (u.includes('api.github.com')) {
      if (ghItems instanceof Error) throw ghItems;
      if (ghHttpStatus != null) throw httpErr(ghHttpStatus);
      return JSON.stringify({ items: ghItems });
    }
    throw new Error(`unexpected url: ${u}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  trendSpy.mockRestore();
});

/** 等待 proxyReady 落定后点击刷新按钮触发手动强制刷新。 */
async function clickTrendsRefresh(): Promise<void> {
  const btn = (await screen.findByTestId('trends-refresh')) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  await new Promise((r) => setTimeout(r, 20));
  fireEvent.click(btn);
}

function trendingUrls() {
  return requestedUrls.filter((u) => u.includes('github.com/trending'));
}

function doforceUrls() {
  return requestedUrls.filter((u) => u.includes('trend.doforce.dpdns.org'));
}

function gitHubApiUrls() {
  return requestedUrls.filter((u) => u.includes('api.github.com'));
}

describe('榜单数据源与排序契约', () => {
  it('公共门面仅导出当前公开接口，不泄漏已废弃历史导出与内部微步骤', () => {
    for (const name of [
      'sortAppsLocally',
      'fetchOSSInsightRepos',
      'fetchHNRepos',
      'fetchGitHubWindowRepos',
      'buildGitHubWindowQuery',
      'BOARD_TO_PERIOD',
      'TRENDING_SINCE',
      'DOFORCE_URL',
      'buildTrendingUrl',
      'fetchTrendingRepos',
      'buildDoforceUrl',
      'fetchDoforceRepos',
      'fetchGitHubNewRepos',
    ]) {
      expect(name in trendsFacade, name).toBe(false);
    }
  });

  it('非法 board 直接抛错', async () => {
    await expect(fetchTrendsResult('day' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('week' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('all' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('top' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('category' as never)).rejects.toThrow(/unknown board/);
    expect(trendSpy).not.toHaveBeenCalled();
  });
});

describe('时间榜主源：trending HTML 一榜一 URL', () => {
  it('daily/weekly/monthly 命中各自 ?since= 参数', async () => {
    trendingHtml = trendingHtmlFixture();
    for (const board of ['daily', 'weekly', 'monthly'] as const) {
      const res = await fetchTrendsResult(board, { forceRefresh: true });
      expect(res.status).toBe('ok');
      expect(repoIds(res.repos)).toHaveLength(3);
    }
    expect(trendingUrls()).toEqual([
      'https://github.com/trending?since=daily',
      'https://github.com/trending?since=weekly',
      'https://github.com/trending?since=monthly',
    ]);
  });

  it('language 走 /trending/<lang> 路径段（all/空不追加）', async () => {
    trendingHtml = trendingHtmlFixture();
    await fetchTrendsResult('weekly', { language: 'Python' });
    await fetchTrendsResult('weekly', { language: 'all', forceRefresh: true });
    expect(trendingUrls()).toEqual([
      'https://github.com/trending/Python?since=weekly',
      'https://github.com/trending?since=weekly',
    ]);
  });

  it('有代理前缀时时间榜仍直连（经公共 fetchTrendsResult 路径）', async () => {
    trendingHtml = trendingHtmlFixture();
    const res = await fetchTrendsResult('daily', {
      proxyPrefix: 'https://gh-proxy.com',
      forceRefresh: true,
    });
    expect(repoIds(res.repos)).toHaveLength(3);
    expect(trendingUrls()[0].startsWith('https://gh-proxy.com')).toBe(false);
    expect(trendingUrls()[0]).toBe('https://github.com/trending?since=daily');
  });

  it('经 Rust 命令抓取（不直发 WebView fetch）', async () => {
    trendingHtml = trendingHtmlFixture();
    doforceItems = doforceFixture();
    await fetchTrendsResult('daily');
    await fetchTrendsResult('rising', { forceRefresh: true });
    expect(trendSpy).toHaveBeenCalled();
    expect(rawFetchMock).not.toHaveBeenCalled();
  });

  it('空页 => empty；HTTP 500 => error/unavailable（经 z-log 落盘）', async () => {
    trendingHtml = '<div class="Box"></div>';
    await expect(fetchTrendsResult('daily')).resolves.toEqual({ repos: [], status: 'empty', stale: false });
    trendingStatus = 500;
    vi.mocked(zlogWarn).mockClear();
    await expect(fetchTrendsResult('weekly', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'error',
      errorKind: 'unavailable',
      stale: false,
    });
    const warns = vi.mocked(zlogWarn).mock.calls.map(([m]) => String(m));
    expect(warns.some((m) => m.includes('board=weekly') && m.includes('unavailable'))).toBe(true);
  });

  it('正常拉榜成功不刷屏冗余 info 日志', async () => {
    trendingHtml = trendingHtmlFixture();
    vi.mocked(zlogInfo).mockClear();
    await fetchTrendsResult('daily');
    expect(vi.mocked(zlogInfo)).not.toHaveBeenCalled();
  });

  it('Abort => timeout；TypeError => network', async () => {
    trendingHtml = abortError() as unknown as string;
    await expect(fetchTrendsResult('daily', { forceRefresh: true })).resolves.toMatchObject({
      status: 'error',
      errorKind: 'timeout',
    });
    trendingHtml = new TypeError('Failed to fetch') as unknown as string;
    await expect(fetchTrendsResult('daily', { forceRefresh: true })).resolves.toMatchObject({
      status: 'error',
      errorKind: 'network',
    });
  });

  it('时间榜永不触碰 api.github.com；ossinsight/hn 永不出现', async () => {
    trendingHtml = trendingHtmlFixture();
    for (const board of ['daily', 'weekly', 'monthly'] as const) {
      await fetchTrendsResult(board, { forceRefresh: true });
    }
    expect(gitHubApiUrls()).toHaveLength(0);
    expect(doforceUrls()).toHaveLength(0);
    expect(requestedUrls.some((u) => u.includes('ossinsight'))).toBe(false);
    expect(requestedUrls.some((u) => u.includes('algolia'))).toBe(false);
  });

  it('成功写入缓存（同 key 复用，forceRefresh 穿透）', async () => {
    trendingHtml = trendingHtmlFixture();
    await fetchTrendsResult('weekly', { language: 'Python' });
    await fetchTrendsResult('weekly', { language: 'Python' });
    expect(trendingUrls()).toHaveLength(1);
    await fetchTrendsResult('weekly', { language: 'Python', forceRefresh: true });
    expect(trendingUrls()).toHaveLength(2);
  });

  it('错误不写入缓存（重试重新请求）', async () => {
    trendingStatus = 500;
    await fetchTrendsResult('weekly');
    await fetchTrendsResult('weekly');
    expect(trendingUrls()).toHaveLength(2);
  });
});

describe('rising/healthy：doforce 单飞共享（一次抓取，两榜各排）', () => {
  it('rising 按 change 降序，starsGained 取真实值', async () => {
    doforceItems = doforceFixture();
    const res = await fetchTrendsResult('rising');
    expect(res.status).toBe('ok');
    expect(repoIds(res.repos)).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas']);
    expect(res.repos.map((r) => r.starsGained)).toEqual([2500, 1400, 300]);
    expect(doforceUrls()).toEqual(['https://trend.doforce.dpdns.org/repo']);
    expect(trendingUrls()).toHaveLength(0);
  });

  it('healthy 按 forks + change 排序（与 rising 分叉），starsGained 亦为 change', async () => {
    doforceItems = doforceFixture();
    const res = await fetchTrendsResult('healthy');
    expect(res.status).toBe('ok');
    expect(repoIds(res.repos)).toEqual(['acme/atlas', 'acme/dune', 'acme/beacon']);
    expect(res.repos.map((r) => r.starsGained)).toEqual([300, 2500, 1400]);
  });

  it('边缘条目：缺 change => undefined；字符串数字与前导斜杠被正确处理', async () => {
    doforceItems = doforceEdgeFixture();
    const res = await fetchTrendsResult('rising');
    expect(res.status).toBe('ok');
    const byId = Object.fromEntries(res.repos.map((r) => [r.id, r]));
    // 缺 change：starsGained undefined（绝不回退总量），排最后
    expect(byId['acme/ghost'].starsGained).toBeUndefined();
    expect(byId['acme/ghost'].stars).toBe(50);
    expect(repoIds(res.repos)).toEqual(['acme/str', 'acme/ghost']);
    // 字符串数字 change 正确处理；url 回退拼接
    expect(byId['acme/str'].starsGained).toBe(1234);
    expect(byId['acme/str'].url).toBe('https://github.com/acme/str');
  });

  it('两榜单飞共享：并发 + 随后调用只产生一次远端抓取', async () => {
    doforceItems = doforceFixture();
    const [rising, healthy] = await Promise.all([
      fetchTrendsResult('rising'),
      fetchTrendsResult('healthy'),
    ]);
    expect(rising.status).toBe('ok');
    expect(healthy.status).toBe('ok');
    expect(repoIds(rising.repos)).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas']);
    expect(repoIds(healthy.repos)).toEqual(['acme/atlas', 'acme/dune', 'acme/beacon']);
    expect(doforceUrls()).toHaveLength(1);
    // 随后调用命中 12h 共享缓存，不重复抓取
    await fetchTrendsResult('rising');
    await fetchTrendsResult('healthy');
    expect(doforceUrls()).toHaveLength(1);
    expect(trendingUrls()).toHaveLength(0);
    expect(gitHubApiUrls()).toHaveLength(0);
  });

  it('doforce 持续 429：恰好重试一次后 error/rate-limited', async () => {
    vi.useFakeTimers();
    try {
      doforceStatus = 429;
      const pending = fetchTrendsResult('rising', { forceRefresh: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({
        status: 'error',
        errorKind: 'rate-limited',
      });
      expect(doforceUrls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('429 附带 Retry-After 时按其等待后重试（一次即成功）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      trendSpy.mockImplementation(async (url: string) => {
        requestedUrls.push(String(url));
        calls += 1;
        if (calls === 1) {
          const err = new Error('trends: upstream status 429, retry-after: 1') as Error & {
            status: number;
          };
          err.status = 429;
          throw err;
        }
        return JSON.stringify({ items: doforceFixture() });
      });
      const pending = fetchTrendsResult('rising', { forceRefresh: true });
      await vi.advanceTimersByTimeAsync(1000);
      const res = await pending;
      expect(res.status).toBe('ok');
      expect(repoIds(res.repos)[0]).toBe('acme/dune');
      expect(doforceUrls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Retry-After 超 60s 上限直接 error（不等不重试）', async () => {
    const err = new Error('trends: upstream status 429, retry-after: 3600') as Error & {
      status: number;
    };
    err.status = 429;
    doforceItems = err;
    const res = await fetchTrendsResult('rising', { forceRefresh: true });
    expect(res).toMatchObject({ status: 'error', errorKind: 'rate-limited' });
    expect(doforceUrls()).toHaveLength(1);
  });

  it('doforce 空源 => empty（空结果不进共享缓存）', async () => {
    doforceItems = [];
    await expect(fetchTrendsResult('healthy', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'empty',
      stale: false,
    });
    await expect(fetchTrendsResult('rising', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'empty',
      stale: false,
    });
    expect(doforceUrls()).toHaveLength(2);
  });
});

describe('代理策略：趋势流量恒直连（proxyPrefix 被忽略）', () => {
  it('normalizeProxyPrefix：direct/空/ghproxy => undefined（镜像仅安装包可用）', () => {
    expect(normalizeProxyPrefix(undefined)).toBeUndefined();
    expect(normalizeProxyPrefix('')).toBeUndefined();
    expect(normalizeProxyPrefix('direct')).toBeUndefined();
    expect(normalizeProxyPrefix('ghproxy')).toBeUndefined();
    expect(normalizeProxyPrefix('https://gh-proxy.com/')).toBe('https://gh-proxy.com');
  });

  it('代理已设置时所有趋势 URL 仍直连（proxyPrefix 被忽略）', async () => {
    trendingHtml = trendingHtmlFixture();
    doforceItems = doforceFixture();
    ghItems = [];
    const proxy = 'https://gh-proxy.com';
    await fetchTrendsResult('daily', { proxyPrefix: proxy });
    await fetchTrendsResult('rising', { proxyPrefix: proxy, forceRefresh: true });
    await fetchTrendsResult('new', { proxyPrefix: proxy, forceRefresh: true });
    expect(trendingUrls()).toEqual(['https://github.com/trending?since=daily']);
    expect(doforceUrls()).toEqual(['https://trend.doforce.dpdns.org/repo']);
    expect(gitHubApiUrls()[0].startsWith('https://api.github.com/')).toBe(true);
    for (const u of requestedUrls) {
      expect(u.startsWith(proxy)).toBe(false);
    }
  });

  it('未设置代理时保持官方直连', async () => {
    trendingHtml = trendingHtmlFixture();
    await fetchTrendsResult('weekly');
    for (const u of requestedUrls) {
      expect(u.startsWith('https://gh-proxy.com')).toBe(false);
    }
  });
});

describe('new 榜：GitHub search（created 6mo）保持不变', () => {
  const ghItem = ghItemOf({
    ...makeTrendRepo({ id: 'acme/nova', stars: 320 }),
    forks: 12,
    description: 'fresh repo',
  });

  it('可用时按 created:> 取新仓（starsGained 为 undefined）', async () => {
    ghItems = [ghItem];
    const res = await fetchTrendsResult('new');
    expect(res.status).toBe('ok');
    const url = gitHubApiUrls()[0];
    expect(url).toContain('api.github.com');
    expect(decodeURIComponent(url)).toContain('created:>');
    expect(repoIds(res.repos)).toEqual(['acme/nova']);
    expect(res.repos[0].starsGained).toBeUndefined();
  });

  it('限流 => error/rate-limited；空 => empty', async () => {
    ghHttpStatus = 403;
    await expect(fetchTrendsResult('new')).resolves.toMatchObject({
      status: 'error',
      errorKind: 'rate-limited',
    });
    ghHttpStatus = null;
    ghItems = [];
    await expect(fetchTrendsResult('new', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'empty',
      stale: false,
    });
  });
});

describe('门面辅助函数与抓取入口', () => {
  it('抓取入口经 trends 门面返回 repos', async () => {
    trendingHtml = trendingHtmlFixture();
    const { repos } = await fetchTrendsResult('weekly');
    expect(repoIds(repos)).toHaveLength(3);
  });

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

  it('matchCatalogApp：按 id 命中、未知返回 undefined', () => {
    const catalog = [
      makeApp({ id: 'acme/atlas', name: 'Atlas', owner: 'acme', repo: 'atlas', category: 'dev' }),
    ];
    const atlas = makeTrendRepo({ id: 'acme/atlas', stars: 12000 });
    expect(matchCatalogApp(atlas, catalog)?.id).toBe('acme/atlas');
    expect(matchCatalogApp(makeTrendRepo({ id: 'unknown/void', stars: 1 }), catalog)).toBeUndefined();
  });
});

describe('tauriApi.fetchTrendsText web 回退（纯 web 开发，isTauri 为 false）', () => {
  it('!ok 附加 status；200 返回文本', async () => {
    trendSpy.mockRestore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('boom')) {
          return { ok: false, status: 429, text: async () => '' };
        }
        return { ok: true, status: 200, text: async () => 'hello' };
      }),
    );
    await expect(tauriApi.fetchTrendsText('https://trend.doforce.dpdns.org/boom')).rejects.toMatchObject({
      status: 429,
    });
    await expect(tauriApi.fetchTrendsText('https://trend.doforce.dpdns.org/repo')).resolves.toBe(
      'hello',
    );
  });
});

describe('TrendsView 未收录行 enrich：成功升 AppCard，失败留小行', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;
  let openUrlSpy: MockInstance<(url: string) => Promise<void>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    openUrlSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    openUrlSpy.mockRestore();
    cleanup();
  });

  /** apps 非空但与榜单零交集 → 全部走未收录分支（apps 为空会直接走空态）。 */
  function renderUncatalogedBoard() {
    const onQuickInstall = vi.fn();
    const utils = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    return { ...utils, onQuickInstall };
  }

  it('enrich 成功渲染 AppCard 行：描述 + 涨星徽标；右按钮直开 GitHub 且不走安装链', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
    const { container, onQuickInstall } = renderUncatalogedBoard();

    // 进 tab 即抓默认榜，enrich 作为跟随链运行。
    await clickTrendsRefresh();
    // enrich 后完整卡片：搜索式描述 + 涨星徽标（atlas 增量 1234 → 本周 +1.2k）
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card');
    expect(card).toBeTruthy();
    expect(card?.querySelector('.trend-gain')?.textContent).toBe('本周 +1.2k');
    // 无伪造 verified 徽标（enrich 口径 verified=false）
    expect(card?.querySelector('.app-tag-star')?.textContent).toContain('1.5k');

    // 右按钮（安装位）直开 GitHub，不调用父级安装链
    const actionBtn = card?.querySelector('.btn-install');
    expect(actionBtn).toBeTruthy();
    fireEvent.click(actionBtn!);
    expect(openUrlSpy).toHaveBeenCalledWith('https://github.com/acme/atlas');
    expect(onQuickInstall).not.toHaveBeenCalled();
    expect(container.querySelector('.trend-uncataloged-row')).toBeNull();
    // 现状：裸行直展升级富卡，全程无骨架空号。
    expect(screen.queryByTestId('trends-skeleton')).toBeNull();
    expect(container.querySelector('.trends-skeleton')).toBeNull();
  });

  it('enrich 失败保留旧小行，榜单永不因此变空', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderUncatalogedBoard();

    // board 落定即展裸行（仓库名+星），裸行即逃生。
    await clickTrendsRefresh();
    // 现状：board 落定即展裸行（仓库名+星），裸行即逃生。
    await screen.findByText('acme/atlas');
    // enrich 拒绝后仍为 3 个小行，无完整卡片，全程无骨架空号。
    await waitFor(() => {
      expect(enrichSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    });
    expect(container.querySelector('.app-card .app-desc')).toBeNull();
    expect(screen.queryByTestId('trends-skeleton')).toBeNull();
    expect(container.querySelector('.trends-skeleton')).toBeNull();
  });
});

describe('TrendsView 平台过滤与榜单口径计数', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;
  let openUrlSpy: MockInstance<(url: string) => Promise<void>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    openUrlSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    openUrlSpy.mockRestore();
    cleanup();
  });

  function renderBoard(extraProps?: {
    apps?: AppSummary[];
    allApps?: AppSummary[];
    selectedPlatforms?: ReadonlySet<string>;
    onDisplayPlatformCounts?: (counts: Record<string, number>) => void;
  }) {
    const catalogApps = extraProps?.apps ?? [makeApp({ id: 'other/app', name: 'Other' })];
    return render(
      <TrendsView
        apps={catalogApps}
        allApps={extraProps?.allApps}
        selectedPlatforms={extraProps?.selectedPlatforms}
        onDisplayPlatformCounts={extraProps?.onDisplayPlatformCounts}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
  }

  it('取消 Other：裸远端行加载中恒可见（loading 不看 Other 勾选）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderBoard({
      selectedPlatforms: new Set(['windows', 'macos', 'linux', 'ios', 'android']),
    });
    // 挂载即加载榜单；裸行未确认 Other 前 loading 恒可见
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    });
  });

  it('不传 selectedPlatforms 时不过滤（3 个裸行保留）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderBoard();
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    });
    expect(container.querySelector('.filter-empty-reset')).toBeNull();
  });

  it('收录命中行按其平台过滤：windows 收录在仅 ios+other 下直接消失（不降级为小行）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const atlas = makeApp({ id: 'acme/atlas', name: 'Atlas', platforms: ['windows'] });
    const { container } = renderBoard({
      apps: [atlas],
      allApps: [atlas],
      selectedPlatforms: new Set(['ios', 'other']),
    });
    await clickTrendsRefresh();
    await screen.findByText('acme/beacon');
    // atlas 行彻底消失；beacon/comet 以 other 身份保留为小行
    expect(container.textContent).not.toContain('Atlas');
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(2);
  });

  it('上报榜单分布：enrich 回填 [] 即 loading 不计数（全部桶为 0）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] })),
    );
    const onDisplayPlatformCounts = vi.fn();
    renderBoard({ onDisplayPlatformCounts });
    // 挂载即加载榜单，enrich 卡片出现；loading 空平台行不进任何桶
    await clickTrendsRefresh();
    // enrich 卡片出现后：loading 空平台行不进任何桶（确认/settle 落定后才计入 other）
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      const calls = onDisplayPlatformCounts.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last).toEqual({
        windows: 0,
        macos: 0,
        linux: 0,
        ios: 0,
        android: 0,
        other: 0,
      });
    });
  });

  it('上报榜单分布不随平台勾选变化：0/6 全不选时仍按全榜单计数', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] })),
    );
    const onDisplayPlatformCounts = vi.fn();
    const { container } = renderBoard({ selectedPlatforms: new Set<string>(), onDisplayPlatformCounts });
    await clickTrendsRefresh();
    await waitFor(() => {
      const calls = onDisplayPlatformCounts.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last?.windows).toBe(3);
    });
    // 主区仍被筛空
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
  });
});

describe('TrendsView 榜单选项卡记忆（zstore.trends.opts）', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.clear();
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    window.localStorage.clear();
    cleanup();
  });

  function renderBoard() {
    return render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
  }

  function activeTabLabel(container: HTMLElement): string | null {
    return container.querySelector('[role="tab"].active')?.textContent ?? null;
  }

  it('load/persist 单元：缺失→undefined，信封往返，非法/损坏→undefined', () => {
    expect(loadPersistedTrendBoard()).toBeUndefined();
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'monthly' }));
    expect(loadPersistedTrendBoard()).toBe('monthly');
    // 信封内非法榜名 → undefined（视为损坏）
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'top' }));
    expect(loadPersistedTrendBoard()).toBeUndefined();
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'category' }));
    expect(loadPersistedTrendBoard()).toBeUndefined();
    // 裸字符串（非 JSON）→ undefined
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, 'rising');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    // JSON-string 形 '"weekly"'：parse 一层后按 board 名接受
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"weekly"');
    expect(loadPersistedTrendBoard()).toBe('weekly');
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"healthy"');
    expect(loadPersistedTrendBoard()).toBe('healthy');
    // JSON-string 非法榜名 → undefined
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"top"');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"category"');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    // 裸数组等非信封一律拒绝
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '[]');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '["weekly"]');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    // 损坏载荷 → undefined（不抛错）
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '{bad');
    expect(loadPersistedTrendBoard()).toBeUndefined();
    persistTrendBoard('monthly');
    expect(window.localStorage.getItem(TREND_BOARD_STORAGE_KEY)).toBe(
      JSON.stringify({ board: 'monthly' }),
    );
  });

  it('resolveTrendBoard 非法输入返回 undefined（不抛错）：top/category/垃圾值', () => {
    expect(resolveTrendBoard('top')).toBeUndefined();
    expect(resolveTrendBoard('category')).toBeUndefined();
    expect(resolveTrendBoard('day')).toBeUndefined();
    expect(resolveTrendBoard('')).toBeUndefined();
    expect(resolveTrendBoard('WEEKLY')).toBeUndefined();
    expect(resolveTrendBoard('{"board":"weekly"}')).toBeUndefined();
    // 合法 6 榜直通
    for (const b of ['daily', 'weekly', 'monthly', 'new', 'rising', 'healthy'] as const) {
      expect(resolveTrendBoard(b)).toBe(b);
    }
  });

  it('跨 reload 恢复：切 monthly→重挂仍是 monthly 且首抓 monthly（走 L1→L2→网络，非 force）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const first = renderBoard();
    // 挂载即加载周榜，后再切榜
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    // 6 榜顺序 daily/weekly/monthly/new/rising/healthy → monthly 下标 2
    const tabs = first.container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(6);
    fireEvent.click(tabs[2]);
    expect(window.localStorage.getItem(TREND_BOARD_STORAGE_KEY)).toBe(
      JSON.stringify({ board: 'monthly' }),
    );
    // 子榜点击即抓新榜
    await clickTrendsRefresh();
    await waitFor(() => {
      expect(
        requestedUrls.some((u) => u.includes('github.com/trending') && u.includes('since=monthly')),
      ).toBe(true);
    });
    // 模拟重启：卸载 + 清内存 L1（localStorage 保留，按榜 TTL 的 L2 由缓存层判定，monthly 12h）
    first.unmount();
    cleanup();
    clearTrendsCache();
    requestedUrls.length = 0;
    const second = renderBoard();
    // 首绘即 monthly（同步恢复，无闪切）：active tab 直接为月趋势
    expect(activeTabLabel(second.container)).toBe('月趋势');
    // 重挂即抓 monthly
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    // 重启首抓走现有 L1→L2→网络路径：L1 已清、单测无 L2，即正常触发一次 monthly 抓取
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('since=monthly'))).toBe(true);
    });
    expect(requestedUrls.some((u) => u.includes('since=weekly'))).toBe(false);
  });

  it('信封内非法值归一 weekly：残留 top 直接展周榜', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'top' }));
    const { container } = renderBoard();
    expect(activeTabLabel(container)).toBe('周趋势');
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('since=weekly'))).toBe(true);
    });
  });

  it('非法残留 category/垃圾值/损坏载荷一律回落 weekly（不白屏）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    for (const payload of [
      JSON.stringify({ board: 'category' }),
      JSON.stringify({ board: 'nope' }),
      '"top"',
      '["weekly"]',
      '{bad',
    ]) {
      window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, payload);
      // load 侧一律 undefined（不抛错），边界回落 weekly 由 hook 保证
      expect(loadPersistedTrendBoard()).toBeUndefined();
      const { container, unmount } = renderBoard();
      // 首绘即周榜，无白屏抛错
      expect(activeTabLabel(container)).toBe('周趋势');
      await clickTrendsRefresh();
      await screen.findByText('acme/atlas');
      await waitFor(() => {
        expect(requestedUrls.some((u) => u.includes('since=weekly'))).toBe(true);
      });
      unmount();
      cleanup();
      clearTrendsCache();
      requestedUrls.length = 0;
    }
  });

  it('JSON-string 合法值恢复对应榜：weekly 首绘即周榜', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"weekly"');
    expect(loadPersistedTrendBoard()).toBe('weekly');
    const { container } = renderBoard();
    expect(activeTabLabel(container)).toBe('周趋势');
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
  });
});

describe('TrendsView 榜单刷新按钮（forceRefresh 直抓）', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.clear();
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    window.localStorage.clear();
    cleanup();
  });

  function renderBoard() {
    return render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
  }

  it('点击触发 forceRefresh 直抓：旧榜保留、触发新网络请求', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderBoard();
    // 挂载即加载默认榜（首抓走缓存允许路径）
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    const btn = screen.getByTestId('trends-refresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    const before = requestedUrls.length;
    expect(before).toBeGreaterThan(0);

    // 卡住刷新那次网络返回，断言 loading 态（禁用 + 转圈 + 旧榜仍在）。
    let release!: (v: string) => void;
    trendSpy.mockImplementationOnce(async (url: string) => {
      requestedUrls.push(String(url));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('.icon-spin')).toBeTruthy();
    expect(screen.getByText('acme/atlas')).toBeTruthy();

    release(trendingHtml as string);
    await waitFor(() => {
      expect((screen.getByTestId('trends-refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    // 直抓穿透 L1：同 key 仍产生一次新的网络请求。
    expect(requestedUrls.length).toBe(before + 1);
    expect(screen.getByText('acme/atlas')).toBeTruthy();
  });

  it('进入趋势榜首次加载中：右侧刷新按钮同步禁用并转圈，落定后停止转圈', async () => {
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    let release!: (v: string) => void;
    trendSpy.mockImplementationOnce(async (url: string) => {
      requestedUrls.push(String(url));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    const { container } = renderBoard();
    const btn = screen.getByTestId('trends-refresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('.icon-spin')).toBeTruthy();

    await waitFor(() => {
      expect(typeof release).toBe('function');
    });
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('.icon-spin')).toBeTruthy();

    release(trendingHtmlFixture());
    await screen.findByText('acme/atlas');
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('.icon-spin')).toBeNull();
  });

  it('刷新失败走现有 error lane（不弹框，按钮恢复可用）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    renderBoard();
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas');
    // 后续抓取一律 500：刷新穿透缓存必中失败。
    trendingStatus = 500;
    fireEvent.click(screen.getByTestId('trends-refresh'));
    await screen.findByText('榜单加载失败');
    expect((screen.getByTestId('trends-refresh') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('TrendsView L2可信分档：具平台免验，loading后台补验', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  type LiteFn = (id: string) => Promise<{ id: string; platforms: string[]; is_stale: boolean }>;
  let enrichSpy: MockInstance<EnrichFn>;
  let liteSpy: MockInstance<LiteFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;
  let openUrlSpy: MockInstance<(url: string) => Promise<void>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.clear();
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    // 恢复顶层 fetchTrendsText mock（被 restoreAllMocks 清掉后重建，避免 unexpected url）。
    trendSpy = vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('github.com/trending')) {
        if (trendingHtml instanceof Error) throw trendingHtml;
        if (trendingStatus != null) throw httpErr(trendingStatus);
        return trendingHtml;
      }
      throw new Error(`unexpected url: ${u}`);
    });
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    openUrlSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    liteSpy?.mockRestore();
    settingsSpy.mockRestore();
    openUrlSpy.mockRestore();
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
  });

  function renderLiteBoard() {
    return render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        platformResolvedOtherIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
  }

  it('L2全具平台零lite：三仓新鲜具平台直展富卡，后台零补验', async () => {
    // L2 新鲜富信封：三仓均为具真实平台（与 trendingHtmlFixture 三仓同坐标）。
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: ['macos'] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: ['linux'] }),
    });
    trendingHtml = trendingHtmlFixture();
    vi.mocked(zlogInfo).mockClear();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
    liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockImplementation(async (id: string) => ({ id, platforms: ['windows'], is_stale: false }));
    const { container } = renderLiteBoard();

    // 挂载即加载周榜，SWR 直展三富卡，无裸行占位。
    await clickTrendsRefresh();
    // 首屏直展三富卡，无裸行占位。
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(3);
    // 后台 effect flush 窗口内仍零请求：enrich 无缺席不拉，lite 全具平台免验。
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(liteSpy).not.toHaveBeenCalled();
  });

  it('含平台未知卡则仅其补验：具平台直展，未知卡免 enrich 只经 lite 落定', async () => {
    // 池内三态：atlas 具平台直展免验；beacon/comet 为平台未知的新鲜卡壳，
    // 卡片元数据免 enrich，仅走 lite 推导平台（beacon 治愈为具平台，comet 确认为空 Other）。
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: [] }),
    });
    trendingHtml = trendingHtmlFixture();
    vi.mocked(zlogInfo).mockClear();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] })),
    );
    liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      const k = String(id).trim().toLowerCase();
      // beacon 治愈为具平台，comet 确认为空 Other（空非 stale）。
      if (k === 'acme/beacon') return { id, platforms: ['macos'], is_stale: false };
      return { id, platforms: [], is_stale: false };
    });
    const { container } = renderLiteBoard();

    // 挂载即加载周榜；三张卡均由池内新鲜卡直展。
    await clickTrendsRefresh();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(liteSpy.mock.calls.length).toBeGreaterThan(0);
    });
    await new Promise((r) => setTimeout(r, 50));
    const calledIds = liteSpy.mock.calls.map(([id]) => String(id).trim().toLowerCase());
    expect(calledIds).toHaveLength(2);
    expect(calledIds).toContain('acme/beacon');
    expect(calledIds).toContain('acme/comet');
    expect(calledIds.some((id) => id === 'acme/atlas')).toBe(false);
    // 新鲜卡片不重拉元数据。
    expect(enrichSpy).not.toHaveBeenCalled();
    // 回来即 patch/确认后富卡齐展，不闪裸：仍零裸行，富卡描述保留。
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(screen.getByText('acme/beacon enriched desc')).toBeTruthy();
  });
});

describe('图标唯一通道：icon-ready → admitIconHit（无窗口总线）', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;
  let openUrlSpy: MockInstance<(url: string) => Promise<void>>;
  let fetchIconSpy: MockInstance<(appId: string | undefined, remoteUrl: string) => Promise<string>>;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.clear();
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    // 恢复顶层 fetchTrendsText mock（被 restoreAllMocks 清掉后重建）。
    trendSpy = vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('github.com/trending')) {
        if (trendingHtml instanceof Error) throw trendingHtml;
        if (trendingStatus != null) throw httpErr(trendingStatus);
        return trendingHtml;
      }
      throw new Error(`unexpected url: ${u}`);
    });
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    openUrlSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    fetchIconSpy = vi
      .spyOn(tauriApi, 'getOrFetchIcon')
      .mockImplementation(async () => 'data:image/png;base64,AAA');
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    openUrlSpy.mockRestore();
    fetchIconSpy.mockRestore();
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
  });

  it('dispatch icon-changed 对行内图标零效果（图标唯一经 icon-ready 通道）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) =>
        makeEnrichedApp({
          id: `${r.owner}/${r.repo}`,
          icon: 'https://example.com/icons/atlas.png',
          platforms: ['windows'],
        }),
      ),
    );
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    await clickTrendsRefresh();
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card') as HTMLElement;
    expect(card).toBeTruthy();
    // 初态有图：远端 URL 直显（店内写口预热后台进行，不阻塞首绘）
    await waitFor(() => {
      expect(card.querySelector('img.app-icon-image')).toBeTruthy();
    });

    // 未订阅 `zstore:icon-changed` 窗口事件：dispatch 后行内图标保持不动（不跟随、不裂图）
    window.dispatchEvent(
      new CustomEvent('zstore:icon-changed', { detail: { appId: 'acme/atlas', icon: '' } }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(card.querySelector('img.app-icon-image')).toBeTruthy();
    expect(card.querySelector('.app-icon-fallback-badge')).toBeNull();
    expect(card.querySelector('img[src=""]')).toBeNull();
    expect(container.querySelector('img[src=""]')).toBeNull();
  });

  it('L5 清零语义收口 board 纯函数（与 admitIconHit 空守卫同口径，不复活旧图）', async () => {
    const prev: Record<string, AppSummary> = {
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        icon: 'https://example.com/icons/atlas.png',
        platforms: ['windows'],
      }),
    };
    const next = patchIconMirror(prev, 'acme/atlas', '');
    expect(next['acme/atlas'].icon).toBe('');
  });
});
