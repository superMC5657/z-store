/** 测试 `usePlatformBackfill` 的平台批量回填、防重与超时落定。 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../../types';
import { LOADING_SETTLE_MS } from '../../lib/platformFilter';

const mocks = vi.hoisted(() => ({
  getPlatformsLite: vi.fn(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'getPlatformsLite') return mocks.getPlatformsLite;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useState } from 'react';
import { useListPlatformBackfill, usePlatformBackfill } from './usePlatformBackfill';
import {
  clearSearchListCache,
  readSearchListCacheEntry,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import { clearTrendEnrichCache } from '../../services/trends/enrich';
import {
  isSharedRepoConfirmedOther,
  readSharedRepoEnrich,
  recordSharedConfirmedOthers,
} from '../../services/repoEnrichCache';

function makeRow(id: string, platforms: string[] = []): AppSummary {
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
    platforms,
  };
}

function renderBackfill(overrides: {
  apps?: AppSummary[];
  onlineApps?: AppSummary[];
  recentlyViewedApps?: AppSummary[];
  appsRef?: { current: AppSummary[] };
  onlineAppsRef?: { current: AppSummary[] };
  recentsRef?: { current: AppSummary[] };
  searchSeqRef?: { current: number };
} = {}) {
  const spies = {
    setApps: vi.fn(),
    setOnlineApps: vi.fn(),
    setRecentlyViewedApps: vi.fn(),
    patchPlatforms: vi.fn(),
  };
  spies.patchPlatforms.mockImplementation((patched: Map<string, string[]>) => {
    const updater = (prev: AppSummary[]) =>
      prev.map((row) => {
        const plats = patched.get(row.id.toLowerCase());
        return plats ? { ...row, platforms: plats } : row;
      });
    spies.setApps(updater);
    spies.setOnlineApps(updater);
    spies.setRecentlyViewedApps(updater);
  });
  const apps = overrides.apps ?? [];
  const onlineApps = overrides.onlineApps ?? [];
  const recentlyViewedApps = overrides.recentlyViewedApps ?? [];
  const appsRef = overrides.appsRef ?? { current: apps };
  const onlineAppsRef = overrides.onlineAppsRef ?? { current: onlineApps };
  const recentsRef = overrides.recentsRef ?? { current: recentlyViewedApps };
  const searchSeqRef = overrides.searchSeqRef ?? { current: 0 };
  const deps = {
    catalogLists: {
      apps,
      onlineApps,
      recentlyViewedApps,
      appsRef,
      onlineAppsRef,
      recentsRef,
      patchPlatforms: spies.patchPlatforms,
    },
    searchSeqRef,
  };
  const rendered = renderHook(() =>
    usePlatformBackfill(deps as Parameters<typeof usePlatformBackfill>[0]),
  );
  return { rendered, deps: spies, refs: { appsRef, searchSeqRef } };
}

function applyList(setter: { mock: { calls: unknown[][] } }, prev: AppSummary[]): AppSummary[] {
  const arg = setter.mock.calls[setter.mock.calls.length - 1][0];
  return (arg as (p: AppSummary[]) => AppSummary[])(prev);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSearchListCache();
  clearTrendEnrichCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePlatformBackfill：lazyBackfillPlatforms', () => {
  it('具平台行与已确认行不进 lite 通道；空平台行发起 lite', async () => {
    const rows = [
      makeRow('acme/has', ['windows']),
      makeRow('acme/empty'),
      makeRow('acme/done'),
    ];
    const { rendered } = renderBackfill();
    // 预置已确认 other（hook 内 state），rerender 后 ref 生效。
    act(() => {
      rendered.result.current.setPlatformResolvedOtherIds(new Set(['acme/done']));
    });
    rendered.rerender();
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: [] });

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 0);
    });

    expect(mocks.getPlatformsLite).toHaveBeenCalledTimes(1);
    expect(mocks.getPlatformsLite).toHaveBeenCalledWith('acme/empty', false);
  });

  it('lite 具平台：三列表只回填空平台行；forceRefresh 透传', async () => {
    const { rendered, deps } = renderBackfill();
    const rows = [makeRow('acme/empty'), makeRow('acme/has', ['macos'])];
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: ['linux'] });

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 0, true);
    });

    expect(mocks.getPlatformsLite).toHaveBeenCalledWith('acme/empty', true);
    const patched = applyList(deps.setApps, rows);
    expect(patched[0].platforms).toEqual(['linux']);
    // 具平台行保持原引用（不重渲染）。
    expect(patched[1]).toBe(rows[1]);
    expect(deps.setOnlineApps).toHaveBeenCalled();
    expect(deps.setRecentlyViewedApps).toHaveBeenCalled();
  });

  it('lite 空且非 stale：确认 other 落集', async () => {
    const { rendered, refs } = renderBackfill();
    refs.appsRef.current = [makeRow('acme/empty')];
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: [] });

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms([makeRow('acme/empty')], 0);
    });

    expect(rendered.result.current.platformResolvedOtherIds.has('acme/empty')).toBe(true);
  });

  it('stale seq：整批丢弃不碰列表', async () => {
    const { rendered, deps, refs } = renderBackfill();
    let pending: ((v: { id: string; platforms: string[] }) => void) | undefined;
    mocks.getPlatformsLite.mockImplementation(
      () => new Promise((resolve) => { pending = resolve; }),
    );

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms([makeRow('acme/empty')], 1);
    });
    // 搜索词变更推进 seq → 本批过期。
    refs.searchSeqRef.current = 2;
    await act(async () => {
      pending?.({ id: 'acme/empty', platforms: ['linux'] });
    });
    expect(deps.setApps).not.toHaveBeenCalled();
  });

  it('在途去重：同批重复调用不重复发请求', async () => {
    const { rendered } = renderBackfill();
    mocks.getPlatformsLite.mockImplementation(
      () => new Promise(() => {
        /* 挂起保持在途 */
      }),
    );
    const rows = [makeRow('acme/empty')];
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 0);
      rendered.result.current.lazyBackfillPlatforms(rows, 0);
    });
    expect(mocks.getPlatformsLite).toHaveBeenCalledTimes(1);
  });

  it('同 seq 顺序去重：已返回 is_stale 的空行同 seq 内不重复发起请求，forceRefresh=true 可重探', async () => {
    const { rendered } = renderBackfill({ searchSeqRef: { current: 1 } });
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: [], is_stale: true });
    const rows = [makeRow('acme/empty')];
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 1);
    });
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 1);
    });
    expect(mocks.getPlatformsLite).toHaveBeenCalledTimes(1);

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 1, true);
    });
    expect(mocks.getPlatformsLite).toHaveBeenCalledTimes(2);
    expect(mocks.getPlatformsLite).toHaveBeenLastCalledWith('acme/empty', true);
  });
});

describe('usePlatformBackfill：三链路共享富卡池', () => {
  it('共享池已确认 Other 的未收录行直接落定，不发 lite', async () => {
    recordSharedConfirmedOthers(['ext/other']);
    const { rendered } = renderBackfill();
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(
        [{ ...makeRow('ext/other'), is_cataloged: false }],
        0,
      );
    });
    expect(mocks.getPlatformsLite).not.toHaveBeenCalled();
    expect(rendered.result.current.platformResolvedOtherIds.has('ext/other')).toBe(true);
  });

  it('强刷不走共享池快径', async () => {
    recordSharedConfirmedOthers(['ext/other']);
    mocks.getPlatformsLite.mockResolvedValue({ id: 'ext/other', platforms: [] });
    const { rendered } = renderBackfill();
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(
        [{ ...makeRow('ext/other'), is_cataloged: false }],
        0,
        true,
      );
    });
    expect(mocks.getPlatformsLite).toHaveBeenCalledWith('ext/other', true);
  });

  it('lite 结果写回共享池（具平台与确认 Other），收录行不入池', async () => {
    mocks.getPlatformsLite.mockImplementation(async (id: string) => ({
      id,
      platforms: id === 'ext/win' ? ['windows'] : [],
    }));
    const { rendered } = renderBackfill();
    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(
        [
          { ...makeRow('ext/win'), is_cataloged: false },
          { ...makeRow('ext/none'), is_cataloged: false },
          { ...makeRow('cat/none'), is_cataloged: true },
        ],
        0,
      );
    });
    expect(readSharedRepoEnrich('ext/win')?.platforms).toEqual(['windows']);
    expect(isSharedRepoConfirmedOther('ext/none')).toBe(true);
    expect(isSharedRepoConfirmedOther('cat/none')).toBe(false);
  });
});

describe('usePlatformBackfill：首绘回填与 settle 超时', () => {
  it('首绘 apps 非空自动触发回填（自动路径 DB-only）', async () => {
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: ['windows'] });
    renderBackfill({ apps: [makeRow('acme/empty')] });
    await act(async () => {});
    expect(mocks.getPlatformsLite).toHaveBeenCalledWith('acme/empty', false);
  });

  it('15s 仍 loading：降级确认 Other（不无限 shimmer）', async () => {
    vi.useFakeTimers();
    const apps = [makeRow('acme/empty')];
    const { rendered } = renderBackfill({
      apps,
      appsRef: { current: apps },
      // lite 走 stale：行保持 loading，交由 settle 超时兜底。
    });
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: [], is_stale: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rendered.result.current.platformResolvedOtherIds.size).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_SETTLE_MS + 10);
    });
    expect(rendered.result.current.platformResolvedOtherIds.has('acme/empty')).toBe(true);
  });

  it('已具平台的行不触发 settle 确认', async () => {
    vi.useFakeTimers();
    const apps = [makeRow('acme/has', ['windows'])];
    const { rendered } = renderBackfill({ apps, appsRef: { current: apps } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_SETTLE_MS + 10);
    });
    expect(rendered.result.current.platformResolvedOtherIds.size).toBe(0);
  });

  it('lazyBackfillPlatforms 同步写透 searchListCache', async () => {
    const rows = [makeRow('acme/empty')];
    writeSearchListCache({ query: 'empty', page: 1, perPage: 20 }, rows);
    const { rendered } = renderBackfill();
    mocks.getPlatformsLite.mockResolvedValue({ id: 'acme/empty', platforms: ['macos'] });

    await act(async () => {
      rendered.result.current.lazyBackfillPlatforms(rows, 0, true);
    });

    expect(readSearchListCacheEntry({ query: 'empty', page: 1, perPage: 20 })?.rows[0].platforms).toEqual(['macos']);
  });
});

describe('useListPlatformBackfill：独立分页列表通用回填通道', () => {
  it('超过 LITE_TARGET_CAP (20) 的空行分批补完，且 stale 行同 seq 不重复请求', async () => {
    const initial = Array.from({ length: 24 }, (_, i) => makeRow(`acme/r-${i}`));
    mocks.getPlatformsLite.mockImplementation(async (id: string) => {
      if (id === 'acme/r-0') return { id, platforms: [], is_stale: true };
      return { id, platforms: ['linux'], is_stale: false };
    });

    const { result } = renderHook(() => {
      const [rows, setRows] = useState<AppSummary[]>(initial);
      const seqRef = { current: 1 };
      return {
        rows,
        ...useListPlatformBackfill({
          rows,
          setRows,
          seqRef,
          sharedResolvedOtherIds: new Set<string>(),
        }),
      };
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getPlatformsLite).toHaveBeenCalledTimes(24);
    expect(result.current.rows[0].platforms).toEqual([]);
    expect(result.current.rows[23].platforms).toEqual(['linux']);
  });
});
