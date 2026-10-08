import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import {
  buildLegacyDoforceCacheKey,
  buildLegacyTrendsCacheKey,
  clearTrendsCache,
  getDbTrendCache,
  saveBoardCacheMerged,
  saveDbTrendCache,
} from './cache';
import {
  clearTrendEnrichCache,
  hydrateTrendEnrichCache,
  snapshotTrendEnrichCache,
} from './enrich';
import { fetchTrendsResult } from './boards';
import { tauriApi } from '../api';
import { makeTrendRepo, makeEnrichedApp } from '../../views/test-utils/trendFixture';

describe('SWR 旧富卡直展：pending 落盘后重挂直展富卡', () => {
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

  it('空平台 enrich 落盘后重挂直展富 pending 卡（不闪裸行，无需网络）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    const pending = makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: 'https://x/atlas.png' });

    // 落盘：富信封含 pending
    const saved: string[] = [];
    const saveSpy = vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'save_trend_board_cache') {
        saved.push((args as { payload_json: string }).payload_json);
      }
      return undefined;
    });
    await saveDbTrendCache('weekly||', 'weekly', repos, { 'acme/atlas': pending });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(saved[0] as string) as {
      v: number;
      repos: unknown[];
      enrich: Record<string, { platforms: string[] }>;
    };
    expect(payload.v).toBe(1);
    expect(payload.enrich['acme/atlas']).toBeDefined();
    expect(payload.enrich['acme/atlas']?.platforms).toEqual([]);
    saveSpy.mockRestore();

    // 重挂：清内存模拟重启，L2 新鲜命中
    clearTrendEnrichCache();
    expect(snapshotTrendEnrichCache(repos)).toEqual({});
    const nowSec = Math.floor(Date.now() / 1000);
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: saved[0], cached_at: nowSec - 60 };
      }
      return undefined;
    });

    const res = await fetchTrendsResult('weekly');
    expect(res.status).toBe('ok');
    expect(res.repos).toHaveLength(1);
    // L2 富信封已 hydrate 进内存：快照直展 pending 富卡，无需网络
    const snap = snapshotTrendEnrichCache(res.repos);
    expect(snap['acme/atlas']).toBeDefined();
    expect(snap['acme/atlas']?.platforms).toEqual([]);
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('L2 过期后才重抓网络（cached_at 超 12h 按 miss）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    const pending = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
    const envelope = JSON.stringify({ v: 1, repos, enrich: { 'acme/atlas': pending } });
    const nowSec = Math.floor(Date.now() / 1000);

    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: envelope, cached_at: nowSec - (12 * 3600 + 60) };
      }
      return undefined;
    });

    // L2 过期：直接读按 miss
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();

    // fetchTrendsResult 回落网络重抓（mock trending HTML 单仓）
    vi.spyOn(tauriApi, 'fetchTrendsText').mockResolvedValueOnce(
      `<article class="Box-row">
         <h2 class="h3"><a href="/newowner/newrepo">newowner / newrepo</a></h2>
         <span class="d-inline-block float-sm-right">50 stars this week</span>
       </article>`,
    );
    const res = await fetchTrendsResult('weekly', { forceRefresh: true });
    expect(res.status).toBe('ok');
    expect(res.repos[0]?.repo).toBe('newrepo');
  });

  it('读侧 elapsed<0 按过期（未来 cached_at 不直展）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    const pending = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
    const envelope = JSON.stringify({ v: 1, repos, enrich: { 'acme/atlas': pending } });
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: envelope,
      cached_at: futureSec,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('hydrate 永不用旧 pending 覆盖内存已具平台值', () => {
    const healed = makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] });
    hydrateTrendEnrichCache({ 'acme/atlas': healed });
    const stalePending = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
    hydrateTrendEnrichCache({ 'acme/atlas': stalePending });
    const snap = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(snap['acme/atlas']?.platforms).toEqual(['windows']);
  });

  it('无图标 pending 重挂仍富卡（icon 空即保留，仅禁 data:）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/noicon', stars: 500 })];
    // 无 token 时慢探不跑，enrich 常无图标（icon 空串）
    const pendingNoIcon = makeEnrichedApp({ id: 'acme/noicon', platforms: [], icon: '' });
    const saved: string[] = [];
    const saveSpy = vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'save_trend_board_cache') {
        saved.push((args as { payload_json: string }).payload_json);
      }
      return undefined;
    });
    await saveDbTrendCache('weekly||', 'weekly', repos, { 'acme/noicon': pendingNoIcon });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saved[0] as string).enrich['acme/noicon']).toBeDefined();
    saveSpy.mockRestore();

    // 重挂：读盘守卫放行无图标 pending，直展富卡
    clearTrendEnrichCache();
    const nowSec = Math.floor(Date.now() / 1000);
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: saved[0], cached_at: nowSec - 60 };
      }
      return undefined;
    });
    const res = await fetchTrendsResult('weekly');
    expect(res.status).toBe('ok');
    const snap = snapshotTrendEnrichCache(res.repos);
    expect(snap['acme/noicon']).toBeDefined();
    expect(snap['acme/noicon']?.platforms).toEqual([]);
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('合并写盘 await 落稳不丢：裸存不得覆盖已有富信封', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    const rich = makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'], icon: 'https://x/a.png' });
    const richEnvelope = JSON.stringify({ v: 1, repos, enrich: { 'acme/atlas': rich } });
    const nowSec = Math.floor(Date.now() / 1000);
    const saved: Array<{ payload_json: string }> = [];
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: richEnvelope, cached_at: nowSec - 60 };
      }
      if (cmd === 'save_trend_board_cache') {
        saved.push(args as { payload_json: string });
      }
      return undefined;
    });
    // 关闭前/主体落盘统一走合并口：await 返回时 invoke 已完成，富条目保留
    await saveBoardCacheMerged('weekly||', 'weekly', repos);
    expect(saved).toHaveLength(1);
    const payload = JSON.parse(saved[0]?.payload_json as string) as {
      v: number;
      enrich: Record<string, { platforms: string[] }>;
    };
    expect(payload.v).toBe(1);
    expect(payload.enrich['acme/atlas']?.platforms).toEqual(['windows']);
  });

  it('旧 key 迁移命中：新 key miss 后试旧 key 一次并回迁', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const legacyKey = buildLegacyTrendsCacheKey('weekly', { language: ' Python ' });
    expect(legacyKey).toBe('weekly| Python |');
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    const rich = makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'], icon: 'https://x/a.png' });
    const richEnvelope = JSON.stringify({ v: 1, repos, enrich: { 'acme/atlas': rich } });
    const nowSec = Math.floor(Date.now() / 1000);
    const seenKeys: string[] = [];
    const savedKeys: string[] = [];
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        const k = (args as { cache_key: string }).cache_key;
        seenKeys.push(k);
        if (k === legacyKey) return { payload_json: richEnvelope, cached_at: nowSec - 60 };
        return null;
      }
      if (cmd === 'save_trend_board_cache') {
        savedKeys.push((args as { cache_key: string }).cache_key);
      }
      return undefined;
    });
    const res = await fetchTrendsResult('weekly', { language: ' Python ' });
    expect(res.status).toBe('ok');
    expect(res.repos).toHaveLength(1);
    expect(networkSpy).not.toHaveBeenCalled();
    // 新 key 首试 + 旧 key 一次
    expect(seenKeys[0]).toBe('weekly|python|');
    expect(seenKeys).toContain(legacyKey);
    // 回迁新 key
    expect(savedKeys).toContain('weekly|python|');
    // 富卡随迁进内存，直展
    expect(snapshotTrendEnrichCache(res.repos)['acme/atlas']?.platforms).toEqual(['windows']);
  });

  it('旧 doforce key 兼容：rising 经 legacy 命中不走网络', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const legacyKey = buildLegacyDoforceCacheKey({ language: 'Rust' });
    expect(legacyKey).toBe('doforce|Rust|');
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000, starsGained: 300 })];
    const richEnvelope = JSON.stringify({ v: 1, repos, enrich: {} });
    const nowSec = Math.floor(Date.now() / 1000);
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        const k = (args as { cache_key: string }).cache_key;
        if (k === legacyKey) return { payload_json: richEnvelope, cached_at: nowSec - 60 };
        return null;
      }
      return undefined;
    });
    const res = await fetchTrendsResult('rising', { language: 'Rust' });
    expect(res.status).toBe('ok');
    expect(res.repos).toHaveLength(1);
    expect(networkSpy).not.toHaveBeenCalled();
  });
});

describe('富卡落盘图标一视同仁：有/无图标重挂都直展富卡', () => {
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

  it('有真实图标与无图标空 icon 重挂都直展富卡', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [
      makeTrendRepo({ id: 'acme/real', stars: 9000 }),
      makeTrendRepo({ id: 'acme/bare', stars: 100 }),
    ];
    const realIcon = makeEnrichedApp({
      id: 'acme/real',
      platforms: ['windows'],
      icon: 'https://simpleicons.org/icons/rust.svg',
    });
    const emptyIcon = makeEnrichedApp({ id: 'acme/bare', platforms: [], icon: '' });
    const saved: string[] = [];
    const saveSpy = vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'save_trend_board_cache') {
        saved.push((args as { payload_json: string }).payload_json);
      }
      return undefined;
    });
    await saveDbTrendCache('weekly||', 'weekly', repos, {
      'acme/real': realIcon,
      'acme/bare': emptyIcon,
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(saved[0] as string) as {
      v: number;
      enrich: Record<string, { icon: string; platforms: string[] }>;
    };
    expect(payload.enrich['acme/real']?.icon).toBe('https://simpleicons.org/icons/rust.svg');
    expect(payload.enrich['acme/bare']).toBeDefined();
    expect(payload.enrich['acme/bare']?.icon).toBe('');
    saveSpy.mockRestore();

    // 重挂：两者都直展富卡，无需网络
    clearTrendEnrichCache();
    const nowSec = Math.floor(Date.now() / 1000);
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: saved[0], cached_at: nowSec - 60 };
      }
      return undefined;
    });
    const res = await fetchTrendsResult('weekly');
    expect(res.status).toBe('ok');
    const snap = snapshotTrendEnrichCache(res.repos);
    expect(snap['acme/real']?.icon).toBe('https://simpleicons.org/icons/rust.svg');
    expect(snap['acme/bare']).toBeDefined();
    expect(snap['acme/bare']?.platforms).toEqual([]);
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('图标回填只做升级：空图标不覆盖已有真实图标，平台照常治愈', async () => {
    // 内存已有 pending 富卡（真实图标）；旧数据回填空图标 pending → 真实图标保留
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: [],
        icon: 'https://simpleicons.org/icons/rust.svg',
      }),
    });
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
    });
    const kept = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })])['acme/atlas'];
    expect(kept?.platforms).toEqual([]);
    expect(kept?.icon).toBe('https://simpleicons.org/icons/rust.svg');

    // 反向：空图标在先，真实图标回填即升级
    clearTrendEnrichCache();
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
    });
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: ['windows'],
        icon: 'https://simpleicons.org/icons/rust.svg',
      }),
    });
    const healed = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })])['acme/atlas'];
    expect(healed?.platforms).toEqual(['windows']);
    expect(healed?.icon).toBe('https://simpleicons.org/icons/rust.svg');
  });

  it('详情治愈 data: 图标不进内存，已有真实图标不受降级', async () => {
    const { upsertTrendEnrichFromDetail } = await import('./enrich');
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: [],
        icon: 'https://simpleicons.org/icons/rust.svg',
      }),
    });
    upsertTrendEnrichFromDetail({
      id: 'acme/atlas',
      name: 'atlas',
      description_en: '',
      owner: 'acme',
      repo: 'atlas',
      icon: 'data:image/png;base64,AAA',
      icon_bg: '',
      description: '',
      stars: 10,
      forks: 1,
      license: 'MIT',
      latest_version: 'latest',
      changelog: '',
      readme_markdown: '',
      releases: [],
      category: 'dev',
      category_name: 'dev',
      is_verified: false,
      forge: 'github',
      forge_host: 'github.com',
      homepage: null,
      platforms: ['windows'],
    });
    const snap = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })]);
    // 平台治愈落定，data: 未进盘，真实图标保留
    expect(snap['acme/atlas']?.platforms).toEqual(['windows']);
    expect(snap['acme/atlas']?.icon).toBe('https://simpleicons.org/icons/rust.svg');
  });
});
