/**
 * usePlatformBackfill 回归（生命周期接线层；深模块语义见 lib/platformFilter 自身测试）：
 *
 * - 目标选择接线：具平台行、已确认 other 行不进 lite 通道；
 * - lite 具平台：三列表只回填空平台行；lite 空且非 stale：确认 other；
 * - stale seq：整批丢弃；在途去重：同批二次调用不重复发请求；
 * - forceRefresh 透传；首绘 effect 自动回填；
 * - settle 超时：15s 仍 loading 的行降级为已确认 Other（杜绝永久 shimmer）。
 */
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

import { usePlatformBackfill } from './usePlatformBackfill';

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

function renderBackfill(overrides: Partial<Parameters<typeof usePlatformBackfill>[0]> = {}) {
  // spies 与 hook 入参对象分离：断言面恒为 vi.fn（无 Dispatch 联合类型）。
  const spies = {
    setApps: vi.fn(),
    setOnlineApps: vi.fn(),
    setRecentlyViewedApps: vi.fn(),
  };
  const deps = {
    apps: [] as AppSummary[],
    onlineApps: [] as AppSummary[],
    recentlyViewedApps: [] as AppSummary[],
    appsRef: { current: [] as AppSummary[] },
    onlineAppsRef: { current: [] as AppSummary[] },
    recentsRef: { current: [] as AppSummary[] },
    searchSeqRef: { current: 0 },
    ...spies,
    ...overrides,
  };
  const rendered = renderHook(() =>
    usePlatformBackfill(deps as Parameters<typeof usePlatformBackfill>[0]),
  );
  return { rendered, deps: spies, refs: { appsRef: deps.appsRef, searchSeqRef: deps.searchSeqRef } };
}

function applyList(setter: { mock: { calls: unknown[][] } }, prev: AppSummary[]): AppSummary[] {
  const arg = setter.mock.calls[setter.mock.calls.length - 1][0];
  return (arg as (p: AppSummary[]) => AppSummary[])(prev);
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
