import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  DOFORCE_SHARED_CACHE_KEY,
  TREND_DB_TTL_MS,
  buildDoforceCacheKey,
  clearTrendsCache,
  getDbTrendCache,
  readTrendsCache,
  saveDbTrendCache,
  trendDbTtlMs,
  writeTrendsCache,
} from './cache';
import { fetchTrendsResult } from './boards';
import type { TrendRepo } from '../../types';
import { tauriApi } from '../api';

const mockRepo: TrendRepo = {
  id: 'test/repo',
  name: 'repo',
  owner: 'test',
  repo: 'repo',
  stars: 100,
  forks: 10,
  description: 'test repo',
  url: 'https://github.com/test/repo',
};

describe('trends L2 persistence cache', () => {
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
    const result = await getDbTrendCache('weekly||', 'weekly');
    expect(result).toBeUndefined();
  });

  it('getDbTrendCache returns parsed repos when fresh in L2 DB', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([mockRepo]),
      cached_at: nowSec - 60, // 1 min ago
    });

    const result = await getDbTrendCache('weekly||', 'weekly');
    expect(result).toEqual([mockRepo]);
  });

  it('buildDoforceCacheKey builds filter-aware key', () => {
    expect(buildDoforceCacheKey()).toBe('doforce||');
    expect(buildDoforceCacheKey({})).toBe('doforce||');
    // C3 key归一：language/category 统一 trim().toLowerCase()，读写同源
    expect(buildDoforceCacheKey({ language: 'rust' })).toBe('doforce|rust|');
    expect(buildDoforceCacheKey({ language: ' Rust ', category: ' CLI ' })).toBe('doforce|rust|cli');
    expect(buildDoforceCacheKey({ language: 'Rust', category: 'CLI' })).toBe('doforce|rust|cli');
    expect(DOFORCE_SHARED_CACHE_KEY).toBe('doforce||');
  });

  it('getDbTrendCache rejects non-struct formats (tuple / camelCase) as miss', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    // tuple format rejected
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce([
      JSON.stringify([mockRepo]),
      nowSec - 60,
    ]);
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();

    // camelCase format rejected
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payloadJson: JSON.stringify([mockRepo]),
      cachedAt: nowSec - 60,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('getDbTrendCache respects per-board L2 TTL (daily 1h, others 12h)', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(TREND_DB_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(trendDbTtlMs('daily')).toBe(60 * 60 * 1000);
    expect(trendDbTtlMs('weekly')).toBe(TREND_DB_TTL_MS);
    expect(trendDbTtlMs('new')).toBe(TREND_DB_TTL_MS);

    // daily cached 30m ago (<1h DB TTL) is fresh in DB
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([mockRepo]),
      cached_at: nowSec - 1800,
    });
    const freshDaily = await getDbTrendCache('daily||', 'daily');
    expect(freshDaily).toEqual([mockRepo]);

    // daily cached 2h ago (>1h DB TTL, <12h) is expired in DB
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([mockRepo]),
      cached_at: nowSec - 2 * 3600,
    });
    expect(await getDbTrendCache('daily||', 'daily')).toBeUndefined();

    // new cached 2h ago (<12h DB TTL) is fresh in DB
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([mockRepo]),
      cached_at: nowSec - 2 * 3600,
    });
    const freshNew = await getDbTrendCache('new||', 'new');
    expect(freshNew).toEqual([mockRepo]);

    // weekly cached_at exceeding 12h returns undefined (expired)
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([mockRepo]),
      cached_at: nowSec - (12 * 3600 + 60),
    });
    const expired = await getDbTrendCache('weekly||', 'weekly');
    expect(expired).toBeUndefined();
  });

  it('getDbTrendCache returns undefined on corrupted JSON or empty array', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const nowSec = Math.floor(Date.now() / 1000);

    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: 'invalid-json',
      cached_at: nowSec,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();

    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: '[]',
      cached_at: nowSec,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('getDbTrendCache swallows invoke failure and returns undefined', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValueOnce(new Error('command not found'));

    const result = await getDbTrendCache('weekly||', 'weekly');
    expect(result).toBeUndefined();
  });

  it('saveDbTrendCache invokes save_trend_board_cache with payload', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);

    await saveDbTrendCache('weekly||', 'weekly', [mockRepo]);
    expect(invokeSpy).toHaveBeenCalledWith('save_trend_board_cache', {
      cache_key: 'weekly||',
      cacheKey: 'weekly||',
      board: 'weekly',
      payload_json: JSON.stringify([mockRepo]),
      payloadJson: JSON.stringify([mockRepo]),
    });
  });

  it('saveDbTrendCache skips empty array and swallows error', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('db error'));

    await expect(saveDbTrendCache('weekly||', 'weekly', [])).resolves.toBeUndefined();
    expect(invokeSpy).not.toHaveBeenCalled();

    await expect(saveDbTrendCache('weekly||', 'weekly', [mockRepo])).resolves.toBeUndefined();
  });

  describe('L1 -> L2 -> Network integration in boards', () => {
    it('hits L2 on L1 miss and populates L1 for subsequent calls', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
      const nowSec = Math.floor(Date.now() / 1000);

      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
        if (cmd === 'get_trend_board_cache') {
          return {
            payload_json: JSON.stringify([mockRepo]),
            cached_at: nowSec - 10,
          };
        }
        return undefined;
      });

      // L1 is empty initially -> hits L2
      const res1 = await fetchTrendsResult('weekly');
      expect(res1.status).toBe('ok');
      expect(res1.repos).toEqual([mockRepo]);
      expect(networkSpy).not.toHaveBeenCalled();

      // Second call hits L1 directly (no L2 invoke, no network)
      const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke');
      const res2 = await fetchTrendsResult('weekly');
      expect(res2.status).toBe('ok');
      expect(res2.repos).toEqual([mockRepo]);
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(networkSpy).not.toHaveBeenCalled();
    });

    it('forceRefresh bypasses L1 and L2 and writes through to both on success', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const savedCalls: unknown[] = [];
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'save_trend_board_cache') {
          savedCalls.push(args);
        }
        return undefined;
      });

      // Prepopulate L1
      writeTrendsCache('weekly||', [{ ...mockRepo, stars: 999 }]);

      // Mock network fetch
      vi.spyOn(tauriApi, 'fetchTrendsText').mockResolvedValueOnce(
        `<article class="Box-row">
           <h2 class="h3"><a href="/newowner/newrepo">newowner / newrepo</a></h2>
           <span class="d-inline-block float-sm-right">50 stars this week</span>
         </article>`,
      );

      const res = await fetchTrendsResult('weekly', { forceRefresh: true });
      expect(res.status).toBe('ok');
      expect(res.repos[0]?.repo).toBe('newrepo');

      // L1 was updated
      const l1 = readTrendsCache('weekly||', 'weekly');
      expect(l1?.[0]?.repo).toBe('newrepo');

      // L2 was written through
      expect(savedCalls.length).toBe(1);
    });

    it('doforce shared L2 hit serves rising and healthy with filter-aware cache key', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
      const nowSec = Math.floor(Date.now() / 1000);

      const opts = { language: 'rust', category: 'cli' };
      const expectedKey = buildDoforceCacheKey(opts);

      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'get_trend_board_cache') {
          expect((args as { cache_key?: string }).cache_key).toBe(expectedKey);
          return {
            payload_json: JSON.stringify([mockRepo]),
            cached_at: nowSec - 100,
          };
        }
        return undefined;
      });

      const rising = await fetchTrendsResult('rising', opts);
      expect(rising.status).toBe('ok');
      expect(rising.repos).toHaveLength(1);
      expect(networkSpy).not.toHaveBeenCalled();

      // healthy shares L1 directly
      const healthy = await fetchTrendsResult('healthy', opts);
      expect(healthy.status).toBe('ok');
      expect(healthy.repos).toHaveLength(1);
      expect(networkSpy).not.toHaveBeenCalled();
    });
  });
});
