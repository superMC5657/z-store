import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '../api/client';
import { buildTrendsCacheKey, clearTrendsCache, getDbTrendCache } from './cache';
import {
  clearTrendEnrichCache,
  putTrendEnrichMemory,
  markTrendConfirmedOther,
  snapshotTrendEnrichCache,
} from './enrich';
import { createTrendBoardSession, fetchTrendsResult } from '../trends';
import { CMD, tauriApi } from '../api';
import type { AppSummary, HydratedRepoCard, TrendsResult } from '../../types';
import { makeTrendRepo, makeEnrichedApp } from '../../views/test-utils/trendFixture';

function v2Index(ids: string[]): string {
  return JSON.stringify({ v: 2, items: ids.map((id, i) => ({ id, stars: 1000 - i })) });
}

function hydrated(summary: AppSummary, patch: Partial<HydratedRepoCard> = {}): HydratedRepoCard {
  return { summary, confirmed_other: false, updated_at: Math.floor(Date.now() / 1000), ...patch };
}

/** 冷启动：L2 v2 排行索引 + `repo_card_cache` 批量水合（经 tauriInvoke mock）。 */
function mockColdStart(boardPayload: string, cards: Record<string, HydratedRepoCard>) {
  const nowSec = Math.floor(Date.now() / 1000);
  const batchCalls: string[][] = [];
  vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
    if (cmd === CMD.getTrendBoardCache) return { payload_json: boardPayload, cached_at: nowSec - 60 };
    if (cmd === CMD.getRepoCardsBatch) {
      const ids = (args as { ids: string[] }).ids;
      batchCalls.push(ids);
      return ids.map((id) => cards[id] ?? null);
    }
    return undefined;
  });
  return batchCalls;
}

async function hydrateSession(result: TrendsResult) {
  const session = createTrendBoardSession();
  session.start();
  session.syncBoard({ trendResult: result, activeBoard: 'weekly', trendFetchOpts: {} });
  session.syncEnrichment({
    trendResult: result,
    activeBoard: 'weekly',
    trendFetchOpts: {},
    displayItems: result.repos.map((repo) => ({ type: 'uncataloged' as const, repo })),
    boardReady: true,
    consumeForceEnrich: () => false,
  });
  return session;
}

describe('SWR 旧富卡直展：已确认 Other 落盘后重挂直展富卡', () => {
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

  it('冷启动：v2 排行索引 + repo_card_cache 批量水合直展已确认 Other 富卡（零网络、零 enrich）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const batchCalls = mockColdStart(v2Index(['acme/atlas', 'acme/noicon']), {
      'acme/atlas': hydrated(makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: 'https://x/atlas.png' }), {
        confirmed_other: true,
      }),
      'acme/noicon': hydrated(makeEnrichedApp({ id: 'acme/noicon', platforms: [], icon: '' }), {
        confirmed_other: true,
      }),
    });
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos');
    const res = await fetchTrendsResult('weekly');
    expect(res.status).toBe('ok');
    expect(res.repos.map((r) => r.id)).toEqual(['acme/atlas', 'acme/noicon']);
    // L2 读盘零副作用：富卡由会话水合承接。
    expect(snapshotTrendEnrichCache(res.repos)).toEqual({});

    const session = await hydrateSession(res);
    try {
      await vi.waitFor(() => {
        const snap = session.getSnapshot();
        expect(snap.enrichedApps['acme/atlas']?.icon).toBe('https://x/atlas.png');
        expect(snap.enrichedApps['acme/noicon']).toBeDefined();
        expect(snap.confirmedOtherIds.has('acme/atlas')).toBe(true);
        expect(snap.confirmedOtherIds.has('acme/noicon')).toBe(true);
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(batchCalls).toEqual([['acme/atlas', 'acme/noicon']]);
      expect(networkSpy).not.toHaveBeenCalled();
      expect(enrichSpy).not.toHaveBeenCalled();
      // 已确认 Other 写回共享池，跨视图可见。
      expect(snapshotTrendEnrichCache(res.repos)['acme/atlas']?.platforms).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it('冷启动：水合缺失或超 12h 的卡片才进 enrich', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const staleSecs = Math.floor(Date.now() / 1000) - 13 * 3600;
    mockColdStart(v2Index(['acme/fresh', 'acme/old', 'acme/missing']), {
      'acme/fresh': hydrated(makeEnrichedApp({ id: 'acme/fresh', platforms: ['windows'] })),
      'acme/old': hydrated(makeEnrichedApp({ id: 'acme/old', platforms: ['linux'] }), { updated_at: staleSecs }),
    });
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) => rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['macos'] })));
    const res = await fetchTrendsResult('weekly');
    const session = await hydrateSession(res);
    try {
      await vi.waitFor(() => expect(enrichSpy).toHaveBeenCalledTimes(1));
      const requested = enrichSpy.mock.calls[0][0].map((r) => `${r.owner}/${r.repo}`).sort();
      expect(requested).toEqual(['acme/missing', 'acme/old']);
      await vi.waitFor(() => {
        expect(session.getSnapshot().enrichedApps['acme/missing']?.platforms).toEqual(['macos']);
      });
      expect(session.getSnapshot().enrichedApps['acme/fresh']?.platforms).toEqual(['windows']);
    } finally {
      session.dispose();
    }
  });

  it('L2 过期后才重抓网络（weekly cached_at 超 12h 按 miss；daily 按 1h）', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [makeTrendRepo({ id: 'acme/atlas', stars: 12000 })];
    const envelope = v2Index(repos.map((r) => r.id));
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
    const envelope = v2Index(['acme/atlas']);
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValueOnce({
      payload_json: envelope,
      cached_at: futureSec,
    });
    expect(await getDbTrendCache('weekly||', 'weekly')).toBeUndefined();
  });

  it('hydrate 永不用旧 loading 覆盖内存已具平台值', () => {
    const healed = makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] });
    putTrendEnrichMemory({ 'acme/atlas': healed });
    const staleLoading = makeEnrichedApp({ id: 'acme/atlas', platforms: [] });
    putTrendEnrichMemory({ 'acme/atlas': staleLoading });
    const snap = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(snap['acme/atlas']?.platforms).toEqual(['windows']);
  });

  it('归一 key 直命中：大小写/空格归一后单次读盘命中', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const newKey = buildTrendsCacheKey('weekly', { language: ' Python ' });
    expect(newKey).toBe('weekly|python|');
    const richEnvelope = v2Index(['acme/atlas']);
    const nowSec = Math.floor(Date.now() / 1000);
    const seenKeys: string[] = [];
    const savedKeys: string[] = [];
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        const k = (args as { cacheKey: string }).cacheKey;
        seenKeys.push(k);
        if (k === newKey) return { payload_json: richEnvelope, cached_at: nowSec - 60 };
        return null;
      }
      if (cmd === 'save_trend_board_cache') {
        savedKeys.push((args as { cacheKey: string }).cacheKey);
      }
      return undefined;
    });
    const res = await fetchTrendsResult('weekly', { language: ' Python ' });
    expect(res.status).toBe('ok');
    expect(res.repos).toHaveLength(1);
    expect(networkSpy).not.toHaveBeenCalled();
    // 归一 key 单次直读命中，不尝试别名 key
    expect(seenKeys).toEqual([newKey]);
    // 读命中不触发回迁写
    expect(savedKeys).toEqual([]);
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

  it('有真实图标与无图标空 icon 的卡片冷启动水合后都直展富卡', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    mockColdStart(v2Index(['acme/real', 'acme/bare']), {
      'acme/real': hydrated(
        makeEnrichedApp({ id: 'acme/real', platforms: ['windows'], icon: 'https://simpleicons.org/icons/rust.svg' }),
      ),
      'acme/bare': hydrated(makeEnrichedApp({ id: 'acme/bare', platforms: [], icon: '' }), { confirmed_other: true }),
    });
    const networkSpy = vi.spyOn(tauriApi, 'fetchTrendsText');
    const res = await fetchTrendsResult('weekly');
    const session = await hydrateSession(res);
    try {
      await vi.waitFor(() => {
        const snap = session.getSnapshot().enrichedApps;
        expect(snap['acme/real']?.icon).toBe('https://simpleicons.org/icons/rust.svg');
        expect(snap['acme/bare']?.platforms).toEqual([]);
      });
      expect(networkSpy).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('图标回填只做升级：空图标不覆盖已有真实图标，平台照常治愈', async () => {
    // 内存已有已确认 Other 富卡（真实图标）；旧数据回填空图标 → 真实图标保留
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: [],
        icon: 'https://simpleicons.org/icons/rust.svg',
      }),
    });
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
    });
    const kept = snapshotTrendEnrichCache([makeTrendRepo({ id: 'acme/atlas' })])['acme/atlas'];
    expect(kept?.platforms).toEqual([]);
    expect(kept?.icon).toBe('https://simpleicons.org/icons/rust.svg');

    // 反向：空图标在先（先确认后回填），真实图标回填即升级
    clearTrendEnrichCache();
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
    });
    putTrendEnrichMemory({
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
    const { upsertRepoCardFromDetail } = await import('./enrich');
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: [],
        icon: 'https://simpleicons.org/icons/rust.svg',
      }),
    });
    upsertRepoCardFromDetail({
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
