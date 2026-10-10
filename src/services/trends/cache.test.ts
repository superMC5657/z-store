import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  DOFORCE_SHARED_CACHE_KEY,
  TREND_DB_TTL_MS,
  buildDoforceCacheKey,
  clearTrendsCache,
  getDbTrendCache,
  readTrendsCache,
  saveBoardCacheMerged,
  saveDbTrendCache,
  trendDbTtlMs,
  writeTrendsCache,
} from './cache';
import {
  clearTrendEnrichCache,
  hydrateTrendConfirmedOtherCache,
  hydrateTrendEnrichCache,
  markTrendConfirmedOthers,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
} from './enrich';
import { makeEnrichedApp, makeTrendRepo } from '../../views/test-utils/trendFixture';
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

  describe('已确认 Other 写透→重读恢复（Other-persist）', () => {
    function mockL2() {
      const store = new Map<string, { payload_json: string; cached_at: number }>();
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'get_trend_board_cache') {
          const k = (args as { cache_key: string }).cache_key;
          return store.get(k) ?? null;
        }
        if (cmd === 'save_trend_board_cache') {
          const k = (args as { cache_key: string }).cache_key;
          const payload = (args as { payload_json: string }).payload_json;
          store.set(k, { payload_json: payload, cached_at: Math.floor(Date.now() / 1000) });
          return undefined;
        }
        return undefined;
      });
      return store;
    }

    it('mark 后合并写透：确认集随信封落盘，重读恢复确认', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const store = mockL2();
      const repos = [makeTrendRepo({ id: 'acme/atlas' }), makeTrendRepo({ id: 'acme/beacon' })];
      markTrendConfirmedOthers(['acme/atlas', 'acme/beacon']);
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
        'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      });
      await saveBoardCacheMerged('weekly||', 'weekly', repos);
      expect(store.size).toBe(1);
      const payload = JSON.parse(store.get('weekly||')?.payload_json as string) as {
        v: number;
        enrich: Record<string, { platforms: string[] }>;
        confirmedOther: string[];
      };
      expect(payload.v).toBe(1);
      expect(payload.enrich['acme/atlas']?.platforms).toEqual([]);
      expect(payload.confirmedOther).toContain('acme/atlas');
      expect(payload.confirmedOther).toContain('acme/beacon');

      // 重读恢复：确认集 hydrate 进内存
      clearTrendEnrichCache();
      expect(snapshotTrendConfirmedOthers()).toEqual([]);
      const reread = await getDbTrendCache('weekly||', 'weekly');
      expect(reread).toHaveLength(2);
      expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
      expect(snapshotTrendConfirmedOthers()).toContain('acme/beacon');
      expect(snapshotTrendEnrichCache(reread ?? [])['acme/atlas']?.platforms).toEqual([]);
    });

    it('重启等价：清空内存后同 key 命中，不联网重搜', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      mockL2();
      const repos = [makeTrendRepo({ id: 'acme/atlas' })];
      markTrendConfirmedOthers(['acme/atlas']);
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
      });
      await saveBoardCacheMerged('weekly||', 'weekly', repos);

      // 重启等价：清空全部内存（含 L1/确认/enrich），保 L2 存盘
      clearTrendsCache();
      clearTrendEnrichCache();
      const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
      const res = await fetchTrendsResult('weekly');
      expect(res.status).toBe('ok');
      expect(res.repos).toHaveLength(1);
      expect(networkSpy).not.toHaveBeenCalled();
      // 同 key 命中不回 pending：确认集已恢复
      expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
    });

    it('未确认 pending 永不落盘：旧盘残留 pending 无确认则丢弃', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const store = mockL2();
      const nowSec = Math.floor(Date.now() / 1000);
      const repos = [makeTrendRepo({ id: 'acme/atlas' })];
      const stalePending = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementationOnce(async () => ({
        payload_json: JSON.stringify({ v: 1, repos, enrich: { 'acme/atlas': stalePending } }),
        cached_at: nowSec - 60,
      }));
      // 旧盘读：无确认集，pending 丢弃不进内存
      const hit = await getDbTrendCache('weekly||', 'weekly');
      expect(hit).toHaveLength(1);
      expect(snapshotTrendEnrichCache(hit ?? [])).not.toHaveProperty('acme/atlas');
      expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');

      // 恢复常规 L2 mock 后再合并写透：残留 pending 不回写
      vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
        if (cmd === 'get_trend_board_cache') {
          const k = (args as { cache_key: string }).cache_key;
          return store.get(k) ?? null;
        }
        if (cmd === 'save_trend_board_cache') {
          const k = (args as { cache_key: string }).cache_key;
          const payload = (args as { payload_json: string }).payload_json;
          store.set(k, { payload_json: payload, cached_at: Math.floor(Date.now() / 1000) });
          return undefined;
        }
        return undefined;
      });
      await saveBoardCacheMerged('weekly||', 'weekly', repos);
      const payload = JSON.parse(store.get('weekly||')?.payload_json as string) as {
        enrich?: Record<string, unknown>;
        confirmedOther?: string[];
      };
      expect(payload.enrich?.['acme/atlas']).toBeUndefined();
      expect(payload.confirmedOther ?? []).not.toContain('acme/atlas');
    });

    it('具平台升级覆盖：确认后 concrete 到达，确认移除且富卡保留', async () => {
      vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
      const store = mockL2();
      const repos = [makeTrendRepo({ id: 'acme/atlas' })];
      markTrendConfirmedOthers(['acme/atlas']);
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      });
      // put 具平台自动移除确认
      expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
      await saveBoardCacheMerged('weekly||', 'weekly', repos);
      const payload = JSON.parse(store.get('weekly||')?.payload_json as string) as {
        enrich: Record<string, { platforms: string[] }>;
        confirmedOther?: string[];
      };
      expect(payload.enrich['acme/atlas']?.platforms).toEqual(['windows']);
      expect(payload.confirmedOther ?? []).not.toContain('acme/atlas');
    });

    it('读侧 hydrate 确认集可独立恢复（无内存条目时 L2 标记仍有效）', async () => {
      hydrateTrendConfirmedOtherCache(['acme/ghost']);
      expect(snapshotTrendConfirmedOthers()).toContain('acme/ghost');
    });
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
