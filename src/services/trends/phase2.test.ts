import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  TRENDS_CACHE_MAX_ENTRIES,
  TREND_DB_PAYLOAD_MAX_BYTES,
  TREND_DB_TTL_MS,
  clearTrendsCache,
  getDbTrendCache,
  readTrendsCache,
  saveDbTrendCache,
  sweepExpiredTrendsCache,
  trendL2EffectiveTtlMs,
  trendL2JitterMs,
  utf8ByteLength,
  writeTrendsCache,
} from './cache';
import {
  TREND_ENRICH_CACHE_MAX_ENTRIES,
  TREND_ENRICH_MAX_TOTAL,
  TREND_ENRICH_SHARD_SIZE,
  clearTrendEnrichCache,
  enrichTrendRepos,
  hydrateTrendEnrichCache,
  snapshotTrendEnrichCache,
  sweepExpiredTrendEnrichCache,
} from './enrich';
import { doforceRetryDelayMs } from './parse';
import { demoSeeded01 } from '../../demo/handlers/common';
import { hashSeeded01 } from '../feed';
import { tauriApi } from '../api';
import type { TrendRepo } from '../../types';
import { makeTrendRepo, makeEnrichedApp } from '../../views/test-utils/trendFixture';

function bigRepo(id: string, padLen: number): TrendRepo {
  const r = makeTrendRepo({ id, stars: 10 });
  (r as unknown as Record<string, unknown>).description = 'x'.repeat(padLen);
  return r;
}

describe('Phase2治理：内存有界 FIFO', () => {
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

  it('trendsCache 写时 FIFO 删最旧，上限 200', () => {
    expect(TRENDS_CACHE_MAX_ENTRIES).toBe(200);
    for (let i = 0; i < 201; i += 1) {
      writeTrendsCache(`weekly|k${i}|`, [makeTrendRepo({ id: `acme/r${i}` })]);
    }
    // 最旧 k0 被裁剪
    expect(readTrendsCache('weekly|k0|', 'weekly')).toBeUndefined();
    expect(readTrendsCache('weekly|k200|', 'weekly')).toBeDefined();
  });

  it('trendEnrichCache 经单一 put 入口裁剪至 500', () => {
    expect(TREND_ENRICH_CACHE_MAX_ENTRIES).toBe(500);
    const bulk: Record<string, ReturnType<typeof makeEnrichedApp>> = {};
    for (let i = 0; i < 501; i += 1) {
      bulk[`acme/r${i}`] = makeEnrichedApp({ id: `acme/r${i}` });
    }
    hydrateTrendEnrichCache(bulk);
    const snap = snapshotTrendEnrichCache();
    expect(Object.keys(snap).length).toBeLessThanOrEqual(500);
    // 最旧 acme/r0 被裁剪
    expect(snap['acme/r0']).toBeUndefined();
  });

  it('切榜 sweep 顺手清过期，不用 timer', () => {
    writeTrendsCache('weekly|sweep|', [makeTrendRepo({ id: 'acme/sweep' })]);
    // 人为制造过期：mock Date.now 向后 13h
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 13 * 3600 * 1000);
    sweepExpiredTrendsCache();
    sweepExpiredTrendEnrichCache();
    vi.spyOn(Date, 'now').mockReturnValue(realNow);
    expect(readTrendsCache('weekly|sweep|', 'weekly')).toBeUndefined();
  });
});

describe('Phase2治理：时钟钳制 + L2 抖动', () => {
  beforeEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  it('elapsed<0 按过期（时钟回拨不返 stale）', () => {
    const future = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(future);
    writeTrendsCache('weekly|clock|', [makeTrendRepo({ id: 'acme/clock' })]);
    // 回到现在读：elapsed<0 → 过期
    expect(readTrendsCache('weekly|clock|', 'weekly')).toBeUndefined();
  });

  it('L2 抖动 key 稳定 0-30s，只扣减不延长；短 TTL 加帽 ttl/4', () => {
    const a = trendL2JitterMs('weekly|python|');
    const b = trendL2JitterMs('weekly|python|');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(30_000);
    // 长 TTL：有效 = 12h - jitter
    expect(trendL2EffectiveTtlMs(TREND_DB_TTL_MS, 'weekly|python|')).toBe(TREND_DB_TTL_MS - a);
    // 短 TTL 加帽：ttl=1000 时最多扣 250
    const shortTtl = 1000;
    const eff = trendL2EffectiveTtlMs(shortTtl, 'weekly|python|');
    expect(eff).toBeGreaterThanOrEqual(shortTtl - Math.floor(shortTtl / 4));
    expect(eff).toBeLessThanOrEqual(shortTtl);
  });

  it('getDbTrendCache 未来 cached_at 按过期', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: JSON.stringify([makeTrendRepo({ id: 'acme/future' })]),
      cached_at: futureSec,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });
});

describe('Phase2治理：字节上限 + dataURI 永不进 payload', () => {
  beforeEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearTrendsCache();
    vi.restoreAllMocks();
  });

  it('FE 预检 256KB 常量', () => {
    expect(TREND_DB_PAYLOAD_MAX_BYTES).toBe(256 * 1024);
    expect(utf8ByteLength('hello')).toBe(5);
    expect(utf8ByteLength('中文')).toBeGreaterThan(2);
  });

  it('超限降级裸榜：enrich 超限但裸榜可存时去 enrich 落库', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);
    // 裸榜小，但 enrich 巨大（300KB 单条）→ 信封超限 → 降级裸榜
    const repos = [makeTrendRepo({ id: 'acme/small' })];
    const huge = makeEnrichedApp({ id: 'acme/huge' });
    (huge as unknown as Record<string, unknown>).description = 'y'.repeat(300 * 1024);
    await saveDbTrendCache('weekly||', 'weekly', repos, { 'acme/huge': huge });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0]?.[1] as { payload_json: string };
    const parsed: unknown = JSON.parse(args.payload_json);
    // 降级后为裸数组，不含 enrich
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('仍超限放弃写盘：裸榜本身超 256KB 时不 invoke', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);
    const repos = [bigRepo('acme/big', 300 * 1024)];
    await saveDbTrendCache('weekly||', 'weekly', repos);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('dataURI 永不进 payload_json（回归）：字符串级断言，pending 可进盘', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const invokeSpy = vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined);
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    const pending = makeEnrichedApp({
      id: 'acme/atlas',
      platforms: [],
    });
    const dataUri = makeEnrichedApp({
      id: 'acme/beacon',
      platforms: ['windows'],
      icon: 'data:image/png;base64,xxx',
    });
    const good = makeEnrichedApp({
      id: 'acme/good',
      platforms: ['windows'],
      icon: 'https://x/icon.png',
    });
    await saveDbTrendCache('weekly||', 'weekly', repos, {
      'acme/atlas': pending,
      'acme/beacon': dataUri,
      'acme/good': good,
    });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0]?.[1] as { payload_json: string };
    expect(args.payload_json).not.toContain('data:');
    const payload = JSON.parse(args.payload_json) as { enrich: Record<string, unknown> };
    expect(payload.enrich['acme/beacon']).toBeUndefined();
    expect(payload.enrich['acme/good']).toBeDefined();
    // SWR：pending 空平台随信封落盘
    expect(payload.enrich['acme/atlas']).toBeDefined();
  });
});

describe('Phase2治理：分片 20/片×2 片=40 上限', () => {
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

  it('分片常量 20/片、上限 40', () => {
    expect(TREND_ENRICH_SHARD_SIZE).toBe(20);
    expect(TREND_ENRICH_MAX_TOTAL).toBe(40);
  });

  it('45 仓仅请求 40（20+20 两片串行），超量留占位不置空', async () => {
    const calls: number[] = [];
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) => {
      calls.push(repos.length);
      return repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` }));
    });
    const repos: TrendRepo[] = [];
    for (let i = 0; i < 45; i += 1) {
      repos.push(makeTrendRepo({ id: `acme/r${i}` }));
    }
    const out = await enrichTrendRepos(repos);
    expect(calls).toEqual([20, 20]);
    expect(out.size).toBe(40);
    // 超量 5 个留占位（缺席但不抛错，榜单不置空）
    expect(out.has('acme/r40')).toBe(false);
    expect(out.has('acme/r44')).toBe(false);
  });

  it('单片失败仅该片缺席，继续下片', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos')
      .mockRejectedValueOnce(new Error('shard0 down'))
      .mockImplementation(async (repos) => repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })));
    const repos: TrendRepo[] = [];
    for (let i = 0; i < 25; i += 1) {
      repos.push(makeTrendRepo({ id: `acme/s${i}` }));
    }
    const out = await enrichTrendRepos(repos);
    // 首片 20 失败缺席，次片 5 成功
    expect(out.size).toBe(5);
    expect(out.has('acme/s20')).toBe(true);
  });
});

describe('Phase2治理：429 retry_after_ms 透传', () => {
  it('retry_after_ms 毫秒直值优先兑现', () => {
    expect(doforceRetryDelayMs(new Error('trends: upstream status 429 retry_after_ms=3000'))).toBe(3000);
    expect(doforceRetryDelayMs(new Error('trends: upstream status 429 retry-after-ms: 2500'))).toBe(2500);
  });

  it('retry_after_ms 超 60s 返回 undefined（直接 error）', () => {
    expect(doforceRetryDelayMs(new Error('trends: upstream status 429 retry_after_ms=61000'))).toBeUndefined();
  });

  it('既有 retry-after 秒形仍可用', () => {
    expect(doforceRetryDelayMs(new Error('trends: upstream status 429 retry-after: 5'))).toBe(5000);
  });
});

describe('Phase2治理：demo 32 位 mock 已 deprecated 并对齐 64 位', () => {
  it('demoSeeded01 与 hashSeeded01 同值（含大小写归一）', () => {
    expect(demoSeeded01('a/b', 0)).toBe(hashSeeded01('a/b', 0));
    expect(demoSeeded01('rustdesk/rustdesk', 0)).toBe(hashSeeded01('rustdesk/rustdesk', 0));
    expect(demoSeeded01('ACME/ATLAS', 42)).toBe(hashSeeded01('acme/atlas', 42));
    expect(demoSeeded01('acme/atlas', 0)).toBe(0.19098578839770444);
  });
});
