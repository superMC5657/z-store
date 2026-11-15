/**
 * useDetailCacheSync 回归：锁定详情首 patch / 图标写透 / 缓存治愈的竞态安全语义。
 *
 * - 0ms 内存快照命中：先展快照 + recordAppView + 后台 ETag 条件探查；
 * - 后台静默探查同值返回 prev（不触发全网格重渲染）、变值平滑覆盖；
 * - 竞态守卫：A 慢 B 快时 A 的迟到回包不得覆盖已切换的选中态；
 * - 后端占位简介永不污染内存快照（富卡非占位治愈，无富卡存 ''）；
 * - stale 离线详情不碰平台（不确认 other、不派治愈事件）；
 * - 非 stale 空平台确认 other + 富卡治愈事件；真实平台治愈 + 事件扇出；
 * - 图标三态：http 直写四列表、data: 只即时看不进盘（cycle 落 remote_url）、
 *   cycle data: 无 remote_url 且非 L5 不落盘。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetail, AppDetailViewModel, AppSummary } from '../../types';
import {
  clearSearchListCache,
  readSearchListCache,
  writeSearchListCache,
} from '../../services/search/searchListCache';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  putTrendEnrichMemory,
  snapshotTrendEnrichCache,
} from '../../services/trends';
import { __resetIconStoreForTests } from '../../services/iconStore';

const mocks = vi.hoisted(() => ({
  getAppDetails: vi.fn(),
  recordAppView: vi.fn(async () => {}),
  getRecentlyViewedApps: vi.fn(async (): Promise<AppSummary[]> => []),
  restoreOrFetchIconCycle: vi.fn(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'getAppDetails') return mocks.getAppDetails;
        if (prop === 'recordAppView') return mocks.recordAppView;
        if (prop === 'getRecentlyViewedApps') return mocks.getRecentlyViewedApps;
        if (prop === 'restoreOrFetchIconCycle') return mocks.restoreOrFetchIconCycle;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useDetailCacheSync } from './useDetailCacheSync';

function makeDetail(overrides: Partial<AppDetail> = {}): AppDetail {
  return {
    id: 'acme/atlas',
    name: 'Atlas',
    owner: 'acme',
    repo: 'atlas',
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'real atlas description',
    stars: 10,
    forks: 2,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: true,
    readme_markdown: '',
    releases: [],
    category: 'dev',
    category_name: '开发工具',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppSummary> & { id: string }): AppSummary {
  const id = overrides.id;
  const [owner, repo] = id.split('/');
  return {
    name: repo ?? id,
    owner: owner ?? id,
    repo: repo ?? id,
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${id} local desc`,
    stars: 1,
    forks: 1,
    license: 'MIT',
    latest_version: '0.9.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...overrides,
  };
}

interface Harness {
  result: { current: ReturnType<typeof useDetailCacheSync> };
  params: {
    setApps: ReturnType<typeof vi.fn>;
    setOnlineApps: ReturnType<typeof vi.fn>;
    setRecentlyViewedApps: ReturnType<typeof vi.fn>;
    setUncatalogedExtraApps: ReturnType<typeof vi.fn>;
    setSelectedApp: ReturnType<typeof vi.fn>;
    setPlatformResolvedOtherIds: ReturnType<typeof vi.fn>;
  };
}

function renderSync(
  overrides: Partial<Parameters<typeof useDetailCacheSync>[0]> = {},
): Harness {
  // spies 与 hook 入参对象分离：断言面恒为 vi.fn（无 Dispatch 联合类型）。
  const spies = {
    setApps: vi.fn(),
    setOnlineApps: vi.fn(),
    setRecentlyViewedApps: vi.fn(),
    setUncatalogedExtraApps: vi.fn(),
    setSelectedApp: vi.fn(),
    setPlatformResolvedOtherIds: vi.fn(),
  };
  const params = {
    selectedApp: null as AppDetailViewModel | null,
    appsRef: { current: [] as AppSummary[] },
    onlineAppsRef: { current: [] as AppSummary[] },
    recentsRef: { current: [] as AppSummary[] },
    ...spies,
    localApps: undefined as readonly AppSummary[] | undefined,
    ...overrides,
  };
  const rendered = renderHook(() =>
    useDetailCacheSync(params as Parameters<typeof useDetailCacheSync>[0]),
  );
  return { result: rendered.result, params: spies };
}

/** 取出 setter 最近一次入参；updater 形态则以 prev 求值。 */
function resolveSetter<T>(setter: { mock: { calls: unknown[][] } }, prev: T): T {
  const arg = setter.mock.calls[setter.mock.calls.length - 1][0];
  return typeof arg === 'function' ? (arg as (p: T) => T)(prev) : (arg as T);
}

/** 应用列表 updater（可传 setter mock 或单次 updater 入参），返回新列表。 */
function applyListSetter(
  setterOrUpdater: unknown,
  prev: AppSummary[],
): AppSummary[] {
  const isSetterMock =
    typeof setterOrUpdater === 'function' &&
    'mock' in (setterOrUpdater as unknown as { mock?: unknown });
  const updater = isSetterMock
    ? ((setterOrUpdater as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as (
        p: AppSummary[],
      ) => AppSummary[])
    : (setterOrUpdater as (p: AppSummary[]) => AppSummary[]);
  return updater(prev);
}

function flushMicrotasks(times = 4): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i += 1) p = p.then(() => {});
  return act(async () => {
    await p;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetIconStoreForTests();
  clearTrendEnrichCache();
  clearTrendConfirmedOtherCache();
  mocks.restoreOrFetchIconCycle.mockReset().mockResolvedValue({ url: '', level: 1 });
  mocks.getRecentlyViewedApps.mockReset().mockResolvedValue([]);
  mocks.recordAppView.mockReset().mockResolvedValue(undefined);
  mocks.getAppDetails.mockReset();
});

describe('useDetailCacheSync：0ms 快照与后台探查', () => {
  it('内存快照命中：先展快照（isLoading false）+ recordAppView + 后台条件探查', async () => {
    const { result, params } = renderSync();
    const cached = makeDetail();
    result.current.appDetailMemoryCache.current.set('acme/atlas', cached);
    mocks.getAppDetails.mockResolvedValue(makeDetail());

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });

    expect(params.setSelectedApp).toHaveBeenCalled();
    const shown = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, null);
    expect(shown?.id).toBe('acme/atlas');
    expect(shown?.isLoading).toBe(false);
    expect(shown?.isRefreshing).toBe(false);
    expect(mocks.recordAppView).toHaveBeenCalledWith('acme/atlas');
    expect(mocks.getAppDetails).toHaveBeenCalledWith('acme/atlas', false);
    // 目录集为空（fail-closed）：快照显式标注未收录。
    expect(shown?.is_cataloged).toBe(false);
  });

  it('后台静默探查同值返回 prev，变值（版本升级）平滑覆盖', async () => {
    const { result, params } = renderSync();
    result.current.appDetailMemoryCache.current.set('acme/atlas', makeDetail());
    mocks.getAppDetails.mockResolvedValue(makeDetail({ latest_version: '1.0.0' }));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });
    await flushMicrotasks();

    const shown = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, null);
    expect(shown?.latest_version).toBe('1.0.0');

    // 同值静默探查：updater 收 prev 返回 prev（引用不变，不触发重渲染）。
    params.setSelectedApp.mockClear();
    mocks.getAppDetails.mockResolvedValue(makeDetail({ latest_version: '1.0.0' }));
    act(() => {
      result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail(), true);
    });
    const prev_vm: AppDetailViewModel = { ...makeDetail(), isLoading: false };
    const again = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, prev_vm);
    expect(again).toBe(prev_vm);

    // 版本变化：静默探查也覆盖。
    params.setSelectedApp.mockClear();
    act(() => {
      result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ latest_version: '2.0.0' }), true);
    });
    const updated = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, prev_vm);
    expect(updated?.latest_version).toBe('2.0.0');
  });

  it('竞态守卫：A 慢 B 快，A 的迟到回包不覆盖已切换的选中态', async () => {
    const { result, params } = renderSync();
    let resolveA: ((d: AppDetail) => void) | undefined;
    mocks.getAppDetails.mockImplementationOnce(
      () =>
        new Promise<AppDetail>((resolve) => {
          resolveA = resolve;
        }),
    );
    mocks.getAppDetails.mockResolvedValueOnce(makeDetail({ id: 'beta/bravo', owner: 'beta', repo: 'bravo' }));

    await act(async () => {
      void result.current.handleOpenDetail('acme/atlas');
    });
    await act(async () => {
      await result.current.handleOpenDetail('beta/bravo');
    });
    params.setSelectedApp.mockClear();

    await act(async () => {
      resolveA?.(makeDetail({ latest_version: '9.9.9-late' }));
      await flushMicrotasks();
    });

    // A 迟到：选中态不被 A 触碰（B 的数据保持最后一次选中态写入）。
    for (const call of params.setSelectedApp.mock.calls) {
      const arg = call[0] as AppDetailViewModel | ((p: AppDetailViewModel | null) => AppDetailViewModel | null);
      const value = typeof arg === 'function' ? arg(null) : arg;
      expect(value?.id).not.toBe('acme/atlas');
      expect(String((value as AppDetailViewModel | null)?.latest_version ?? '')).not.toContain('9.9.9-late');
    }
    // 但列表数据仍按 id 落定（列表 patch 与选中态正交）。
    const patched = applyListSetter(params.setApps, [makeApp({ id: 'acme/atlas' })]);
    expect(patched[0].latest_version).toBe('9.9.9-late');
  });

  it('打开失败且仍处于活跃详情：写入 loadError', async () => {
    const { result, params } = renderSync();
    mocks.getAppDetails.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });

    // 错误写入经 updater：prev 为已打开的弹窗态时落地 loadError。
    const prev_vm: AppDetailViewModel = { ...makeDetail(), isLoading: true };
    const shown = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, prev_vm);
    expect(String(shown?.loadError ?? '')).toContain('network down');
    expect(shown?.isLoading).toBe(false);
  });
});

describe('useDetailCacheSync：占位简介与富卡治愈', () => {
  it('后端占位简介不污染内存快照：有富卡治愈为实值，无富卡存空串', async () => {
    const { result } = renderSync();
    putTrendEnrichMemory({
      'acme/atlas': makeApp({ id: 'acme/atlas', description: 'rich real description', platforms: ['windows'] }),
    });

    act(() => {
      result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ description: 'GitHub 社区开源项目' }));
    });

    const cached = result.current.appDetailMemoryCache.current.get('acme/atlas');
    expect(cached?.description).toBe('rich real description');
    expect(cached?.description).not.toContain('GitHub 社区开源项目');

    // 无富卡：内存快照存 ''（渲染侧走空逻辑，不存占位文案）。
    clearTrendEnrichCache();
    act(() => {
      result.current.patchDetailMemoryAndLists('beta/bravo', makeDetail({ id: 'beta/bravo', owner: 'beta', repo: 'bravo', description: '暂无简介' }));
    });
    expect(result.current.appDetailMemoryCache.current.get('beta/bravo')?.description).toBe('');
  });

  it('loadRecentViews：黄标叠加本地段 + 占位行富卡治愈', async () => {
    const localApps = [makeApp({ id: 'acme/atlas', source: 'local', status: 'collected' })];
    const { result, params } = renderSync({ localApps });
    mocks.getRecentlyViewedApps.mockResolvedValue([
      makeApp({ id: 'acme/atlas', description: 'GitHub 社区开源项目', platforms: ['windows'] }),
    ]);
    putTrendEnrichMemory({
      'acme/atlas': makeApp({ id: 'acme/atlas', description: 'healed from richcard', platforms: ['windows'] }),
    });

    await act(async () => {
      await result.current.loadRecentViews();
    });

    expect(params.setRecentlyViewedApps).toHaveBeenCalled();
    const rows = resolveSetter<AppSummary[]>(params.setRecentlyViewedApps, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('healed from richcard');
    expect(rows[0].source).toBe('local');
    expect(rows[0].is_cataloged).toBe(true);
  });
});

describe('useDetailCacheSync：平台确认/治愈与 stale 语义', () => {
  it('非 stale 空平台：确认 other（双键入集）并派富卡事件（confirmedOther）', async () => {
    const { result, params } = renderSync();
    const richEvents: unknown[] = [];
    const onRich = (e: Event): void => {
      richEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRich);

    try {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ platforms: [] }));
      });
      const confirmed = resolveSetter<Set<string>>(params.setPlatformResolvedOtherIds, new Set());
      expect(confirmed.has('acme/atlas')).toBe(true);
      expect(richEvents.length).toBe(1);
      expect((richEvents[0] as { confirmedOther?: boolean }).confirmedOther).toBe(true);
    } finally {
      window.removeEventListener(DETAIL_RICHCARD_HEAL_EVENT, onRich);
    }
  });

  it('真实平台治愈：列表空平台行回填、other 集解除、平台治愈事件扇出', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    const platformEvents: unknown[] = [];
    const onPlatform = (e: Event): void => {
      platformEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatform);

    try {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ platforms: ['windows', 'linux'] }));
      });

      const patched = applyListSetter(params.setApps, apps);
      expect(patched[0].platforms).toEqual(['windows', 'linux']);

      const nextOthers = resolveSetter<Set<string>>(params.setPlatformResolvedOtherIds, new Set(['acme/atlas']));
      expect(nextOthers.has('acme/atlas')).toBe(false);

      expect(platformEvents.length).toBe(1);
      const payload = platformEvents[0] as { keys: string[]; platforms: string[] };
      expect(payload.platforms).toEqual(['windows', 'linux']);
      expect(payload.keys).toContain('acme/atlas');
    } finally {
      window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatform);
    }
  });

  it('stale 离线详情：平台保持 loading（不确认 other、不派治愈事件）', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    const platformEvents: unknown[] = [];
    const onPlatform = (e: Event): void => {
      platformEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatform);

    try {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ is_stale: true, platforms: [] }));
      });

      expect(params.setPlatformResolvedOtherIds).not.toHaveBeenCalled();
      expect(platformEvents.length).toBe(0);
      // 列表平台保持空（loading 语义），但其余字段照常落定。
      const patched = applyListSetter(params.setApps, apps);
      expect(patched[0].platforms).toEqual([]);
      expect(patched[0].latest_version).toBe('1.0.0');
    } finally {
      window.removeEventListener(DETAIL_PLATFORMS_HEAL_EVENT, onPlatform);
    }
  });
});

describe('useDetailCacheSync：图标三态', () => {
  it('详情 http 实图：四列表写透回填', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    const iconUrl = 'https://cdn.example.com/atlas.png';

    act(() => {
      result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ icon: iconUrl }));
    });

    for (const setter of [params.setApps, params.setOnlineApps, params.setRecentlyViewedApps, params.setUncatalogedExtraApps]) {
      const patched = applyListSetter(setter as never, apps);
      expect(patched[0].icon).toBe(iconUrl);
    }
  });

  it('data: 详情图标永不进列表；cycle remote_url 是唯一落盘真值', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    const dataUri = 'data:image/png;base64,AAAA';
    mocks.restoreOrFetchIconCycle.mockResolvedValue({
      url: dataUri,
      remote_url: 'https://cdn.example.com/atlas-remote.png',
      level: 3,
    });

    await act(async () => {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ icon: dataUri }));
      });
      await flushMicrotasks();
    });

    expect(mocks.restoreOrFetchIconCycle).toHaveBeenCalledWith('acme/atlas');
    // 调用序：[0] 详情首 patch（data: 不进 patch，保持卡上旧图标）→ [1] cycle remote_url 落盘写透。
    expect(params.setApps.mock.calls.length).toBeGreaterThanOrEqual(2);
    const afterFirstPatch = applyListSetter(params.setApps.mock.calls[0]![0] as never, apps);
    expect(afterFirstPatch[0].icon).toBe('📦');
    await waitFor(() => {
      const persisted = applyListSetter(params.setApps.mock.calls[params.setApps.mock.calls.length - 1]![0] as never, apps);
      expect(persisted[0].icon).toBe('https://cdn.example.com/atlas-remote.png');
    });
  });

  it('cycle 仅 data:（无 remote_url）且非 L5：不落盘，列表保持占位', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    mocks.restoreOrFetchIconCycle.mockResolvedValue({ url: 'data:image/png;base64,AAAA', level: 2 });

    await act(async () => {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ icon: '' }));
      });
      await flushMicrotasks();
    });

    expect(mocks.restoreOrFetchIconCycle).toHaveBeenCalled();
    // 只有详情首 patch 一次；L2 data: 不经 admitIconHit 扇出（无第二次落盘调用）。
    expect(params.setApps.mock.calls).toHaveLength(1);
    const patched = applyListSetter(params.setApps.mock.calls[0]![0] as never, apps);
    expect(patched[0].icon).toBe('📦');
  });

  it('cycle 空且 L5：显式空徽章经唯一写口落盘（icon 置空）', async () => {
    const apps = [makeApp({ id: 'acme/atlas' })];
    const { result, params } = renderSync({ appsRef: { current: apps } });
    mocks.restoreOrFetchIconCycle.mockResolvedValue({ url: '', level: 5 });

    await act(async () => {
      act(() => {
        result.current.patchDetailMemoryAndLists('acme/atlas', makeDetail({ icon: '' }));
      });
      await flushMicrotasks();
    });

    await waitFor(() => {
      const patched = applyListSetter(params.setApps, apps);
      expect(patched[0].icon).toBe('');
    });
  });

  it('0ms 内存快照命中时，若本地收录已添加新图标与分类，瞬间展示优先采用新图标', async () => {
    const oldDetail = makeDetail({
      id: 'pingdotgg/t3code',
      icon: '',
      description: 'old github description',
      category: 'system',
      category_name: '系统实用',
    });
    const localCollectedApp = makeApp({
      id: 'pingdotgg/t3code',
      icon: 'https://cdn.example.com/t3-black.png',
      icon_bg: '#000000',
      description: '自收录的新摘要',
      category: 'dev',
      category_name: '开发工具',
    });

    const { result, params } = renderSync({
      localApps: [localCollectedApp],
    });
    // 模拟之前浏览过，内存快照中存在旧详情（无图标）
    result.current.appDetailMemoryCache.current.set('pingdotgg/t3code', oldDetail);
    mocks.getAppDetails.mockResolvedValue(oldDetail);

    await act(async () => {
      await result.current.handleOpenDetail('pingdotgg/t3code');
    });

    // 0ms 快照展示时已治愈为本地收录的新图标和分类
    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pingdotgg/t3code',
        icon: 'https://cdn.example.com/t3-black.png',
        icon_bg: '#000000',
        description: '自收录的新摘要',
        category: 'dev',
        category_name: '开发工具',
      }),
    );
  });

  it('打开应用详情拿到更新后全字段写透 searchListCache 与 trendEnrichCache', () => {
    clearSearchListCache();
    writeSearchListCache(
      { query: 'atlas', page: 1, perPage: 20 },
      [
        makeApp({
          id: 'acme/atlas',
          stars: 10,
          latest_version: 'latest',
          description: 'old search desc',
          platforms: [],
          license: 'OpenSource',
        }),
      ],
    );
    putTrendEnrichMemory({
      'acme/atlas': makeApp({
        id: 'acme/atlas',
        stars: 10,
        latest_version: 'latest',
        description: 'old trend desc',
        platforms: ['windows'],
        license: 'OpenSource',
      }),
    });

    const { result } = renderSync();
    act(() => {
      result.current.patchDetailMemoryAndLists(
        'acme/atlas',
        makeDetail({
          id: 'acme/atlas',
          stars: 888,
          forks: 77,
          latest_version: 'v3.2.1',
          description: 'updated detail desc',
          license: 'GPL-3.0',
          homepage: 'https://atlas.dev',
          platforms: ['windows', 'macos'],
          icon: 'https://cdn.example.com/atlas-v3.png',
        }),
      );
    });

    const searchRows = readSearchListCache({ query: 'atlas', page: 1, perPage: 20 });
    expect(searchRows?.[0]?.stars).toBe(888);
    expect(searchRows?.[0]?.latest_version).toBe('v3.2.1');
    expect(searchRows?.[0]?.description).toBe('updated detail desc');
    expect(searchRows?.[0]?.license).toBe('GPL-3.0');
    expect(searchRows?.[0]?.homepage).toBe('https://atlas.dev');
    expect(searchRows?.[0]?.platforms).toEqual(['windows', 'macos']);
    expect(searchRows?.[0]?.icon).toBe('https://cdn.example.com/atlas-v3.png');

    const trendSnap = snapshotTrendEnrichCache()['acme/atlas'];
    expect(trendSnap?.stars).toBe(888);
    expect(trendSnap?.latest_version).toBe('v3.2.1');
    expect(trendSnap?.description).toBe('updated detail desc');
    expect(trendSnap?.platforms).toEqual(['windows', 'macos']);
    clearSearchListCache();
  });

  it('打开仅在 Starred 缓存存在的未收录应用详情：首帧直接继承卡片摘要（不闪 0 星与占位描述）', async () => {
    clearSearchListCache();
    writeSearchListCache(
      { namespace: 'starred', query: 'octocat', page: 1, perPage: 20 },
      [
        makeApp({
          id: 'acme/starred-only',
          name: 'StarredOnly',
          owner: 'acme',
          repo: 'starred-only',
          stars: 9527,
          forks: 123,
          license: 'Apache-2.0',
          latest_version: 'v2.4.0',
          description: 'starred card summary',
          icon: 'https://cdn.example.com/starred.png',
          platforms: ['macos'],
        }),
      ],
    );
    const { result, params } = renderSync();
    let resolveDetail: (d: ReturnType<typeof makeDetail>) => void = () => {};
    mocks.getAppDetails.mockImplementationOnce(
      () => new Promise((r) => { resolveDetail = r; }),
    );

    await act(async () => {
      void result.current.handleOpenDetail('acme/starred-only');
    });

    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acme/starred-only',
        name: 'StarredOnly',
        stars: 9527,
        latest_version: 'v2.4.0',
        description: 'starred card summary',
        icon: 'https://cdn.example.com/starred.png',
        isLoading: true,
      }),
    );

    await act(async () => {
      resolveDetail(makeDetail({ id: 'acme/starred-only', owner: 'acme', repo: 'starred-only' }));
      await flushMicrotasks();
    });
    clearSearchListCache();
  });
});

describe('useDetailCacheSync：官方主页同步', () => {
  it('后台静默探查发现主页变化：selectedApp.homepage 随之更新', async () => {
    const { result, params } = renderSync();
    result.current.appDetailMemoryCache.current.set('acme/atlas', makeDetail({ homepage: null }));
    mocks.getAppDetails.mockResolvedValue(makeDetail({ homepage: 'https://atlas.dev' }));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });
    await flushMicrotasks();

    const prev: AppDetailViewModel = { ...makeDetail({ homepage: null }), isLoading: false };
    const next = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, prev);
    expect(next).not.toBe(prev);
    expect(next?.homepage).toBe('https://atlas.dev');
  });

  it('内存快照主页为空：用目录命中的主页治愈首帧', async () => {
    const { result, params } = renderSync({
      appsRef: { current: [makeApp({ id: 'acme/atlas', homepage: 'https://atlas.dev' })] },
    });
    result.current.appDetailMemoryCache.current.set('acme/atlas', makeDetail({ homepage: '' }));
    mocks.getAppDetails.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });

    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acme/atlas', homepage: 'https://atlas.dev', isLoading: false }),
    );
  });

  it('详情返回无主页：保留首帧已治愈的主页，不闪现后消失', async () => {
    const { result, params } = renderSync({
      appsRef: { current: [makeApp({ id: 'acme/atlas', homepage: 'https://atlas.dev' })] },
    });
    result.current.appDetailMemoryCache.current.set('acme/atlas', makeDetail({ homepage: '' }));
    mocks.getAppDetails.mockResolvedValue(makeDetail({ homepage: null }));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });
    await flushMicrotasks();

    const prev: AppDetailViewModel = { ...makeDetail({ homepage: 'https://atlas.dev' }), isLoading: false };
    const next = resolveSetter<AppDetailViewModel | null>(params.setSelectedApp, prev);
    expect(next?.homepage).toBe('https://atlas.dev');

    // 列表行同样保留主页，下次内存命中仍可治愈
    const patched = applyListSetter(params.setApps, [makeApp({ id: 'acme/atlas', homepage: 'https://atlas.dev' })]);
    expect(patched[0]?.homepage).toBe('https://atlas.dev');
  });

  it('未收录趋势仓：富卡已带主页时首帧同步展示（不等 getAppDetails）', async () => {
    putTrendEnrichMemory({
      'acme/atlas': makeApp({ id: 'acme/atlas', homepage: 'https://atlas.dev', platforms: ['windows'] }),
    });
    const { result, params } = renderSync();
    mocks.getAppDetails.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      void result.current.handleOpenDetail('acme/atlas');
    });

    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acme/atlas', homepage: 'https://atlas.dev', isLoading: true }),
    );
  });

  it('已收录应用非空旧平台与详情非 stale 新平台不一致时同步更新列表（含 fullCatalogApps）且同值保引用', () => {
    const initialCard = makeApp({
      id: 'p0deje/maccy',
      name: 'Maccy',
      owner: 'p0deje',
      repo: 'Maccy',
      platforms: ['windows'],
      is_cataloged: true,
    });
    const sameCard = makeApp({
      id: 'other/same',
      platforms: ['macos'],
      is_cataloged: true,
    });
    const setFullCatalogApps = vi.fn();
    const { result, params } = renderSync({
      appsRef: { current: [initialCard, sameCard] },
      fullCatalogAppsRef: { current: [initialCard, sameCard] },
      setFullCatalogApps: setFullCatalogApps as unknown as React.Dispatch<React.SetStateAction<AppSummary[]>>,
    });

    act(() => {
      result.current.patchDetailMemoryAndLists(
        'p0deje/maccy',
        makeDetail({
          id: 'p0deje/maccy',
          name: 'Maccy',
          owner: 'p0deje',
          repo: 'Maccy',
          platforms: ['macos'],
          is_cataloged: true,
        }),
      );
    });

    const patchedApps = applyListSetter(params.setApps, [initialCard, sameCard]);
    expect(patchedApps[0].platforms).toEqual(['macos']);
    expect(patchedApps[1]).toBe(sameCard);

    const patchedFull = applyListSetter(setFullCatalogApps, [initialCard, sameCard]);
    expect(patchedFull[0].platforms).toEqual(['macos']);

    // 平台相同但数组引用不同时，不产生新对象引用
    params.setApps.mockClear();
    const updatedCard = patchedApps[0];
    act(() => {
      result.current.patchDetailMemoryAndLists(
        'p0deje/maccy',
        makeDetail({
          id: 'p0deje/maccy',
          name: 'Maccy',
          owner: 'p0deje',
          repo: 'Maccy',
          stars: updatedCard.stars,
          forks: updatedCard.forks,
          latest_version: updatedCard.latest_version,
          icon: updatedCard.icon,
          description: updatedCard.description,
          description_en: updatedCard.description_en,
          license: updatedCard.license,
          category: updatedCard.category,
          category_name: updatedCard.category_name,
          is_verified: updatedCard.is_verified,
          homepage: updatedCard.homepage,
          platforms: ['macos'],
          is_cataloged: true,
        }),
      );
    });
    const noopResult = applyListSetter(params.setApps, [updatedCard]);
    expect(noopResult[0]).toBe(updatedCard);
  });

  it('内存快照命中时：收录库/本地收录公共字段（含 platforms/license/homepage/name/is_verified/added_at）优先覆盖快照，保留实时 stars/latest_version', async () => {
    const localCard = makeApp({
      id: 'acme/atlas',
      name: 'Curated Atlas',
      license: 'GPL-3.0',
      homepage: 'https://curated.atlas.dev',
      platforms: ['windows', 'ios'],
      is_verified: true,
      added_at: '2026-11-12',
      is_cataloged: true,
      source: 'local',
      status: 'collected',
    });
    const { result, params } = renderSync({
      localApps: [localCard],
    });
    result.current.appDetailMemoryCache.current.set(
      'acme/atlas',
      makeDetail({
        id: 'acme/atlas',
        name: 'Repo Atlas',
        license: 'MIT',
        homepage: 'https://repo.atlas.dev',
        platforms: ['linux'],
        is_verified: false,
        added_at: '2025-01-01',
        stars: 9999,
        latest_version: 'v3.2.1',
      }),
    );
    mocks.getAppDetails.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await result.current.handleOpenDetail('acme/atlas');
    });

    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acme/atlas',
        name: 'Curated Atlas',
        license: 'GPL-3.0',
        homepage: 'https://curated.atlas.dev',
        platforms: ['windows', 'ios'],
        is_verified: true,
        added_at: '2026-11-12',
        stars: 9999,
        latest_version: 'v3.2.1',
        isLoading: false,
      }),
    );
  });

  it('内存未命中首帧：继承收录库 added_at 与 is_verified', async () => {
    const curatedCard = makeApp({
      id: 'acme/atlas',
      name: 'Curated Atlas',
      is_verified: true,
      added_at: '2026-11-14',
      platforms: ['macos'],
      is_cataloged: true,
    });
    const { result, params } = renderSync({
      fullCatalogAppsRef: { current: [curatedCard] },
    });
    mocks.getAppDetails.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      void result.current.handleOpenDetail('acme/atlas');
    });

    expect(params.setSelectedApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acme/atlas',
        is_verified: true,
        added_at: '2026-11-14',
        isLoading: true,
      }),
    );
  });
});
