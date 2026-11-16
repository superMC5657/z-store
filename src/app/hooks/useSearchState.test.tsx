/**
 * useSearchState 回归：
 *
 * - 本地搜索路由：结果落 setApps；非空搜索词在任意非 home 视图跳回 home；
 * - 换词草稿态：handleSearchDraft 立即同步新词、置本地搜索中并清空上一轮在线残留；
 * - stale 守卫：旧词迟到的本地/在线回包不覆盖新词（seq 串号丢弃）；
 * - 同词去重：本地已完成或在线结果集时 handleSearchChange 同词早退；冷启动在途连点不重复发包；
 * - 用户选择在线搜索（handleSearchSubmit）：本地未完成/失败时先补查本地再在线，第 1 页 20/页、结果落在线段；
 * - 在线空/失败保持本地结果并提示（info，不报错），显式重试允许重新发起；
 * - 触底翻页：守卫（loading 中 / 无下一页不拉）、按 id 去重追加、缓存翻页；
 * - 回声窗纯函数（echo）三语义锁定。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../../types';

const mocks = vi.hoisted(() => ({
  searchApps: vi.fn(),
  searchAppsOnline: vi.fn(),
  getSearchListCache: vi.fn(),
  saveSearchListCache: vi.fn(),
  getRepoCardsBatch: vi.fn(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'searchApps') return mocks.searchApps;
        if (prop === 'searchAppsOnline') return mocks.searchAppsOnline;
        if (prop === 'getSearchListCache') return mocks.getSearchListCache;
        if (prop === 'saveSearchListCache') return mocks.saveSearchListCache;
        if (prop === 'getRepoCardsBatch') return mocks.getRepoCardsBatch;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import {
  ONLINE_SEARCH_PER_PAGE,
} from '../../services/api';
import {
  clearPrivateSearchListCacheEntries,
  clearSearchListCache,
  readSearchListCache,
} from '../../services/search/searchListCache';
import { clearTrendEnrichCache } from '../../services/trends/enrich';
import { isSharedRepoConfirmedOther, recordSharedRepoPlatforms } from '../../services/repoEnrichCache';
import { adoptEchoInWindow, settleMoreEcho, settlePageEcho, useSearchState } from './useSearchState';

function makeApp(id: string, over: Partial<AppSummary> = {}): AppSummary {
  const [owner, repo] = id.split('/');
  return {
    id,
    name: repo ?? id,
    owner: owner ?? id,
    repo: repo ?? id,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${id} desc`,
    stars: 1,
    forks: 1,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    ...over,
  };
}

function renderSearch(currentView: 'home' | 'installed' | 'trends' | 'categories' = 'home') {
  const deps = {
    currentView,
    navigate: vi.fn(),
    setApps: vi.fn(),
    lazyBackfillPlatforms: vi.fn(),
    showToast: vi.fn(),
    t: ((key: string, fallback?: string) => fallback ?? key) as never,
  };
  const rendered = renderHook(() => useSearchState(deps));
  return { rendered, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSearchListCache();
  clearTrendEnrichCache();
});

describe('useSearchState：本地搜索路由', () => {
  it('任意非 home 视图输入非空搜索词后跳回 home；home 保持原视图', async () => {
    for (const view of ['installed', 'home', 'trends', 'categories'] as const) {
      const { rendered, deps } = renderSearch(view);
      mocks.searchApps.mockResolvedValue([makeApp('acme/atlas')]);
      await act(async () => {
        await rendered.result.current.handleSearchChange('atlas');
      });
      expect(deps.setApps).toHaveBeenCalledWith([expect.objectContaining({ id: 'acme/atlas' })]);
      if (view === 'home') {
        expect(deps.navigate).not.toHaveBeenCalled();
      } else {
        expect(deps.navigate).toHaveBeenCalledWith('home');
      }
    }
  });

  it('清空搜索词留在当前视图', async () => {
    const { rendered, deps } = renderSearch('categories');
    mocks.searchApps.mockResolvedValue([makeApp('acme/atlas')]);
    await act(async () => {
      await rendered.result.current.handleSearchChange('');
    });
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('在线提交：trends / categories 视图同样跳回 home', async () => {
    for (const view of ['trends', 'categories'] as const) {
      const { rendered, deps } = renderSearch(view);
      mocks.searchApps.mockResolvedValue([makeApp('acme/atlas')]);
      await act(async () => {
        await rendered.result.current.handleSearchSubmit('atlas');
      });
      expect(deps.navigate).toHaveBeenCalledWith('home');
    }
  });

  it('stale 守卫：旧词迟到的本地回包不覆盖新词', async () => {
    const { rendered, deps } = renderSearch('home');
    let resolveA: ((rows: AppSummary[]) => void) | undefined;
    mocks.searchApps
      .mockImplementationOnce(
        () => new Promise<AppSummary[]>((resolve) => { resolveA = resolve; }),
      )
      .mockResolvedValueOnce([makeApp('beta/bravo')]);

    await act(async () => {
      void rendered.result.current.handleSearchChange('alpha');
      await rendered.result.current.handleSearchChange('bravo');
    });
    expect(deps.setApps).toHaveBeenCalledWith([expect.objectContaining({ id: 'beta/bravo' })]);
    deps.setApps.mockClear();

    await act(async () => {
      resolveA?.([makeApp('alpha/one')]);
    });
    expect(deps.setApps).not.toHaveBeenCalled();
  });

  it('同词且已是在线结果集：handleSearchChange 早退不重复请求', async () => {
    const { rendered } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline.mockResolvedValue({ rows: [makeApp('acme/atlas')], sid: 'sid-1' });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('atlas');
    });
    const localCallsAfterSubmit = mocks.searchApps.mock.calls.length;
    await act(async () => {
      await rendered.result.current.handleSearchChange('atlas');
    });
    expect(mocks.searchApps.mock.calls.length).toBe(localCallsAfterSubmit);
    expect(rendered.result.current.isOnlineResultSet).toBe(true);
  });

  it('换词搜索立即清空上一轮残留的 onlineApps 与在线状态', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeApp('openai/codex')]);
    mocks.searchAppsOnline.mockResolvedValueOnce({
      rows: [makeApp('affaan-m/ecc'), makeApp('anomalyco/opencode')],
      sid: 'sid-old',
    });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('claude');
    });
    expect(rendered.result.current.onlineApps).toHaveLength(2);
    expect(rendered.result.current.isOnlineResultSet).toBe(true);

    // 搜索新词 codex：先搜本地，上一词的在线搜索结果必须立即清除，且不自动触发在线搜索
    mocks.searchAppsOnline.mockClear();
    await act(async () => {
      await rendered.result.current.handleSearchChange('codex');
    });
    expect(deps.setApps).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'openai/codex' })]);
    expect(rendered.result.current.onlineApps).toEqual([]);
    expect(rendered.result.current.onlineAppsRef.current).toEqual([]);
    expect(rendered.result.current.isOnlineResultSet).toBe(false);
    expect(rendered.result.current.onlineSearchPerformed).toBe(false);
    expect(mocks.searchAppsOnline).not.toHaveBeenCalled();
  });

  it('在线搜索进行中切换新词：立即复位 isSearchingOnline 并丢弃迟到的旧词在线回包', async () => {
    const { rendered } = renderSearch('home');
    let resolveOnlineOld: ((res: { rows: AppSummary[]; sid: string }) => void) | undefined;
    mocks.searchApps.mockResolvedValue([makeApp('openai/codex')]);
    mocks.searchAppsOnline.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOnlineOld = resolve; }),
    );

    await act(async () => {
      void rendered.result.current.handleSearchSubmit('oldword');
    });
    expect(rendered.result.current.isSearchingOnline).toBe(true);

    await act(async () => {
      await rendered.result.current.handleSearchChange('codex');
    });
    expect(rendered.result.current.isSearchingOnline).toBe(false);
    expect(rendered.result.current.onlineApps).toEqual([]);

    await act(async () => {
      resolveOnlineOld?.({ rows: [makeApp('old/ lingering')], sid: 'sid-old' });
    });
    expect(rendered.result.current.onlineApps).toEqual([]);
    expect(rendered.result.current.isOnlineResultSet).toBe(false);
  });

  it('handleSearchDraft 防抖窗口内立即同步新词、清空旧在线结果并标记本地搜索中', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValueOnce([]);
    mocks.searchAppsOnline.mockResolvedValueOnce({
      rows: [makeApp('affaan-m/ecc')],
      sid: 'sid-claude',
    });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('claude');
    });
    expect(rendered.result.current.onlineApps).toHaveLength(1);

    act(() => {
      rendered.result.current.handleSearchDraft('codex');
    });
    expect(rendered.result.current.searchQuery).toBe('codex');
    expect(rendered.result.current.isSearchingLocal).toBe(true);
    expect(rendered.result.current.onlineApps).toEqual([]);
    expect(rendered.result.current.isOnlineResultSet).toBe(false);

    // 防抖到达后执行本地 searchApps('codex')
    mocks.searchApps.mockResolvedValueOnce([makeApp('openai/codex')]);
    await act(async () => {
      await rendered.result.current.handleSearchChange('codex');
    });
    expect(rendered.result.current.isSearchingLocal).toBe(false);
    expect(deps.setApps).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'openai/codex' })]);
  });

  it('搜索失败：不抛出、本地列表不动', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockRejectedValue(new Error('db locked'));
    await act(async () => {
      await expect(rendered.result.current.handleSearchChange('atlas')).resolves.toBeUndefined();
    });
    expect(deps.setApps).not.toHaveBeenCalled();
  });
});

describe('useSearchState：用户选择在线搜索', () => {
  it('空词提交 no-op', async () => {
    const { rendered, deps } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('   ');
    });
    expect(deps.showToast).not.toHaveBeenCalled();
    expect(mocks.searchAppsOnline).not.toHaveBeenCalled();
  });

  it('本地搜索尚在进行中时触发在线搜索：先补查本地，再发起在线搜索', async () => {
    const { rendered, deps } = renderSearch('home');
    let resolvePendingLocal: ((rows: AppSummary[]) => void) | undefined;
    mocks.searchApps
      .mockImplementationOnce(
        () => new Promise<AppSummary[]>((resolve) => { resolvePendingLocal = resolve; }),
      )
      .mockResolvedValueOnce([makeApp('openai/codex')]);
    mocks.searchAppsOnline.mockResolvedValueOnce({
      rows: [makeApp('online/codex-ext')],
      sid: 'sid-codex',
    });

    await act(async () => {
      void rendered.result.current.handleSearchChange('codex');
    });
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('codex');
    });

    // 迟到的原 handleSearchChange 本地回包必须被丢弃，且提交链自己完成了本地+在线搜索
    await act(async () => {
      resolvePendingLocal?.([makeApp('stale/wrong')]);
    });
    expect(mocks.searchApps).toHaveBeenCalledTimes(2);
    expect(deps.setApps).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'openai/codex' })]);
    expect(rendered.result.current.onlineApps).toEqual([expect.objectContaining({ id: 'online/codex-ext' })]);
  });

  it('冷启动在线搜索进行中连点同词去重；已出结果后显式重试可重新请求', async () => {
    const { rendered } = renderSearch('home');
    let resolveFirst: ((res: { rows: AppSummary[]; sid: string }) => void) | undefined;
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce({ rows: [makeApp('online/retry-hit')], sid: 'sid-retry' });

    await act(async () => {
      await rendered.result.current.handleSearchChange('coldword');
    });
    await act(async () => {
      void rendered.result.current.handleSearchSubmit('coldword');
      await rendered.result.current.handleSearchSubmit('coldword');
    });
    expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.({ rows: [makeApp('online/first-hit')], sid: 'sid-first' });
    });
    expect(rendered.result.current.isOnlineResultSet).toBe(true);

    // 若结果被平台过滤隐藏，用户显式点击“重新在线搜索”（forceRefresh）必须重新发包而非 no-op
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('coldword', { forceRefresh: true });
    });
    expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(2);
    expect(mocks.searchAppsOnline.mock.calls[1][4]).toBe(true);
    expect(rendered.result.current.onlineApps).toEqual([expect.objectContaining({ id: 'online/retry-hit' })]);
  });

  it('异词提交先本地后在线；在线段落定 20/页口径', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([makeApp('local/a')]);
    mocks.searchAppsOnline.mockResolvedValue({
      rows: Array.from({ length: ONLINE_SEARCH_PER_PAGE }, (_, i) => makeApp(`online/app-${i}`)),
      sid: 'sid-9',
    });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('netword');
    });

    expect(mocks.searchApps).toHaveBeenCalledWith('netword');
    expect(mocks.searchAppsOnline).toHaveBeenCalledWith(
      'netword',
      expect.stringContaining('search-'),
      1,
      ONLINE_SEARCH_PER_PAGE,
      false,
    );
    expect(rendered.result.current.onlineApps).toHaveLength(ONLINE_SEARCH_PER_PAGE);
    expect(rendered.result.current.onlineHasMore).toBe(true);
    expect(rendered.result.current.isOnlineResultSet).toBe(true);
    expect(rendered.result.current.onlineQueryRef.current).toBe('netword');
    expect(deps.lazyBackfillPlatforms).toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'success');
    // 搜索列表缓存写入（薄：只存行）。
    expect(readSearchListCache({ query: 'netword', page: 1, perPage: ONLINE_SEARCH_PER_PAGE })?.length).toBe(
      ONLINE_SEARCH_PER_PAGE,
    );
  });

  it('联网失败回退的旧载荷（is_stale）照常展示但不写入列表缓存', async () => {
    const { rendered } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([makeApp('local/a')]);
    mocks.searchAppsOnline.mockResolvedValue({
      rows: [makeApp('online/stale-app')],
      sid: 'sid-stale',
      is_stale: true,
    });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('staleword');
    });

    expect(rendered.result.current.onlineApps?.map((a) => a.id)).toEqual(['online/stale-app']);
    expect(readSearchListCache({ query: 'staleword', page: 1, perPage: ONLINE_SEARCH_PER_PAGE })).toBeUndefined();
  });

  it('在线空结果：保持本地列表 + info 提示', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([makeApp('local/a')]);
    mocks.searchAppsOnline.mockResolvedValue({ rows: [], sid: 'sid-2' });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('emptyword');
    });

    expect(rendered.result.current.onlineApps).toEqual([]);
    expect(rendered.result.current.isOnlineResultSet).toBe(false);
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('在线失败：保持本地结果 + info 提示，不抛错', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([makeApp('local/a')]);
    mocks.searchAppsOnline.mockRejectedValue(new Error('quota'));

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('failword');
    });

    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'info');
    expect(deps.setApps).toHaveBeenCalledWith([expect.objectContaining({ id: 'local/a' })]);
  });
});

describe('useSearchState：列表缓存新鲜度与强刷', () => {
  it('首搜 forceRefresh=false；5min 内重搜零网络；6min 后先展示再后台重验', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
      const { rendered, deps } = renderSearch('home');
      mocks.searchApps.mockResolvedValue([]);
      mocks.searchAppsOnline.mockResolvedValue({ rows: [makeApp('rustdesk/rustdesk')], sid: 's1' });

      await act(async () => {
        await rendered.result.current.handleSearchSubmit('rustdesk');
      });
      expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(1);
      expect(mocks.searchAppsOnline.mock.calls[0][4]).toBe(false);
      expect(deps.lazyBackfillPlatforms.mock.calls.every((c) => c[2] === false)).toBe(true);

      // 换词再换回（5min 内）：缓存直出，不发在线请求，不重复提示成功。
      await act(async () => {
        await rendered.result.current.handleSearchChange('other');
      });
      deps.showToast.mockClear();
      await act(async () => {
        await rendered.result.current.handleSearchSubmit('rustdesk');
      });
      expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(1);
      expect(rendered.result.current.onlineApps.map((a) => a.id)).toEqual(['rustdesk/rustdesk']);
      expect(rendered.result.current.isSearchingOnline).toBe(false);
      expect(deps.showToast).not.toHaveBeenCalled();

      // 6min 后：先用缓存行首绘，再后台 force=false 重验，不弹成功提示。
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await act(async () => {
        await rendered.result.current.handleSearchChange('other');
      });
      let resolveSwr: ((res: { rows: AppSummary[]; sid: string }) => void) | undefined;
      mocks.searchAppsOnline.mockImplementationOnce(
        () => new Promise((resolve) => { resolveSwr = resolve; }),
      );
      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = rendered.result.current.handleSearchSubmit('rustdesk');
      });
      expect(rendered.result.current.onlineApps.map((a) => a.id)).toEqual(['rustdesk/rustdesk']);
      expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(2);
      expect(mocks.searchAppsOnline.mock.calls[1][4]).toBe(false);
      await act(async () => {
        resolveSwr?.({ rows: [makeApp('rustdesk/rustdesk', { stars: 99 })], sid: 's2' });
        await pending;
      });
      expect(rendered.result.current.onlineApps[0].stars).toBe(99);
      expect(deps.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forceRefresh=true 穿透 5min 新鲜缓存并透传后端与平台回填', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline.mockResolvedValue({ rows: [makeApp('rustdesk/rustdesk')], sid: 's1' });
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('rustdesk');
    });
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('rustdesk', { forceRefresh: true });
    });
    expect(mocks.searchAppsOnline).toHaveBeenCalledTimes(2);
    expect(mocks.searchAppsOnline.mock.calls[1][4]).toBe(true);
    expect(deps.lazyBackfillPlatforms.mock.calls.at(-1)?.[2]).toBe(true);
  });

  it('共享富卡池已具平台的未收录行首绘即带平台', async () => {
    recordSharedRepoPlatforms([makeApp('ext/tool', { platforms: ['linux'] })]);
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline.mockResolvedValue({
      rows: [makeApp('ext/tool', { platforms: [], is_cataloged: false })],
      sid: 's1',
    });
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('tool');
    });
    expect(rendered.result.current.onlineApps[0].platforms).toEqual(['linux']);
    const passed = deps.lazyBackfillPlatforms.mock.calls.at(-1)?.[0] as AppSummary[];
    expect(passed[0].platforms).toEqual(['linux']);
  });

  it('翻页统一 forceRefresh=false', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline
      .mockResolvedValueOnce({
        rows: Array.from({ length: ONLINE_SEARCH_PER_PAGE }, (_, i) => makeApp(`online/p-${i}`)),
        sid: 's1',
      })
      .mockResolvedValueOnce({ rows: [makeApp('online/p2')], sid: 's1' });
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('pages');
    });
    await act(async () => {
      await rendered.result.current.handleOnlineLoadMore();
    });
    expect(mocks.searchAppsOnline.mock.calls[1][4]).toBe(false);
    expect(deps.lazyBackfillPlatforms.mock.calls.every((c) => c[2] === false)).toBe(true);
  });
});

describe('useSearchState：触底翻页', () => {
  it('守卫：无在线结果集 / 已无下一页 / 加载中 不发请求', async () => {
    const { rendered } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleOnlineLoadMore();
    });
    expect(mocks.searchAppsOnline).not.toHaveBeenCalled();
  });

  it('下一页按 id 去重追加；未满页收口 hasMore=false', async () => {
    const { rendered } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline
      .mockResolvedValueOnce({
        rows: Array.from({ length: ONLINE_SEARCH_PER_PAGE }, (_, i) => makeApp(`online/app-${i}`)),
        sid: 'sid-p1',
      })
      .mockResolvedValueOnce({
        rows: [
          ...Array.from({ length: 4 }, (_, i) => makeApp(`online/extra-${i}`)),
          makeApp('online/app-0'),
        ],
        sid: 'sid-p1',
      });

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('pager');
    });
    expect(rendered.result.current.onlineHasMore).toBe(true);

    await act(async () => {
      await rendered.result.current.handleOnlineLoadMore();
    });

    const ids = rendered.result.current.onlineApps.map((a) => a.id);
    expect(ids).toHaveLength(ONLINE_SEARCH_PER_PAGE + 4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rendered.result.current.onlineHasMore).toBe(false);
    expect(rendered.result.current.isLoadingOnlineMore).toBe(false);
  });

  it('翻页失败：info 提示且结束 loading', async () => {
    const { rendered, deps } = renderSearch('home');
    mocks.searchApps.mockResolvedValue([]);
    mocks.searchAppsOnline
      .mockResolvedValueOnce({
        rows: Array.from({ length: ONLINE_SEARCH_PER_PAGE }, (_, i) => makeApp(`online/app-${i}`)),
        sid: 'sid-f1',
      })
      .mockRejectedValueOnce(new Error('rate limited'));

    await act(async () => {
      await rendered.result.current.handleSearchSubmit('pagerfail');
    });
    await act(async () => {
      await rendered.result.current.handleOnlineLoadMore();
    });

    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'info');
    expect(rendered.result.current.isLoadingOnlineMore).toBe(false);
  });
});

describe('useSearchState：回声窗纯函数（echo 三语义）', () => {
  it('settlePageEcho 空 sid 不落定；有效 sid 立期望', () => {
    const ref = { current: '' };
    settlePageEcho(ref, '');
    expect(ref.current).toBe('');
    settlePageEcho(ref, 'sid-a');
    expect(ref.current).toBe('sid-a');
  });

  it('settleMoreEcho：seq 失配丢弃；对上且有 sid 落定返回 true', () => {
    const ref = { current: 'keep' };
    expect(settleMoreEcho(ref, 1, 2, 'sid-b')).toBe(false);
    expect(ref.current).toBe('keep');
    expect(settleMoreEcho(ref, 2, 2, '')).toBe(true);
    expect(ref.current).toBe('keep');
    expect(settleMoreEcho(ref, 2, 2, 'sid-b')).toBe(true);
    expect(ref.current).toBe('sid-b');
  });

  it('adoptEchoInWindow：窗内（期望空）首个搜索回声立期望；已立不覆盖', () => {
    const ref = { current: '' };
    expect(adoptEchoInWindow(ref, 'search', 'sid-c')).toBe(true);
    expect(ref.current).toBe('sid-c');
    expect(adoptEchoInWindow(ref, 'search', 'sid-d')).toBe(false);
    expect(ref.current).toBe('sid-c');
    // 非 search kind 不立期望。
    const ref2 = { current: '' };
    expect(adoptEchoInWindow(ref2, 'trends', 'sid-e')).toBe(false);
    expect(ref2.current).toBe('');
  });
});

describe('useSearchState：L2 search_list_cache 冷启动水合与写盘', () => {
  const ids = ['acme/alpha', 'acme/beta'];
  const l2Row = (ageMs: number) => ({
    payload_json: JSON.stringify({ v: 2, ids, hasMore: false }),
    cached_at: Math.floor((Date.now() - ageMs) / 1000),
  });
  const cards = () =>
    ids.map((id) => ({
      summary: makeApp(id, { is_cataloged: false }),
      confirmed_other: false,
      updated_at: Math.floor(Date.now() / 1000),
    }));

  it('L1 空、L2 5min 内快照：批量水合直展，零 searchAppsOnline', async () => {
    mocks.searchApps.mockResolvedValue([]);
    mocks.getSearchListCache.mockResolvedValue(l2Row(60_000));
    mocks.getRepoCardsBatch.mockImplementation(async () => cards());
    const { rendered, deps } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('Alpha  Tools');
    });
    expect(mocks.getSearchListCache).toHaveBeenCalledWith(`alpha tools|1|${ONLINE_SEARCH_PER_PAGE}`);
    expect(mocks.getRepoCardsBatch).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.onlineApps.map((a) => a.id)).toEqual(ids);
    expect(rendered.result.current.onlineHasMore).toBe(false);
    expect(mocks.searchAppsOnline).not.toHaveBeenCalled();
    expect(deps.lazyBackfillPlatforms).toHaveBeenCalled();
  });

  it('L2 has_private 快照回填 L1 时保留私有标记：登出清除后 L1 不再命中', async () => {
    mocks.searchApps.mockResolvedValue([]);
    mocks.getSearchListCache.mockResolvedValue({ ...l2Row(60_000), has_private: true });
    mocks.getRepoCardsBatch.mockImplementation(async () => cards());
    const { rendered } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('alpha');
    });
    const key = { query: 'alpha', page: 1, perPage: ONLINE_SEARCH_PER_PAGE };
    expect(readSearchListCache(key)?.map((a) => a.id)).toEqual(ids);
    clearPrivateSearchListCacheEntries();
    expect(readSearchListCache(key)).toBeUndefined();
  });

  it('L2 超 5min：先展示快照，再后台 searchAppsOnline(forceRefresh=false) 静默重验', async () => {
    mocks.searchApps.mockResolvedValue([]);
    mocks.getSearchListCache.mockResolvedValue(l2Row(10 * 60_000));
    mocks.getRepoCardsBatch.mockImplementation(async () => cards());
    let resolveOnline: ((v: unknown) => void) | undefined;
    mocks.searchAppsOnline.mockImplementation(
      () => new Promise((resolve) => { resolveOnline = resolve; }),
    );
    const { rendered, deps } = renderSearch('home');
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = rendered.result.current.handleSearchSubmit('alpha');
      await vi.waitFor(() => expect(mocks.searchAppsOnline).toHaveBeenCalled());
    });
    expect(rendered.result.current.onlineApps.map((a) => a.id)).toEqual(ids);
    expect(mocks.searchAppsOnline.mock.calls[0][4]).toBe(false);
    await act(async () => {
      resolveOnline?.({ rows: [makeApp('acme/alpha'), makeApp('acme/gamma')], sid: 's1' });
      await pending;
    });
    expect(rendered.result.current.onlineApps.map((a) => a.id)).toEqual(['acme/alpha', 'acme/gamma']);
    // 后台重验静默完成，不弹成功提示。
    expect(deps.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
  });

  it('联网非 stale 结果写 L1 与 L2 { v: 2, ids, hasMore }；private_ids 标 hasPrivate，confirmed_other_ids 记入共享池', async () => {
    mocks.searchApps.mockResolvedValue([]);
    mocks.getSearchListCache.mockResolvedValue(null);
    const rows = Array.from({ length: ONLINE_SEARCH_PER_PAGE }, (_, i) =>
      makeApp(`acme/r${i}`, { is_cataloged: false, platforms: i === 1 ? [] : ['windows'] }),
    );
    mocks.searchAppsOnline.mockResolvedValue({
      rows,
      sid: 's1',
      private_ids: ['acme/r0'],
      confirmed_other_ids: ['acme/r1'],
    });
    const { rendered } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('private');
    });
    await vi.waitFor(() => expect(mocks.saveSearchListCache).toHaveBeenCalledTimes(1));
    const [cacheKey, normQuery, payload, hasPrivate] = mocks.saveSearchListCache.mock.calls[0];
    expect(cacheKey).toBe(`private|1|${ONLINE_SEARCH_PER_PAGE}`);
    expect(normQuery).toBe('private');
    expect(JSON.parse(payload)).toEqual({ v: 2, ids: rows.map((r) => r.id), hasMore: true });
    expect(hasPrivate).toBe(true);
    expect(readSearchListCache({ query: 'private', page: 1, perPage: ONLINE_SEARCH_PER_PAGE })).toHaveLength(
      ONLINE_SEARCH_PER_PAGE,
    );
    expect(isSharedRepoConfirmedOther('acme/r1')).toBe(true);
  });

  it('联网 stale 回退不写 L2', async () => {
    mocks.searchApps.mockResolvedValue([]);
    mocks.getSearchListCache.mockResolvedValue(null);
    mocks.searchAppsOnline.mockResolvedValue({ rows: [makeApp('acme/x')], sid: 's1', is_stale: true });
    const { rendered } = renderSearch('home');
    await act(async () => {
      await rendered.result.current.handleSearchSubmit('staleonly');
    });
    expect(mocks.saveSearchListCache).not.toHaveBeenCalled();
  });
});
