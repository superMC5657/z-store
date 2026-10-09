/**
 * 趋势数据层测试（严格一榜一源）。
 *
 * 每榜单一主源，无任何榜单内降级链，失败按 TrendsResult 错误契约返回
 * （UI lane 依赖，保持 STABLE）：
 * daily/weekly/monthly → github.com/trending HTML（?since=daily|weekly|monthly），
 *   增量取页面真实文本 `N stars today|this week|this month`；
 * rising/healthy → doforce 公开 API（单飞共享一次抓取 + 12h 共享缓存；
 *   rising 按 change，healthy 按 forks + change 各自排序）；
 * new → GitHub search（created 6mo 窗口，starsGained 恒为 undefined）。
 * 已删除：OSSInsight、HN Algolia、时间榜 GitHub-Search 兜底。
 *
 * 核心断言：
 * - rising/healthy 单飞共享：并发与随后调用只产生一次远端抓取；
 *   时间榜永不触碰 api.github.com；ossinsight/hn 永不出现）；
 * - 429 恰好重试一次（Retry-After 秒数/HTTP-date，上限 60s），仍败则 error；
 * - 解析规则：单数/逗号/缺 span/三段链接跳过/k 缩写；
 * - errorKind 映射（403/429→rate-limited，Abort→timeout，TypeError→network）；
 * - 成功（非空）才写 5 分钟缓存；`fetchTrends` 签名兼容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import type { AppSummary } from '../types';
import { TrendsView } from './TrendsView';
import * as trendsModule from '../services/trends';
import {
  buildDoforceUrl,
  buildTrendingUrl,
  buildTrendsCacheKey,
  CACHE_TTL_MS,
  classifyTrendsError,
  clearTrendEnrichCache,
  clearTrendsCache,
  fetchGitHubNewRepos,
  fetchDoforceRepos,
  fetchTrendingRepos,
  fetchTrends,
  fetchTrendsResult,
  filterNewReposFallback,
  formatStars,
  DOFORCE_CACHE_TTL_MS,
  DOFORCE_RETRY_DEFAULT_WAIT_MS,
  DOFORCE_RETRY_MAX_WAIT_MS,
  DOFORCE_TIMEOUT_MS,
  DOFORCE_URL,
  GITHUB_SEARCH_TIMEOUT_MS,
  doforceRetryDelayMs,
  enrichTrendRepos,
  growthRatio,
  healthyScore,
  hydrateTrendEnrichCache,
  matchCatalogApp,
  normalizeProxyPrefix,
  parseCompactNumber,
  parseRetryAfterMs,
  parseTrendingHtml,
  rankByGrowthRatio,
  sortByHealthyScore,
  trendsBoardTtlMs,
  TRENDING_SINCE,
  TRENDING_TIMEOUT_MS,
  TREND_ENRICH_CACHE_TTL_MS,
  withTrendsProxy,
} from '../services/trends';
import {
  boardFixture,
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

function trendingUrls() {
  return requestedUrls.filter((u) => u.includes('github.com/trending'));
}

function doforceUrls() {
  return requestedUrls.filter((u) => u.includes('trend.doforce.dpdns.org'));
}

function gitHubApiUrls() {
  return requestedUrls.filter((u) => u.includes('api.github.com'));
}

describe('P0: 旧加权公式与 dead 数据源已彻底删除', () => {
  it('不再导出 sortAppsLocally / OSSInsight / HN / GitHub 窗口兜底', () => {
    for (const name of [
      'sortAppsLocally',
      'fetchOSSInsightRepos',
      'fetchHNRepos',
      'fetchGitHubWindowRepos',
      'buildGitHubWindowQuery',
      'BOARD_TO_PERIOD',
    ]) {
      expect(name in trendsModule, name).toBe(false);
    }
  });

  it('CACHE_TTL_MS 保持 5 分钟，主源熔断均为 10s', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(TRENDING_TIMEOUT_MS).toBe(10_000);
    expect(DOFORCE_TIMEOUT_MS).toBe(10_000);
    expect(GITHUB_SEARCH_TIMEOUT_MS).toBe(10_000);
  });

  it('按榜 TTL：日榜 1h，周/月榜 12h，新榜回落 5 分钟', () => {
    expect(trendsBoardTtlMs('daily')).toBe(60 * 60 * 1000);
    expect(trendsBoardTtlMs('weekly')).toBe(12 * 60 * 60 * 1000);
    expect(trendsBoardTtlMs('monthly')).toBe(12 * 60 * 60 * 1000);
    expect(trendsBoardTtlMs('new')).toBe(CACHE_TTL_MS);
  });

  it('TRENDING_SINCE 一榜一参 + DOFORCE_URL 稳定', () => {
    expect(TRENDING_SINCE).toEqual({ daily: 'daily', weekly: 'weekly', monthly: 'monthly' });
    expect(DOFORCE_URL).toBe('https://trend.doforce.dpdns.org/repo');
    expect(buildDoforceUrl()).toBe('https://trend.doforce.dpdns.org/repo');
  });

  it('非法 board（旧 period / 已下线榜单）直接抛错', async () => {
    await expect(fetchTrends('day' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('week' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrends('all' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrends('top' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('top' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrends('category' as never)).rejects.toThrow(/unknown board/);
    await expect(fetchTrendsResult('category' as never)).rejects.toThrow(/unknown board/);
    expect(trendSpy).not.toHaveBeenCalled();
  });

  it('缓存键 = board + language + category', () => {
    expect(buildTrendsCacheKey('weekly')).toBe('weekly||');
    // C3 key归一：language/category 统一 trim().toLowerCase()
    expect(buildTrendsCacheKey('weekly', { language: 'Python' })).toBe('weekly|python|');
    expect(buildTrendsCacheKey('healthy', { category: 'media' })).toBe('healthy||media');
    expect(buildTrendsCacheKey('weekly', { language: 'Go', category: 'dev' })).toBe('weekly|go|dev');
    expect(buildTrendsCacheKey('weekly', { language: ' Python ', category: ' Media ' })).toBe(
      'weekly|python|media',
    );
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
    expect(buildTrendingUrl('daily')).toBe('https://github.com/trending?since=daily');
  });

  it('language 走 /trending/<lang> 路径段（all/空不追加）', async () => {
    trendingHtml = trendingHtmlFixture();
    await fetchTrends('weekly', { language: 'Python' });
    expect(trendingUrls()[0]).toBe('https://github.com/trending/Python?since=weekly');
    expect(buildTrendingUrl('weekly', { language: 'all' })).toBe(
      'https://github.com/trending?since=weekly',
    );
  });

  it('解析规则：增量/总量/身份/缺失口径', async () => {
    expect(parseTrendingHtml('')).toEqual([]);
    const parsed = parseTrendingHtml(trendingHtmlFixture());
    const [atlas, beacon, comet] = parsed;
    // atlas：逗号增量 + 总量 + 描述
    expect(atlas.id).toBe('acme/atlas');
    expect(atlas.starsGained).toBe(1234);
    expect(atlas.stars).toBe(12000);
    expect(atlas.forks).toBe(400);
    expect(atlas.description).toBe('Atlas desc');
    expect(atlas.url).toBe('https://github.com/acme/atlas');
    // beacon：单数 "1 star today" + 缺 forks 链接
    expect(beacon.starsGained).toBe(1);
    expect(beacon.stars).toBe(1500);
    expect(beacon.forks).toBeUndefined();
    // comet：三段 /stargazers 链接在前仍正确取身份；无增量 span；k 缩写；无描述
    expect(comet.id).toBe('acme/comet');
    expect(comet.starsGained).toBeUndefined();
    expect(comet.stars).toBe(1200);
    expect(comet.forks).toBe(60);
    expect(comet.description).toBeUndefined();
  });

  it('fetchTrendingRepos 直接可用（有代理也恒直连）', async () => {
    trendingHtml = trendingHtmlFixture();
    const repos = await fetchTrendingRepos('daily', { proxyPrefix: 'https://gh-proxy.com' });
    expect(repoIds(repos)).toHaveLength(3);
    expect(trendingUrls()[0].startsWith('https://gh-proxy.com')).toBe(false);
    expect(trendingUrls()[0]).toBe('https://github.com/trending?since=daily');
  });

  it('parseCompactNumber：逗号/k/m/非法', () => {
    expect(parseCompactNumber('1,234')).toBe(1234);
    expect(parseCompactNumber('1.2k')).toBe(1200);
    expect(parseCompactNumber('2M')).toBe(2_000_000);
    expect(parseCompactNumber('56')).toBe(56);
    expect(parseCompactNumber('n/a')).toBeUndefined();
  });

  it('经 Rust 命令抓取，不再使用 WebView raw fetch', async () => {
    trendingHtml = trendingHtmlFixture();
    doforceItems = doforceFixture();
    await fetchTrendsResult('daily');
    await fetchTrendsResult('rising', { forceRefresh: true });
    expect(trendSpy).toHaveBeenCalled();
    expect(rawFetchMock).not.toHaveBeenCalled();
  });

  it('空页 => empty；HTTP 500 => error/unavailable（经 z-log 落盘）', async () => {
    trendingHtml = '<div class="Box"></div>';
    await expect(fetchTrendsResult('daily')).resolves.toEqual({ repos: [], status: 'empty' });
    trendingStatus = 500;
    vi.mocked(zlogWarn).mockClear();
    await expect(fetchTrendsResult('weekly', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'error',
      errorKind: 'unavailable',
    });
    const warns = vi.mocked(zlogWarn).mock.calls.map(([m]) => String(m));
    expect(warns.some((m) => m.includes('board=weekly') && m.includes('unavailable'))).toBe(true);
  });

  it('成功经 z-log 记录 board/source/count', async () => {
    trendingHtml = trendingHtmlFixture();
    vi.mocked(zlogInfo).mockClear();
    await fetchTrendsResult('daily');
    const infos = vi.mocked(zlogInfo).mock.calls.map(([m]) => String(m));
    expect(
      infos.some((m) => m.includes('board=daily') && m.includes('trending-html') && m.includes('count=3')),
    ).toBe(true);
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
    await fetchTrends('weekly', { language: 'Python' });
    await fetchTrends('weekly', { language: 'Python' });
    expect(trendingUrls()).toHaveLength(1);
    await fetchTrends('weekly', { language: 'Python', forceRefresh: true });
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
    // 随后调用命中 12h 共享缓存，不再抓取
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
      await vi.advanceTimersByTimeAsync(DOFORCE_RETRY_DEFAULT_WAIT_MS);
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

  it('parseRetryAfterMs：秒数/HTTP-date/非法', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('nope')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20_000);
  });

  it('doforceRetryDelayMs：默认等待与上限', () => {
    expect(DOFORCE_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(DOFORCE_RETRY_MAX_WAIT_MS).toBe(60_000);
    const plain429 = new Error('trends: upstream status 429') as Error & { status: number };
    plain429.status = 429;
    expect(doforceRetryDelayMs(plain429)).toBe(DOFORCE_RETRY_DEFAULT_WAIT_MS);
    const over = new Error('trends: upstream status 429, retry-after: 3600') as Error & {
      status: number;
    };
    over.status = 429;
    expect(doforceRetryDelayMs(over)).toBeUndefined();
  });

  it('doforce 空源 => empty（空结果不进共享缓存）', async () => {
    doforceItems = [];
    await expect(fetchTrendsResult('healthy', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'empty',
    });
    await expect(fetchTrendsResult('rising', { forceRefresh: true })).resolves.toEqual({
      repos: [],
      status: 'empty',
    });
    expect(doforceUrls()).toHaveLength(2);
  });

  it('fetchDoforceRepos 直接可用（恒直连）', async () => {
    doforceItems = doforceFixture();
    const repos = await fetchDoforceRepos();
    expect(repos).toHaveLength(3);
    expect(doforceUrls()[0]).toBe('https://trend.doforce.dpdns.org/repo');
  });
});

describe('代理策略：趋势流量恒直连（proxyPrefix 被忽略，仅保留兼容）', () => {
  it('normalizeProxyPrefix：direct/空 => undefined，ghproxy => 默认前缀', () => {
    expect(normalizeProxyPrefix(undefined)).toBeUndefined();
    expect(normalizeProxyPrefix('')).toBeUndefined();
    expect(normalizeProxyPrefix('direct')).toBeUndefined();
    expect(normalizeProxyPrefix('ghproxy')).toBe('https://gh-proxy.com');
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
    // withTrendsProxy 为恒等函数（@deprecated，仅保留兼容）
    expect(withTrendsProxy('https://github.com/trending?since=daily', { proxyPrefix: proxy })).toBe(
      'https://github.com/trending?since=daily',
    );
    expect(withTrendsProxy('https://trend.doforce.dpdns.org/repo', { proxyPrefix: proxy })).toBe(
      'https://trend.doforce.dpdns.org/repo',
    );
    expect(
      withTrendsProxy('https://api.github.com/search/repositories?q=x', { proxyPrefix: proxy }),
    ).toBe('https://api.github.com/search/repositories?q=x');
  });

  it('未设置代理时保持官方直连', async () => {
    trendingHtml = trendingHtmlFixture();
    await fetchTrends('weekly');
    for (const u of requestedUrls) {
      expect(u.startsWith('https://gh-proxy.com')).toBe(false);
    }
    expect(withTrendsProxy('https://github.com/trending?since=daily', {})).toBe(
      'https://github.com/trending?since=daily',
    );
  });
});

describe('错误契约 classifyTrendsError（UI lane 依赖）', () => {
  it('403/429→rate-limited，Abort→timeout，TypeError→network', () => {
    expect(classifyTrendsError(new Error('x'), 403)).toBe('rate-limited');
    expect(classifyTrendsError(new Error('x'), 429)).toBe('rate-limited');
    expect(classifyTrendsError(abortError())).toBe('timeout');
    expect(classifyTrendsError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyTrendsError(new Error('boom'), 500)).toBe('unavailable');
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
    });
  });

  it('fetchGitHubNewRepos 直接可用', async () => {
    ghItems = [ghItem];
    const repos = await fetchGitHubNewRepos();
    expect(repoIds(repos)).toEqual(['acme/nova']);
  });
});

describe('保留的纯函数与兼容入口', () => {
  it('增速比公式 = starsGained / max(1, stars - starsGained)', () => {
    const [atlas, dune, beacon, comet] = boardFixture();
    expect(growthRatio(comet)).toBeCloseTo(380 / 20);
    expect(growthRatio(beacon)).toBeCloseTo(1400 / 100);
    expect(growthRatio(dune)).toBeCloseTo(2500 / 6500);
    expect(growthRatio(atlas)).toBeCloseTo(120 / 11880);
    expect(healthyScore(dune)).toBe(100 + 2500);
  });

  it('纯函数：rising / healthy / new兜底排序分叉', () => {
    const fixture = boardFixture();
    const rising = repoIds(rankByGrowthRatio(fixture));
    const healthy = repoIds(sortByHealthyScore(fixture));
    const fresh = repoIds(filterNewReposFallback(fixture));
    expect(rising).toEqual(['acme/comet', 'acme/beacon', 'acme/dune', 'acme/atlas']);
    expect(healthy).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas', 'acme/comet']);
    expect(fresh).toEqual(['acme/beacon', 'acme/comet']);
    const orders = new Set([rising, healthy, fresh].map((o) => o.join(',')));
    expect(orders.size).toBe(3);
  });

  it('fetchTrends 保持签名兼容（委托 Result，仅返回 repos）', async () => {
    trendingHtml = trendingHtmlFixture();
    const repos = await fetchTrends('weekly');
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
    const [atlas] = boardFixture();
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

describe('enrichTrendRepos service：逐仓 12h 记忆，失败项缺席', () => {
  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;

  afterEach(() => {
    enrichSpy?.mockRestore();
  });

  function mockEnrichOk() {
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
  }

  it('enrich 缓存 TTL 12h（与 doforce 快照同口径，榜单 TTL 不变）', () => {
    expect(TREND_ENRICH_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('命中走记忆：同坐标二次调用不再触达后端', async () => {
    mockEnrichOk();
    const repos = [
      makeTrendRepo({ id: 'acme/atlas', stars: 12000 }),
      makeTrendRepo({ id: 'acme/beacon', stars: 1500 }),
    ];
    const first = await enrichTrendRepos(repos);
    expect(first.get('acme/atlas')?.description).toBe('acme/atlas enriched desc');
    expect(first.get('acme/beacon')?.stars).toBe(1500);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    // 大小写坐标归一命中同一缓存条目
    const second = await enrichTrendRepos([
      makeTrendRepo({ id: 'ACME/ATLAS', stars: 12000 }),
    ]);
    expect(second.get('acme/atlas')?.id).toBe('acme/atlas');
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });

  it('null 项不进缓存：下次重试再次请求后端', async () => {
    enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockResolvedValueOnce([null])
      .mockImplementation(async (repos) =>
        repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
      );
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    expect((await enrichTrendRepos(repos)).size).toBe(0);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    const retry = await enrichTrendRepos(repos);
    expect(retry.get('acme/atlas')?.id).toBe('acme/atlas');
    expect(enrichSpy).toHaveBeenCalledTimes(2);
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
  });

  it('enrich 失败保留旧小行，榜单永不因此变空', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderUncatalogedBoard();

    // 加载期小行占位先出现
    await screen.findByText('acme/atlas');
    // enrich 拒绝后仍为 3 个小行，无完整卡片
    await waitFor(() => {
      expect(enrichSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    });
    expect(container.querySelector('.app-card .app-desc')).toBeNull();
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

  it('取消 Other 隐藏全部裸远端行并进入筛选为空态（而非完整列表）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderBoard({
      selectedPlatforms: new Set(['windows', 'macos', 'linux', 'ios', 'android']),
    });
    // 榜单加载后：无可见行，且渲染筛选为空引导（带重置入口）
    await screen.findByText('当前设备筛选下暂无上榜应用');
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    expect(container.querySelector('.app-card')).toBeNull();
    expect(container.querySelector('.filter-empty-reset')).toBeTruthy();
  });

  it('不传 selectedPlatforms 时不过滤（旧行为：3 个裸行保留）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = renderBoard();
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
    await screen.findByText('acme/beacon');
    // atlas 行彻底消失；beacon/comet 以 other 身份保留为小行
    expect(container.textContent).not.toContain('Atlas');
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(2);
  });

  it('上报榜单分布：enrich 回填 [] 即计 other（windows 桶为 0）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] })),
    );
    const onDisplayPlatformCounts = vi.fn();
    renderBoard({ onDisplayPlatformCounts });
    // enrich 卡片出现后，最终上报口径为 other 3、其余 0
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
        other: 3,
      });
    });
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

  it('load/persist 单元：缺失→undefined，信封往返，非法/损坏→weekly', () => {
    expect(loadPersistedTrendBoard()).toBeUndefined();
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'monthly' }));
    expect(loadPersistedTrendBoard()).toBe('monthly');
    // 已下线残留榜回落 weekly（SSOT resolve）
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'top' }));
    expect(loadPersistedTrendBoard()).toBe('weekly');
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'category' }));
    expect(loadPersistedTrendBoard()).toBe('weekly');
    // 裸字符串 / JSON 字符串兼容
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, 'rising');
    expect(loadPersistedTrendBoard()).toBe('rising');
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '"healthy"');
    expect(loadPersistedTrendBoard()).toBe('healthy');
    // 损坏载荷回落 weekly（不抛错）
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, '{bad');
    expect(loadPersistedTrendBoard()).toBe('weekly');
    persistTrendBoard('monthly');
    expect(window.localStorage.getItem(TREND_BOARD_STORAGE_KEY)).toBe(
      JSON.stringify({ board: 'monthly' }),
    );
  });

  it('跨 reload 恢复：切 monthly→重挂仍是 monthly 且首抓 monthly（走 L1→L2→网络，非 force）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const first = renderBoard();
    await screen.findByText('acme/atlas');
    // 6 榜顺序 daily/weekly/monthly/new/rising/healthy → monthly 下标 2
    const tabs = first.container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(6);
    fireEvent.click(tabs[2]);
    expect(window.localStorage.getItem(TREND_BOARD_STORAGE_KEY)).toBe(
      JSON.stringify({ board: 'monthly' }),
    );
    await waitFor(() => {
      expect(
        requestedUrls.some((u) => u.includes('github.com/trending') && u.includes('since=monthly')),
      ).toBe(true);
    });
    // 模拟重启：卸载 + 清内存 L1（localStorage 保留，上限 12h 的 L2 由缓存层判定）
    first.unmount();
    cleanup();
    clearTrendsCache();
    requestedUrls.length = 0;
    const second = renderBoard();
    // 首绘即 monthly（同步恢复，无闪切）：active tab 直接为月趋势
    expect(activeTabLabel(second.container)).toBe('月趋势');
    await screen.findByText('acme/atlas');
    // 重启首抓走现有 L1→L2→网络路径：L1 已清、单测无 L2，即正常触发一次 monthly 抓取
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('since=monthly'))).toBe(true);
    });
    expect(requestedUrls.some((u) => u.includes('since=weekly'))).toBe(false);
  });

  it('非法值回落 weekly：残留 top 直接展周榜', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    window.localStorage.setItem(TREND_BOARD_STORAGE_KEY, JSON.stringify({ board: 'top' }));
    const { container } = renderBoard();
    expect(activeTabLabel(container)).toBe('周趋势');
    await screen.findByText('acme/atlas');
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('since=weekly'))).toBe(true);
    });
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

  it('点击触发 forceRefresh 直抓：旧榜保留、无缓存命中日志', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    vi.mocked(zlogInfo).mockClear();
    const { container } = renderBoard();
    await screen.findByText('acme/atlas');
    const btn = screen.getByTestId('trends-refresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    // 首抓走完后清零：只观察刷新这次抓取。
    vi.mocked(zlogInfo).mockClear();
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
    expect(container.querySelector('.trends-refresh-spin')).toBeTruthy();
    expect(screen.getByText('acme/atlas')).toBeTruthy();

    release(trendingHtml as string);
    await waitFor(() => {
      expect((screen.getByTestId('trends-refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    // 直抓穿透 L1：同 key 仍产生一次新的网络请求。
    expect(requestedUrls.length).toBe(before + 1);
    expect(screen.getByText('acme/atlas')).toBeTruthy();
    const infos = vi.mocked(zlogInfo).mock.calls.map(([m]) => String(m));
    expect(infos.some((m) => m.toLowerCase().includes('cache hit'))).toBe(false);
  });

  it('刷新失败走现有 error lane（不弹框，按钮恢复可用）', async () => {
    trendingHtml = trendingHtmlFixture();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    renderBoard();
    await screen.findByText('acme/atlas');
    // 后续抓取一律 500：刷新穿透缓存必中失败。
    trendingStatus = 500;
    fireEvent.click(screen.getByTestId('trends-refresh'));
    await screen.findByText('榜单加载失败');
    expect((screen.getByTestId('trends-refresh') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('TrendsView L2可信分档：具平台免验，pending后台补验', () => {
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
    hydrateTrendEnrichCache({
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
    // 免验取证单行日志：每次决策记录 board/可信 concrete/pending/跳过/目标（无 DevTools 可查）。
    await waitFor(() => {
      const infos = vi.mocked(zlogInfo).mock.calls.map(([m]) => String(m));
      expect(
        infos.some(
          (m) =>
            m.includes('[trends] lite-skip') &&
            m.includes('board=weekly') &&
            m.includes('trustedConcrete=3') &&
            m.includes('trustedPending=0') &&
            m.includes('skipped=3') &&
            m.includes('targets=0'),
        ),
      ).toBe(true);
    });
  });

  it('含pending则仅pending补验：首屏展旧卡不闪裸，回来patch仍无裸行', async () => {
    // L2 新鲜混合：atlas 具平台免验，beacon/comet pending 首屏展旧卡、后台补验。
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: [] }),
    });
    trendingHtml = trendingHtmlFixture();
    vi.mocked(zlogInfo).mockClear();
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
    liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      const k = String(id).trim().toLowerCase();
      // beacon 治愈为具平台，comet 确认为空 Other（空非 stale）。
      if (k === 'acme/beacon') return { id, platforms: ['macos'], is_stale: false };
      return { id, platforms: [], is_stale: false };
    });
    const { container } = renderLiteBoard();

    // 首屏先展旧卡（含 pending 富卡），不闪裸行。
    await screen.findByText('acme/atlas enriched desc');
    await screen.findByText('acme/beacon enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    // enrich 无缺席不拉；lite 仅补 pending。
    await waitFor(() => {
      expect(liteSpy.mock.calls.length).toBeGreaterThan(0);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichSpy).not.toHaveBeenCalled();
    const calledIds = liteSpy.mock.calls.map(([id]) => String(id).trim().toLowerCase());
    expect(calledIds).toHaveLength(2);
    expect(calledIds).toContain('acme/beacon');
    expect(calledIds).toContain('acme/comet');
    expect(calledIds.some((id) => id === 'acme/atlas')).toBe(false);
    // 回来即 patch 不闪裸：仍零裸行，富卡描述保留。
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(screen.getByText('acme/beacon enriched desc')).toBeTruthy();
    // 免验取证单行日志：混合档仅 pending 补验（atlas 免验，beacon/comet 为目标）。
    await waitFor(() => {
      const infos = vi.mocked(zlogInfo).mock.calls.map(([m]) => String(m));
      expect(
        infos.some(
          (m) =>
            m.includes('[trends] lite-skip') &&
            m.includes('board=weekly') &&
            m.includes('trustedConcrete=1') &&
            m.includes('trustedPending=2') &&
            m.includes('skipped=1') &&
            m.includes('targets=2'),
        ),
      ).toBe(true);
    });
  });
});
