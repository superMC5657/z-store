import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { TrendsView } from '../../views/TrendsView';
import { trendingHtmlFixture, makeEnrichedApp } from '../../views/test-utils/trendFixture';
import { makeApp } from '../../views/test-utils/filterFixture';
import { tauriApi } from '../api';
import { clearTrendsCache } from './cache';
import {
  clearTrendEnrichCache,
  hydrateTrendEnrichCache,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
} from './enrich';

describe('SWR 组件直展：重挂首屏即见富 pending 卡，不闪裸行', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
  });

  it('预 hydrate pending 后挂载直展 AppCard，无裸行占位', async () => {
    // 重启前 L2 富信封：三仓均为 pending（Other 待确认语义）
    hydrateTrendEnrichCache({
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
    // 首屏直展：pending 富卡描述出现，且无裸行占位闪烁
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
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
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

  // 新 SWR 语义两档：具平台免验、pending 后台补验（首屏均展旧卡、无裸行）。
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
    hydrateTrendEnrichCache(bulk);
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

  it('L2混合仅pending补验：具平台零调用，r1/r3/r5/r7/r9各一次，首屏无裸行', async () => {
    // L2 富信封：偶下标具平台（免验）、奇下标 pending（后台补验），均为新鲜 hydrate；
    // 首屏两档均展旧卡、无裸行。
    const bulk: Record<string, ReturnType<typeof makeEnrichedApp>> = {};
    for (let i = 0; i < 11; i += 1) {
      bulk[`acme/r${i}`] =
        i % 2 === 0
          ? makeEnrichedApp({ id: `acme/r${i}`, platforms: ['windows'], icon: 'https://x/r.png' })
          : makeEnrichedApp({ id: `acme/r${i}`, platforms: [], icon: '' });
    }
    hydrateTrendEnrichCache(bulk);
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return elevenRowsHtml();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos');
    const liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockImplementation(async (id: string) => ({ id, platforms: [], is_stale: false }));
    const { container } = renderBoard();

    // 首屏先展旧卡（含 pending 富卡），无裸行占位
    await screen.findByText('acme/r0 enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(11);
    // enrich 无缺席不拉；lite 仅补 pending 5 仓
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(5);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichSpy).not.toHaveBeenCalled();
    const calledIds = liteSpy.mock.calls.map(([id]) => String(id).trim().toLowerCase()).sort();
    expect(calledIds).toEqual(['acme/r1', 'acme/r3', 'acme/r5', 'acme/r7', 'acme/r9']);
    // 回来落定（空非 stale 确认为 Other）不闪裸
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
  });

  it('L2 过期后才补验：网络重拉 + enrich 落定后调 getPlatformsLite', async () => {
    const clientModule = await import('../api/client');
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
    await screen.findByText('acme/atlas enriched desc');
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    // 过期才补验：pending 行触发 getPlatformsLite
    await waitFor(() => {
      expect(liteSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  it('pending经lite具平台后重挂零lite直展：写透替代pending，下次免验', async () => {
    const clientModule = await import('../api/client');
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    // 内存 L2 存盘模拟：get/save 同一 Map，key 小写归一由业务保证，此处原样存取
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
    // 首挂前内存 pending（三仓均为 pending 空平台，首屏展旧卡不闪裸）
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: [] }),
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
      .mockImplementation(async (id: string) => ({ id, platforms: ['windows'], is_stale: false }));
    const first = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(first.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    // 首挂后台补验：三 pending 均走 lite 且落定为具平台
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    // 写透落稳：L2 存盘已替代 pending 为具平台（非空非 stale 才写透）
    await waitFor(() => {
      expect(l2Store.size).toBeGreaterThan(0);
      const hasConcrete = [...l2Store.values()].some((v) => {
        try {
          const p = JSON.parse(v.payload_json) as {
            enrich?: Record<string, { platforms?: string[] }>;
          };
          const vals = Object.values(p.enrich ?? {});
          return (
            vals.length > 0 && vals.every((s) => Array.isArray(s.platforms) && s.platforms.length > 0)
          );
        } catch {
          return false;
        }
      });
      expect(hasConcrete).toBe(true);
    });
    first.unmount();
    cleanup();
    // 重挂模拟重启：清 L1（含 enrich 内存）但保 L2 存盘
    clearTrendsCache();
    clearTrendEnrichCache();
    liteSpy.mockClear();
    const second = renderBoard();
    // 重挂直展具平台富卡，无裸行占位
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(second.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(second.container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(3);
    // 后台零 lite：具平台新鲜免验，直接展
    await new Promise((r) => setTimeout(r, 80));
    expect(liteSpy).not.toHaveBeenCalled();
    // 内存快照已为具平台（小写归一键）
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
    expect(snapshotTrendEnrichCache()['acme/beacon']?.platforms).toEqual(['windows']);
    expect(snapshotTrendEnrichCache()['acme/comet']?.platforms).toEqual(['windows']);
  });
});

describe('已确认Other落盘：重挂零lite直展Other卡、具平台可升级覆盖', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
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

  it('Other落盘后重挂零lite直展Other卡：lite空非stale确认写透，下次免验', async () => {
    const clientModule = await import('../api/client');
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
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    // 首挂：enrich 全空 pending，后台 lite 空非 stale 即确认为 Other
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' })),
      );
    const liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockImplementation(async (id: string) => ({ id, platforms: [], is_stale: false }));
    const first = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(first.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    // 三 pending 均走 lite 确认
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    // 写透落稳：L2 富信封含空平台 enrich + 确认集（data 仍禁，key 小写归一）
    await waitFor(() => {
      expect(l2Store.size).toBeGreaterThan(0);
      const payloads = [...l2Store.values()].map((v) => {
        try {
          return JSON.parse(v.payload_json) as {
            enrich?: Record<string, { platforms?: string[]; icon?: string }>;
            confirmedOther?: string[];
          };
        } catch {
          return {};
        }
      });
      const hasOther = payloads.some((p) => {
        const vals = Object.values(p.enrich ?? {});
        const allEmpty =
          vals.length > 0 && vals.every((s) => Array.isArray(s.platforms) && s.platforms.length === 0);
        const noDataIcon = vals.every(
          (s) => typeof s.icon !== 'string' || !s.icon.startsWith('data:'),
        );
        const hasConfirmed =
          Array.isArray(p.confirmedOther) &&
          p.confirmedOther.includes('acme/atlas') &&
          p.confirmedOther.includes('acme/beacon');
        return allEmpty && noDataIcon && hasConfirmed;
      });
      expect(hasOther).toBe(true);
    });
    first.unmount();
    cleanup();
    // 重挂模拟重启：清 L1（含 enrich/确认内存）但保 L2 存盘
    clearTrendsCache();
    clearTrendEnrichCache();
    enrichSpy.mockClear();
    liteSpy.mockClear();
    const second = renderBoard();
    // 重挂直展 Other 富卡（AppCard 非裸行），无裸行占位
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(second.container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(second.container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(3);
    // 后台零 lite 零 enrich：已确认新鲜免验（12h 内到期再验）
    await new Promise((r) => setTimeout(r, 80));
    expect(liteSpy).not.toHaveBeenCalled();
    expect(enrichSpy).not.toHaveBeenCalled();
    // 内存确认集已由 L2 回填（含小写归一键）
    expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
    expect(snapshotTrendConfirmedOthers()).toContain('acme/beacon');
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual([]);
  });

  it('具平台可升级覆盖：Other确认后治愈写透替代，确认移除且pending不覆盖具平台', async () => {
    const clientModule = await import('../api/client');
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
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [], icon: '' })),
      );
    // 首挂：atlas/beacon 确认为 Other，comet 直接治愈为 windows（同批内升级覆盖）
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      const k = String(id).trim().toLowerCase();
      if (k === 'acme/comet') return { id, platforms: ['windows'], is_stale: false };
      return { id, platforms: [], is_stale: false };
    });
    const first = renderBoard();
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(l2Store.size).toBeGreaterThan(0);
    });
    // 首挂落稳：comet 已为具平台，atlas/beacon 为已确认 Other
    await waitFor(() => {
      const payloads = [...l2Store.values()].map((v) => {
        try {
          return JSON.parse(v.payload_json) as {
            enrich?: Record<string, { platforms?: string[] }>;
            confirmedOther?: string[];
          };
        } catch {
          return {};
        }
      });
      const merged = payloads[0];
      expect(merged?.enrich?.['acme/comet']?.platforms).toEqual(['windows']);
      expect(merged?.confirmedOther ?? []).toContain('acme/atlas');
      expect(merged?.confirmedOther ?? []).not.toContain('acme/comet');
    });
    first.unmount();
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    liteSpy.mockClear();
    enrichSpy.mockClear();
    // 次挂前模拟治愈到达：L2 旧确认仍在，但内存先被具平台覆盖（put 自动移除确认，禁 pending 覆盖具平台）
    const { saveBoardCacheMerged } = await import('./cache');
    const { buildTrendsCacheKey } = await import('./cache');
    // 先由 L2 回填旧盘（触发 hydrate），再以具平台覆盖 atlas
    const { hydrateTrendEnrichCache: hydrate } = await import('./enrich');
    const l2Repos = [
      { id: 'acme/atlas', owner: 'acme', repo: 'atlas', name: 'acme/atlas', stars: 100, url: '' },
      { id: 'acme/beacon', owner: 'acme', repo: 'beacon', name: 'acme/beacon', stars: 100, url: '' },
      { id: 'acme/comet', owner: 'acme', repo: 'comet', name: 'acme/comet', stars: 100, url: '' },
    ] as unknown as import('../../types').TrendRepo[];
    hydrate({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    await saveBoardCacheMerged(buildTrendsCacheKey('weekly', {}), 'weekly', l2Repos);
    // 升级后确认应被移除（put 具平台自动移除），L2 不再含 atlas 确认
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
    await waitFor(() => {
      const payloads = [...l2Store.values()].map((v) => {
        try {
          return JSON.parse(v.payload_json) as {
            enrich?: Record<string, { platforms?: string[] }>;
            confirmedOther?: string[];
          };
        } catch {
          return {};
        }
      });
      const withConcrete = payloads.some(
        (p) =>
          Array.isArray(p.enrich?.['acme/atlas']?.platforms) &&
          (p.enrich?.['acme/atlas']?.platforms?.length ?? 0) > 0 &&
          !(p.confirmedOther ?? []).includes('acme/atlas'),
      );
      expect(withConcrete).toBe(true);
    });
    // pending 空值永不覆盖具平台：再以空 pending hydrate 同键，仍保持具平台
    hydrate({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
  });
});
