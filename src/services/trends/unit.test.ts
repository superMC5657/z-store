/** trends 内部解析、缓存键值与重试延时单元测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import {
  CACHE_TTL_MS,
  DOFORCE_CACHE_TTL_MS,
  DOFORCE_RETRY_DEFAULT_WAIT_MS,
  DOFORCE_RETRY_MAX_WAIT_MS,
  buildTrendsCacheKey,
  clearTrendsCache,
  trendsBoardTtlMs,
} from './cache';
import {
  TREND_ENRICH_CACHE_TTL_MS,
  clearTrendEnrichCache,
  enrichTrendRepos,
} from './enrich';
import {
  classifyTrendsError,
  doforceRetryDelayMs,
  healthyScore,
  parseCompactNumber,
  parseRetryAfterMs,
  parseTrendingHtml,
  sortByHealthyScore,
} from './parse';
import {
  boardFixture,
  makeEnrichedApp,
  makeTrendRepo,
  repoIds,
  trendingHtmlFixture,
} from '../../views/test-utils/trendFixture';

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

describe('trends 缓存常量契约', () => {
  it('CACHE_TTL_MS 保持 5 分钟', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('按榜 TTL：日榜 1h，周/月/新榜 12h', () => {
    expect(trendsBoardTtlMs('daily')).toBe(60 * 60 * 1000);
    expect(trendsBoardTtlMs('weekly')).toBe(12 * 60 * 60 * 1000);
    expect(trendsBoardTtlMs('monthly')).toBe(12 * 60 * 60 * 1000);
    expect(trendsBoardTtlMs('new')).toBe(12 * 60 * 60 * 1000);
  });

  it('缓存键 = board + language + category', () => {
    expect(buildTrendsCacheKey('weekly')).toBe('weekly||');
    expect(buildTrendsCacheKey('weekly', { language: 'Python' })).toBe('weekly|python|');
    expect(buildTrendsCacheKey('healthy', { category: 'media' })).toBe('healthy||media');
    expect(buildTrendsCacheKey('weekly', { language: 'Go', category: 'dev' })).toBe('weekly|go|dev');
    expect(buildTrendsCacheKey('weekly', { language: ' Python ', category: ' Media ' })).toBe(
      'weekly|python|media',
    );
  });
});

describe('trends parse 纯函数契约', () => {
  it('parseTrendingHtml：增量/总量/身份/缺失口径', () => {
    expect(parseTrendingHtml('')).toEqual([]);
    const parsed = parseTrendingHtml(trendingHtmlFixture());
    const [atlas, beacon, comet] = parsed;
    expect(atlas.id).toBe('acme/atlas');
    expect(atlas.starsGained).toBe(1234);
    expect(atlas.stars).toBe(12000);
    expect(atlas.forks).toBe(400);
    expect(atlas.description).toBe('Atlas desc');
    expect(atlas.url).toBe('https://github.com/acme/atlas');
    expect(beacon.starsGained).toBe(1);
    expect(beacon.stars).toBe(1500);
    expect(beacon.forks).toBeUndefined();
    expect(comet.id).toBe('acme/comet');
    expect(comet.starsGained).toBeUndefined();
    expect(comet.stars).toBe(1200);
    expect(comet.forks).toBe(60);
    expect(comet.description).toBeUndefined();
  });

  it('parseCompactNumber：逗号/k/m/非法', () => {
    expect(parseCompactNumber('1,234')).toBe(1234);
    expect(parseCompactNumber('1.2k')).toBe(1200);
    expect(parseCompactNumber('2M')).toBe(2_000_000);
    expect(parseCompactNumber('56')).toBe(56);
    expect(parseCompactNumber('n/a')).toBeUndefined();
  });

  it('parseRetryAfterMs 与 doforceRetryDelayMs：秒数/HTTP-date/上限/默认等待', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('nope')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20_000);

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

  it('classifyTrendsError：403/429→rate-limited，Abort→timeout，TypeError→network', () => {
    expect(classifyTrendsError(new Error('x'), 403)).toBe('rate-limited');
    expect(classifyTrendsError(new Error('x'), 429)).toBe('rate-limited');
    expect(classifyTrendsError(abortError())).toBe('timeout');
    expect(classifyTrendsError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyTrendsError(new Error('boom'), 500)).toBe('unavailable');
  });

  it('healthy 排序公式', () => {
    const [, dune] = boardFixture();
    expect(healthyScore(dune)).toBe(100 + 2500);

    const fixture = boardFixture();
    const healthy = repoIds(sortByHealthyScore(fixture));
    expect(healthy).toEqual(['acme/dune', 'acme/beacon', 'acme/atlas', 'acme/comet']);
  });
});

describe('enrichTrendRepos 内部记忆缓存契约', () => {
  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;

  beforeEach(() => {
    clearTrendsCache();
    clearTrendEnrichCache();
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    clearTrendsCache();
    clearTrendEnrichCache();
  });

  it('enrich 缓存 TTL 12h', () => {
    expect(TREND_ENRICH_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('命中走记忆：同坐标二次调用不再触达后端', async () => {
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
    const repos = [
      makeTrendRepo({ id: 'acme/atlas', stars: 12000 }),
      makeTrendRepo({ id: 'acme/beacon', stars: 1500 }),
    ];
    const first = await enrichTrendRepos(repos);
    expect(first.get('acme/atlas')?.description).toBe('acme/atlas enriched desc');
    expect(first.get('acme/beacon')?.stars).toBe(1500);
    expect(enrichSpy).toHaveBeenCalledTimes(1);

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
