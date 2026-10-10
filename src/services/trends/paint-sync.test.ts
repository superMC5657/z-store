/**
 * 驱逐写透回归（paint-sync lane，R3 内存与盘所见即所得）：
 * - 具平台到场驱逐删标记走与 mark/unmark 同一 emit（订阅触发写透），调用方不另行写透，不双写；
 * - TTL 过期清理与读路径 hydrate/sweep 不 emit（不写放大）；
 * - 盘 confirmedOther 随驱逐清除（写透后重读无残留）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import { clearTrendsCache, saveBoardCacheMerged } from './cache';
import {
  clearTrendEnrichCache,
  hydrateTrendConfirmedOtherCache,
  hydrateTrendEnrichCache,
  isTrendConfirmedOtherFresh,
  markTrendConfirmedOther,
  snapshotTrendConfirmedOthers,
  subscribeTrendConfirmedOtherChanges,
  sweepExpiredTrendEnrichCache,
} from './enrich';
import { makeEnrichedApp, makeTrendRepo } from '../../views/test-utils/trendFixture';

beforeEach(() => {
  clearTrendsCache();
  clearTrendEnrichCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearTrendsCache();
  clearTrendEnrichCache();
  vi.restoreAllMocks();
});

describe('具平台驱逐删标记走同一 emit（写透联动）', () => {
  it('put 具平台驱逐触发 unmark emit（单次，不双写）', () => {
    const events: Array<{ kind: string; keys: readonly string[] }> = [];
    const unsub = subscribeTrendConfirmedOtherChanges((kind, keys) => {
      events.push({ kind, keys });
    });
    try {
      markTrendConfirmedOther('acme/atlas');
      expect(events).toHaveLength(1);
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'other' }),
      });
      expect(events).toHaveLength(1);
      // 具平台到场：put 驱逐删标记并 emit unmark（调用方靠订阅写透，不另行返回键，不双写）。
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      });
      expect(events).toHaveLength(2);
      expect(events[1]?.kind).toBe('unmark');
      expect(events[1]?.keys).toEqual(['acme/atlas']);
      expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
      // 再次 put 同具平台不重复 emit（已删无残留）。
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      });
      expect(events).toHaveLength(2);
    } finally {
      unsub();
    }
  });

  it('isFresh/snapshot 不重复 emit（put 已驱逐后幂等），过期清理不触发', () => {
    const events: Array<{ kind: string; keys: readonly string[] }> = [];
    const unsub = subscribeTrendConfirmedOtherChanges((kind, keys) => {
      events.push({ kind, keys });
    });
    try {
      markTrendConfirmedOther('acme/beacon');
      expect(events).toHaveLength(1);
      hydrateTrendEnrichCache({
        'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [], description: 'other' }),
      });
      // 具平台到场由 put 驱逐并 emit 一次（与 mark/unmark 同一通道）。
      hydrateTrendEnrichCache({
        'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: ['windows'] }),
      });
      expect(events.filter((e) => e.kind === 'unmark')).toHaveLength(1);
      // 后续 isFresh/snapshot 仅幂等确认（不重复 emit，不双写）。
      expect(isTrendConfirmedOtherFresh('acme/beacon')).toBe(false);
      expect(snapshotTrendConfirmedOthers()).not.toContain('acme/beacon');
      expect(events.filter((e) => e.kind === 'unmark')).toHaveLength(1);
      // TTL 过期清理不 emit：另起一确认键，快进 13h 后 snapshot 仅删过期。
      markTrendConfirmedOther('acme/expire');
      const markCount = events.length;
      const t0 = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(t0 + 13 * 3600 * 1000);
      expect(snapshotTrendConfirmedOthers()).not.toContain('acme/expire');
      expect(events).toHaveLength(markCount);
    } finally {
      unsub();
      vi.restoreAllMocks();
    }
  });

  it('读路径 hydrate/sweep 不触发 emit（不写放大）', () => {
    const events: Array<{ kind: string; keys: readonly string[] }> = [];
    const unsub = subscribeTrendConfirmedOtherChanges((kind, keys) => {
      events.push({ kind, keys });
    });
    try {
      hydrateTrendConfirmedOtherCache(['acme/ghost']);
      hydrateTrendEnrichCache({
        'acme/plain': makeEnrichedApp({ id: 'acme/plain', platforms: ['windows'] }),
      });
      sweepExpiredTrendEnrichCache();
      expect(events).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

describe('驱逐写透：具平台到→盘 confirmedOther 清', () => {
  it('save 合并口过滤具平台确认，重读无残留', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const l2Store = new Map<string, { payload_json: string; cached_at: number }>();
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        const k = (args as { cache_key: string }).cache_key;
        return l2Store.get(k) ?? null;
      }
      if (cmd === 'save_trend_board_cache') {
        const k = (args as { cache_key: string }).cache_key;
        const payload = (args as { payload_json: string }).payload_json;
        l2Store.set(k, { payload_json: payload, cached_at: Math.floor(Date.now() / 1000) });
        return undefined;
      }
      return undefined;
    });
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    // 先确认 pending 并落盘：盘含确认。
    markTrendConfirmedOther('acme/atlas');
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'other' }),
    });
    await saveBoardCacheMerged('weekly||', 'weekly', repos);
    const first = JSON.parse([...l2Store.values()][0]?.payload_json as string) as {
      confirmedOther?: string[];
    };
    expect(first.confirmedOther ?? []).toContain('acme/atlas');
    // 具平台到场驱逐（put emit unmark，订阅方据此写透；此处模拟订阅写透调合并口）。
    const events: Array<{ kind: string; keys: readonly string[] }> = [];
    const unsub = subscribeTrendConfirmedOtherChanges((kind, keys) => {
      events.push({ kind, keys });
    });
    try {
      hydrateTrendEnrichCache({
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('unmark');
      // 写透：合并口过滤具平台确认，盘 cleared。
      await saveBoardCacheMerged('weekly||', 'weekly', repos);
      const second = JSON.parse([...l2Store.values()][0]?.payload_json as string) as {
        confirmedOther?: string[];
        enrich?: Record<string, { platforms?: string[] }>;
      };
      expect(second.confirmedOther ?? []).not.toContain('acme/atlas');
      expect(second.enrich?.['acme/atlas']?.platforms).toEqual(['windows']);
      expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
    } finally {
      unsub();
    }
  });
});
