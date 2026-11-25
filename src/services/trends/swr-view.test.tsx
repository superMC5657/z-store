import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { TrendsView } from '../../views/TrendsView';
import { trendingHtmlFixture, makeEnrichedApp } from '../../views/test-utils/trendFixture';
import { makeApp } from '../../views/test-utils/filterFixture';
import { tauriApi } from '../api';
import * as clientModule from '../api/client';
import { clearTrendsCache } from './cache';
import { __resetIconStoreForTests, getBufferedIcon } from '../iconStore';
import {
  clearTrendEnrichCache,
  putTrendEnrichMemory,
  markTrendConfirmedOthers,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
} from './enrich';

type FakeCard = { summary: ReturnType<typeof makeEnrichedApp>; confirmed_other: boolean; updated_at: number };

/** 模拟后端 `trend_board_cache` 与 `repo_card_cache` 存储。 */
async function mockBackendStores() {
  vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
  const boardStore = new Map<string, { payload_json: string; cached_at: number }>();
  const cardStore = new Map<string, FakeCard>();
  const boardSaves: string[] = [];
  vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'get_trend_board_cache') return boardStore.get(String(a.cacheKey)) ?? null;
    if (cmd === 'save_trend_board_cache') {
      boardSaves.push(String(a.payloadJson));
      boardStore.set(String(a.cacheKey), {
        payload_json: String(a.payloadJson),
        cached_at: Math.floor(Date.now() / 1000),
      });
      return undefined;
    }
    if (cmd === 'get_repo_cards_batch') {
      return (a.ids as string[]).map((id) => cardStore.get(id) ?? null);
    }
    return undefined;
  });
  const now = () => Math.floor(Date.now() / 1000);
  const recordEnriched = (summary: ReturnType<typeof makeEnrichedApp>) => {
    const prev = cardStore.get(summary.id);
    cardStore.set(summary.id, {
      summary: prev && prev.summary.platforms.length > 0 ? { ...summary, platforms: prev.summary.platforms } : summary,
      confirmed_other: prev?.confirmed_other ?? false,
      updated_at: now(),
    });
  };
  const recordLite = (id: string, platforms: string[]) => {
    const key = id.trim().toLowerCase();
    const prev = cardStore.get(key);
    if (!prev) return;
    cardStore.set(key, {
      ...prev,
      summary: { ...prev.summary, platforms: platforms.length > 0 ? platforms : prev.summary.platforms },
      confirmed_other: platforms.length === 0 && prev.summary.platforms.length === 0,
    });
  };
  return { boardStore, cardStore, boardSaves, recordEnriched, recordLite };
}

describe('SWR 组件直展：重挂首屏即见已确认 Other 富卡，不闪裸行', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
  });

  it('预 hydrate 已确认 Other 后挂载直展 AppCard，无裸行占位', async () => {
    // 重启前 L2 富信封：三仓均为已确认 Other（先 mark 后 hydrate，未确认 loading 永不进内存）
    markTrendConfirmedOthers(['acme/atlas', 'acme/beacon', 'acme/comet']);
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: [] }),
    });
    // 网络返回同榜三仓；enrich 通道故障（后台 revalidate 缺席，不覆盖直展）
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
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
    // 首屏直展：已确认 Other 富卡描述出现，且无裸行占位闪烁
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelector('.app-card .app-desc')).toBeTruthy();
  });
});

describe('平台随富卡缓存：L2 新鲜免验，过期才补验', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  /** 11 行 trending HTML（与 fixture 同结构，id 为 acme/r0..r10）。 */
  function elevenRowsHtml(): string {
    const rows: string[] = ['<div class="Box">'];
    for (let i = 0; i < 11; i += 1) {
      rows.push(
        '<article class="Box-row">',
        `<h2 class="h3 lh-condensed"><a href="/acme/r${i}">r${i}</a></h2>`,
        `<p class="col-9 color-fg-muted my-1 pr-4">R${i} desc</p>`,
        '<div class="f6 color-fg-muted mt-2">',
        `<a class="muted-link d-inline-block mr-3" href="/acme/r${i}/stargazers">${1500 + i}</a>`,
        `<span class="d-inline-block float-sm-right">${10 + i} stars today</span>`,
        '</div>',
        '</article>',
      );
    }
    rows.push('</div>');
    return rows.join('\n');
  }

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
  });

  function renderBoard() {
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

  // 新 SWR 语义两档：具平台免验、loading 后台补验（首屏均展旧卡、无裸行）。
  it('L2全具平台零lite零enrich：11仓新鲜具平台直展富卡，后台零补验', async () => {
    // L2 富信封：11 仓全具真实平台，均为新鲜 hydrate
    const bulk: Record<string, ReturnType<typeof makeEnrichedApp>> = {};
    for (let i = 0; i < 11; i += 1) {
      bulk[`acme/r${i}`] = makeEnrichedApp({
        id: `acme/r${i}`,
        platforms: ['windows'],
        icon: 'https://x/r.png',
      });
    }
    putTrendEnrichMemory(bulk);
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return elevenRowsHtml();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos');
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite');
    const { container } = renderBoard();

    // 11 富卡直展，无裸行
    await screen.findByText('acme/r0 enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(11);
    // 给后台 effect 留出 flush 窗口，仍应零请求
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(liteSpy).not.toHaveBeenCalled();
  });

  it('池内混合：具平台直展，平台未知卡免 enrich 只经 lite 落定', async () => {
    // 偶下标具平台（直展免验）、奇下标为平台未知的新鲜卡壳：卡片直展，只走 lite 补验落定。
    const bulk: Record<string, ReturnType<typeof makeEnrichedApp>> = {};
    for (let i = 0; i < 11; i += 1) {
      bulk[`acme/r${i}`] =
        i % 2 === 0
          ? makeEnrichedApp({ id: `acme/r${i}`, platforms: ['windows'], icon: 'https://x/r.png' })
          : makeEnrichedApp({ id: `acme/r${i}`, platforms: [], icon: '' });
    }
    putTrendEnrichMemory(bulk);
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return elevenRowsHtml();
      throw new Error(`unexpected url: ${url}`);
    });
    // 后台 enrich 取回奇下标 loading（只活当次 out，不进内存），再由 lite 确认
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' })),
      );
    const liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockImplementation(async (id: string) => ({ id, platforms: [], is_stale: false }));
    const { container } = renderBoard();

    await screen.findByText('acme/r0 enriched desc');
    // lite 仅补奇下标 5 仓（具平台与已确认免验）
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(5);
    });
    const calledIds = liteSpy.mock.calls.map(([id]) => String(id).trim().toLowerCase()).sort();
    expect(calledIds).toEqual(['acme/r1', 'acme/r3', 'acme/r5', 'acme/r7', 'acme/r9']);
    // 新鲜卡片不重拉元数据。
    expect(enrichSpy).not.toHaveBeenCalled();
    // 回来落定（空非 stale 确认为 Other）后富卡齐展，不闪裸
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(11);
  });

  it('L2 过期后才补验：网络重拉 + enrich 落定后调 getPlatformsLite', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const repos = [
      { id: 'acme/atlas', owner: 'acme', repo: 'atlas' },
      { id: 'acme/beacon', owner: 'acme', repo: 'beacon' },
      { id: 'acme/comet', owner: 'acme', repo: 'comet' },
    ].map((r) => ({ ...r, name: r.id, stars: 100, url: `https://github.com/${r.id}` }));
    const expiredEnvelope = JSON.stringify({
      v: 1,
      repos,
      enrich: {
        'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], icon: '' }),
      },
    });
    const nowSec = Math.floor(Date.now() / 1000);
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: expiredEnvelope, cached_at: nowSec - 13 * 3600 };
      }
      return undefined;
    });
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' })),
    );
    const liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockImplementation(async (id: string) => ({ id, platforms: [], is_stale: false }));
    const { container } = renderBoard();

    // 榜单经网络重拉后展示
    await screen.findByText('acme/atlas enriched desc', undefined, { timeout: 5000 });
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    // 过期才补验：loading 行触发 getPlatformsLite
    await waitFor(
      () => {
        expect(liteSpy.mock.calls.length).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it('lite 推导出具平台后重启直展：榜单只写一次 v2 索引，卡片经 repo_card_cache 水合零 lite', async () => {
    const backend = await mockBackendStores();
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => {
        const card = makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' });
        backend.recordEnriched(card);
        return card;
      }),
    );
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      backend.recordLite(id, ['windows']);
      return { id, platforms: ['windows'], is_stale: false };
    });
    const first = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    await new Promise((r) => setTimeout(r, 50));
    // 榜单 L2 只在抓榜成功时写一次 v2 排行索引；平台落定不重写榜单。
    expect(backend.boardSaves).toHaveLength(1);
    expect(JSON.parse(backend.boardSaves[0]).v).toBe(2);
    expect(backend.boardSaves[0]).not.toContain('platforms');
    first.unmount();
    cleanup();

    // 重启：清内存（L1 / 富卡池 / 图标），保留后端存储。
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    enrichSpy.mockClear();
    liteSpy.mockClear();
    const fetchSpy = vi.mocked(tauriApi.fetchTrendsText);
    fetchSpy.mockClear();
    const second = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(second.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(liteSpy).not.toHaveBeenCalled();
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
    expect(snapshotTrendEnrichCache()['acme/comet']?.platforms).toEqual(['windows']);
  });
});

describe('已确认Other落盘：重挂零lite直展Other卡、具平台可升级覆盖', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
  });

  function renderBoard() {
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

  it('已确认 Other 跨重启：repo_card_cache 带回 confirmed_other，重挂零 lite 零 enrich 直展 Other 卡', async () => {
    const backend = await mockBackendStores();
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => {
        const card = makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' });
        backend.recordEnriched(card);
        return card;
      }),
    );
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      backend.recordLite(id, []);
      return { id, platforms: [], is_stale: false };
    });
    const first = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
    });
    expect(backend.cardStore.get('acme/atlas')?.confirmed_other).toBe(true);
    expect(backend.boardSaves).toHaveLength(1);
    first.unmount();
    cleanup();

    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    enrichSpy.mockClear();
    liteSpy.mockClear();
    const second = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(second.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(second.container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 80));
    expect(liteSpy).not.toHaveBeenCalled();
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
    expect(snapshotTrendConfirmedOthers()).toContain('acme/beacon');
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual([]);
  });

  it('具平台可升级覆盖：Other 确认后具平台到达即移除确认，未知空平台不覆盖具平台，榜单不重写', async () => {
    const backend = await mockBackendStores();
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' })),
    );
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      const k = String(id).trim().toLowerCase();
      if (k === 'acme/comet') return { id, platforms: ['windows'], is_stale: false };
      return { id, platforms: [], is_stale: false };
    });
    renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
    });
    expect(snapshotTrendEnrichCache()['acme/comet']?.platforms).toEqual(['windows']);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/comet');

    // 详情治愈带回具平台：确认标记移除；再写未知空平台不覆盖具平台。
    putTrendEnrichMemory({ 'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }) });
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
    putTrendEnrichMemory({ 'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }) });
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.boardSaves).toHaveLength(1);
  });
});

describe('重挂图标自愈：SWR 空图标经 DB-only 回填，不走网络', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    __resetIconStoreForTests();
    vi.restoreAllMocks();
  });

  function renderBoard() {
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

  it('SWR 快照空图标经 getConfirmedIconsBatch 回填实图：零 enrich 零 lite 零 getOrFetchIcon', async () => {
    // L2 富信封：三仓均为具平台但图标为空，断言重挂经 DB-only 回填实图并直显。
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'], icon: '' }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: ['windows'], icon: '' }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: ['windows'], icon: '' }),
    });
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos');
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite');
    const cycleSpy = vi
      .spyOn(tauriApi, 'getConfirmedIconsBatch')
      .mockImplementation(async (ids: string[]) =>
        ids.map((id) => `https://icons.example.com/${String(id).replace('/', '-')}.png`),
      );
    const fetchIconSpy = vi.spyOn(tauriApi, 'getOrFetchIcon');
    const { container } = renderBoard();

    // 首屏 SWR 直展三富卡（具平台免验，无裸行）。
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    // DB-only 回填触发且一一对齐。
    await waitFor(() => {
      expect(cycleSpy).toHaveBeenCalledTimes(1);
    });
    const calledIds = (cycleSpy.mock.calls[0]?.[0] as string[]).map((s) =>
      String(s).trim().toLowerCase(),
    );
    expect(calledIds.sort()).toEqual(['acme/atlas', 'acme/beacon', 'acme/comet']);
    // 回填实图呈现：三卡均渲染远端图标 img，无空徽章回退。
    await waitFor(() => {
      const imgs = [...container.querySelectorAll('.app-icon-image')] as HTMLImageElement[];
      const srcs = imgs.map((img) => img.getAttribute('src') ?? '');
      expect(srcs.filter((s) => s.includes('https://icons.example.com/')).length).toBeGreaterThanOrEqual(3);
    });
    // 零网络：行已存在故 enrich 缺席集为空，具平台免 lite，且不走单图落盘通道。
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(liteSpy).not.toHaveBeenCalled();
    expect(fetchIconSpy).not.toHaveBeenCalled();
  });

  it('单仓 enrich 返回 null 时同榜不连环重入调用 enrichTrendRepos（保护后端趋势通道世代与流式探测）', async () => {
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    // 模拟同榜 3 仓中 acme/comet 在后端 fetch_online_repo 失败返回 null
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => {
          const id = `${r.owner}/${r.repo}`.toLowerCase();
          if (id === 'acme/comet') return null;
          return makeEnrichedApp({ id, platforms: ['windows'], icon: 'https://icons.example.com/ok.png' });
        }),
      );
    const { container } = renderBoard();

    await screen.findByText('acme/atlas enriched desc');
    await screen.findByText('acme/beacon enriched desc');
    // 失败项保持裸行占位
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(1);
    // 等待后续渲染稳定，断言同榜周期内绝不因 acme/comet 缺失而二次触发 enrichTrendRepos
    await new Promise((r) => setTimeout(r, 80));
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });

  it('enrich 返回预确认 data: 图标时写入 M1 iconStore 直显，且 trendEnrichCache 与 L2 存盘保持 icon 空串', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const l2Store = new Map<string, { payload_json: string; cached_at: number }>();
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        const k = (args as { cacheKey: string }).cacheKey;
        return l2Store.get(k) ?? null;
      }
      if (cmd === 'save_trend_board_cache') {
        const k = (args as { cacheKey: string }).cacheKey;
        const payload = (args as { payloadJson: string }).payloadJson;
        l2Store.set(k, { payload_json: payload, cached_at: Math.floor(Date.now() / 1000) });
        return undefined;
      }
      return undefined;
    });
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) =>
        makeEnrichedApp({
          id: `${r.owner}/${r.repo}`,
          platforms: [],
          icon: `${r.owner}/${r.repo}` === 'acme/atlas' ? dataUri : '',
        }),
      ),
    );
    vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => ({
      id,
      platforms: ['windows'],
      is_stale: false,
    }));

    const { container } = renderBoard();
    await screen.findByText('acme/atlas enriched desc');

    // M1 缓冲已注入预确认 data: 图标
    expect(getBufferedIcon('acme/atlas')).toBe(dataUri);

    // 卡片直显 data: 图标（即使后续 lite 升级写透将持久化副本剥空）
    await waitFor(() => {
      const imgs = [...container.querySelectorAll('.app-icon-image')] as HTMLImageElement[];
      expect(imgs.some((img) => img.getAttribute('src') === dataUri)).toBe(true);
    });

    // 等待 lite 具平台写透完成，验证 trendEnrichCache 与 L2 存盘绝不含 data:
    await waitFor(() => {
      expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
    });
    expect(snapshotTrendEnrichCache()['acme/atlas']?.icon).toBe('');
    for (const v of l2Store.values()) {
      expect(v.payload_json).not.toContain('data:image/');
    }
  });
});
