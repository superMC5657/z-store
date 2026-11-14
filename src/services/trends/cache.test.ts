import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  DOFORCE_SHARED_CACHE_KEY,
  TREND_DB_PAYLOAD_MAX_BYTES,
  TREND_DB_TTL_MS,
  buildDoforceCacheKey,
  buildTrendRankIndex,
  clearTrendsCache,
  getDbTrendCache,
  readTrendsCache,
  saveDbTrendCache,
  trendDbTtlMs,
  writeTrendsCache,
} from './cache';
import { snapshotTrendEnrichCache } from './enrich';
import { fetchTrendsResult } from '../trends';
import type { TrendRepo } from '../../types';
import { tauriApi } from '../api';

const mockRepo: TrendRepo = {
  id: 'test/repo',
  name: 'repo',
  owner: 'test',
  repo: 'repo',
  stars: 100,
  starsGained: 12,
  forks: 10,
  description: 'test repo',
  url: 'https://github.com/test/repo',
};

/** v2 读出重建的榜单行（只含排行索引字段）。 */
const rebuiltRepo: TrendRepo = {
  id: 'test/repo',
  name: 'test/repo',
  owner: 'test',
  repo: 'repo',
  stars: 100,
  starsGained: 12,
  forks: 10,
  url: 'https://github.com/test/repo',
};

function v2(items: unknown[]): string {
  return JSON.stringify({ v: 2, items });
}

describe('trends L2 rank index cache (v: 2)', () => {
  beforeEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  it('getDbTrendCache returns undefined when not in Tauri environment', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(false);
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('getDbTrendCache rebuilds TrendRepo[] from a fresh v2 index without touching the card pool', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: v2([{ id: 'Test/Repo', stars: 100, starsGained: 12, forks: 10 }, { id: 'bad id' }]),
      cached_at: nowSec - 60,
    });
    const result = await getDbTrendCache('weekly||', 'weekly');
    expect(result).toEqual([rebuiltRepo]);
    expect(snapshotTrendEnrichCache()).toEqual({});
  });

  it('buildDoforceCacheKey builds filter-aware key', () => {
    expect(buildDoforceCacheKey()).toBe('doforce||');
    expect(buildDoforceCacheKey({})).toBe('doforce||');
    expect(buildDoforceCacheKey({ language: 'rust' })).toBe('doforce|rust|');
    expect(buildDoforceCacheKey({ language: ' Rust ', category: ' CLI ' })).toBe('doforce|rust|cli');
    expect(DOFORCE_SHARED_CACHE_KEY).toBe('doforce||');
  });

  it('getDbTrendCache rejects legacy v1 envelopes, plain arrays, tuples and empty indexes as miss', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    const invoke = vi.spyOn(clientModule, 'tauriInvoke');
    invoke.mockResolvedValueOnce([JSON.stringify([mockRepo]), nowSec - 60]);
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: JSON.stringify([mockRepo]), cached_at: nowSec - 60 });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({
      payload_json: JSON.stringify({ v: 1, repos: [mockRepo], enrich: {} }),
      cached_at: nowSec - 60,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: v2([]), cached_at: nowSec - 60 });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: 'invalid-json', cached_at: nowSec });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('getDbTrendCache respects per-board L2 TTL (daily 1h, others 12h), clock skew and allowStale', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(TREND_DB_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(trendDbTtlMs('daily')).toBe(60 * 60 * 1000);
    expect(trendDbTtlMs('weekly')).toBe(TREND_DB_TTL_MS);
    const payload = v2([{ id: 'test/repo', stars: 100, starsGained: 12, forks: 10 }]);
    const invoke = vi.spyOn(clientModule, 'tauriInvoke');

    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec - 1800 });
    expect(await getDbTrendCache('daily||', 'daily')).toEqual([rebuiltRepo]);
    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec - 2 * 3600 });
    expect(await getDbTrendCache('daily||', 'daily')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec - 2 * 3600 });
    expect(await getDbTrendCache('new||', 'new')).toEqual([rebuiltRepo]);
    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec - (12 * 3600 + 60) });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec + 3600 });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
    invoke.mockResolvedValueOnce({ payload_json: payload, cached_at: nowSec - 20 * 3600 });
    expect(await getDbTrendCache('weekly||', 'weekly', { allowStale: true })).toEqual([rebuiltRepo]);
  });

  it('getDbTrendCache swallows invoke failure and returns undefined', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValueOnce(new Error('command not found'));
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('saveDbTrendCache writes { v: 2, items } with zero card fields', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);
    await saveDbTrendCache('weekly||', 'weekly', [
      mockRepo,
      { ...mockRepo, id: 'TEST/REPO' },
      { id: 'acme/new', name: 'acme/new', owner: 'acme', repo: 'new', stars: 5 },
    ]);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0]?.[1] as { cacheKey: string; board: string; payloadJson: string };
    expect(args.cacheKey).toBe('weekly||');
    expect(args.board).toBe('weekly');
    expect(JSON.parse(args.payloadJson)).toEqual({
      v: 2,
      items: [
        { id: 'test/repo', stars: 100, starsGained: 12, forks: 10 },
        { id: 'acme/new', stars: 5 },
      ],
    });
    for (const field of ['description', 'icon', 'platforms', 'enrich', 'confirmedOther']) {
      expect(args.payloadJson).not.toContain(field);
    }
  });

  it('saveDbTrendCache skips empty boards, oversize payloads, and swallows errors', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('db error'));
    await expect(saveDbTrendCache('weekly||', 'weekly', [])).resolves.toBeUndefined();
    expect(invokeSpy).not.toHaveBeenCalled();
    await expect(saveDbTrendCache('weekly||', 'weekly', [mockRepo])).resolves.toBeUndefined();

    invokeSpy.mockClear();
    expect(TREND_DB_PAYLOAD_MAX_BYTES).toBe(32 * 1024);
    const huge: TrendRepo[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `owner-${i}/repository-with-a-long-name-${i}`,
      name: '',
      owner: `owner-${i}`,
      repo: `repository-with-a-long-name-${i}`,
      stars: 1,
    }));
    await saveDbTrendCache('weekly||', 'weekly', huge);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('buildTrendRankIndex keeps rank order, dedupes and only keeps finite counters', () => {
    expect(
      buildTrendRankIndex([
        { ...mockRepo, starsGained: undefined, forks: Number.NaN },
        { ...mockRepo },
        { id: 'only/id', name: '', owner: '', repo: '', stars: -3 },
      ]),
    ).toEqual([
      { id: 'test/repo', stars: 100 },
      { id: 'only/id', stars: 0 },
    ]);
  });

  describe('L1 -> L2 -> Network integration in boards', () => {
    it('hits L2 on L1 miss and populates L1 for subsequent calls', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
      const nowSec = Math.floor(Date.now() / 1000);
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
        if (cmd === 'get_trend_board_cache') {
          return { payload_json: v2([{ id: 'test/repo', stars: 100, starsGained: 12, forks: 10 }]), cached_at: nowSec - 10 };
        }
        return undefined;
      });
      const res1 = await fetchTrendsResult('weekly');
      expect(res1.status).toBe('ok');
      expect(res1.repos).toEqual([rebuiltRepo]);
      expect(networkSpy).not.toHaveBeenCalled();

      const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke');
      const res2 = await fetchTrendsResult('weekly');
      expect(res2.repos).toEqual([rebuiltRepo]);
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(networkSpy).not.toHaveBeenCalled();
    });

    it('forceRefresh bypasses L1 and L2 and writes the rank index once on success', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const savedCalls: Array<{ payloadJson: string }> = [];
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'save_trend_board_cache') savedCalls.push(args as { payloadJson: string });
        return undefined;
      });
      writeTrendsCache('weekly||', [{ ...mockRepo, stars: 999 }]);
      vi.spyOn(tauriApi, 'fetchTrendsText').mockResolvedValueOnce(
        `<article class="Box-row">
           <h2 class="h3"><a href="/newowner/newrepo">newowner / newrepo</a></h2>
           <span class="d-inline-block float-sm-right">50 stars this week</span>
         </article>`,
      );
      const res = await fetchTrendsResult('weekly', { forceRefresh: true });
      expect(res.status).toBe('ok');
      expect(res.repos[0]?.repo).toBe('newrepo');
      expect(readTrendsCache('weekly||', 'weekly')?.[0]?.repo).toBe('newrepo');
      expect(savedCalls).toHaveLength(1);
      expect(JSON.parse(savedCalls[0].payloadJson).v).toBe(2);
    });

    it('doforce shared L2 hit serves rising and healthy with filter-aware cache key', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
      const nowSec = Math.floor(Date.now() / 1000);
      const opts = { language: 'rust', category: 'cli' };
      const expectedKey = buildDoforceCacheKey(opts);
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'get_trend_board_cache') {
          expect((args as { cacheKey?: string }).cacheKey).toBe(expectedKey);
          return {
            payload_json: v2([
              { id: 'a/fast', stars: 10, starsGained: 90, forks: 1 },
              { id: 'b/healthy', stars: 10, starsGained: 10, forks: 500 },
            ]),
            cached_at: nowSec - 100,
          };
        }
        return undefined;
      });
      const rising = await fetchTrendsResult('rising', opts);
      expect(rising.repos.map((r) => r.id)).toEqual(['a/fast', 'b/healthy']);
      const healthy = await fetchTrendsResult('healthy', opts);
      expect(healthy.repos.map((r) => r.id)).toEqual(['b/healthy', 'a/fast']);
      expect(networkSpy).not.toHaveBeenCalled();
    });

    it('falls back to expired L2 index (stale: true) when network fetch fails', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const nowSec = Math.floor(Date.now() / 1000);
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
        if (cmd === 'get_trend_board_cache') {
          return {
            payload_json: v2([{ id: 'test/repo', stars: 100, starsGained: 12, forks: 10 }]),
            cached_at: nowSec - 20 * 3600,
          };
        }
        return undefined;
      });
      vi.spyOn(tauriApi, 'fetchTrendsText').mockRejectedValueOnce(new Error('network jitter'));
      const res = await fetchTrendsResult('weekly');
      expect(res.status).toBe('ok');
      expect(res.stale).toBe(true);
      expect(res.repos).toEqual([rebuiltRepo]);
    });
  });
});
