/**
 * 侧栏平台计数（含搜索态在线结果纳入、行别名去重与平台并集）测试。
 */
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  mergeAppsForPlatformCounts,
  selectPlatformCounts,
  useAppSelectors,
} from './selectors';
import { PLATFORM_IDS, type PlatformId } from '../lib/platformFilter';
import type { AppSummary } from '../types';

afterEach(() => cleanup());

function makeApp(id: string, platforms: string[] = [], extra: Partial<AppSummary> = {}): AppSummary {
  const [owner = 'o', repo = id] = id.split('/');
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: 'desc',
    stars: 100,
    forks: 10,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'dev',
    category_name: 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms,
    ...extra,
  };
}

describe('mergeAppsForPlatformCounts & selectPlatformCounts', () => {
  it('merges local and online search results and deduplicates canonical IDs', () => {
    const local = [makeApp('zai-org/ZCode', ['windows', 'macos'])];
    const online = [
      makeApp('zai-org/zcode', ['windows', 'macos']),
      makeApp('ZiChuanLan/agent-purge', ['windows']),
      makeApp('TriDefender/zcode-api', ['windows', 'linux']),
      makeApp('asgeirtj/system_prompts', []),
      makeApp('pending/loading-app', []),
    ];
    const resolvedOther = new Set(['asgeirtj/system_prompts']);

    const merged = mergeAppsForPlatformCounts(local, online);
    expect(merged.map((a) => a.id)).toEqual([
      'zai-org/ZCode',
      'ZiChuanLan/agent-purge',
      'TriDefender/zcode-api',
      'asgeirtj/system_prompts',
      'pending/loading-app',
    ]);

    const counts = selectPlatformCounts(merged, resolvedOther);
    expect(counts).toEqual({
      windows: 3,
      macos: 1,
      linux: 1,
      ios: 0,
      android: 0,
      other: 1,
    });
  });

  it('deduplicates via rowAliasKeys, deduplicates baseApps alone, and unions partial platforms', () => {
    const local = [
      makeApp('zcode', ['windows'], { owner: 'zai-org', repo: 'ZCode' }),
      makeApp('github:zai-org/zcode', ['linux'], { owner: 'zai-org', repo: 'ZCode' }),
    ];
    const baseOnly = mergeAppsForPlatformCounts(local);
    expect(baseOnly).toHaveLength(1);
    expect(baseOnly[0]?.platforms).toEqual(['windows', 'linux']);

    const online = [makeApp('zai-org/zcode', ['Windows', 'macos'])];
    const merged = mergeAppsForPlatformCounts(local, online);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.platforms).toEqual(['windows', 'linux', 'macos']);
  });

  it('upgrades an empty-platform entry when the duplicate carries deduced platforms', () => {
    const local = [makeApp('owner/app', [])];
    const online = [makeApp('owner/app', ['linux', 'macos'])];
    const merged = mergeAppsForPlatformCounts(local, online);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.platforms).toEqual(['linux', 'macos']);
  });
});

describe('useAppSelectors sidebarPlatformCounts during search', () => {
  const localOnlyCounts: Record<PlatformId, number> = {
    windows: 1,
    macos: 1,
    linux: 0,
    ios: 0,
    android: 0,
    other: 0,
  };

  const baseParams = {
    apps: [makeApp('zai-org/ZCode', ['windows', 'macos'])],
    onlineApps: [
      makeApp('zai-org/zcode', ['windows', 'macos']),
      makeApp('pipy/zcode-switch', ['windows', 'macos', 'linux']),
      makeApp('asgeirtj/system_prompts', []),
      makeApp('mobile/zcode-app', ['android', 'ios']),
    ],
    uncatalogedExtraApps: [] as AppSummary[],
    installedApps: [],
    updates: [],
    selectedPlatforms: new Set<PlatformId>(PLATFORM_IDS),
    setSelectedPlatforms: (() => {}) as React.Dispatch<React.SetStateAction<Set<PlatformId>>>,
    platformResolvedOtherIds: new Set(['asgeirtj/system_prompts']),
    selectedApp: null,
    recentlyViewedApps: [],
    currentView: 'home' as const,
    stagedDeepLinkInstall: null,
    searchQuery: 'ZCode',
    isOnlineResults: true,
  };

  it('includes deduplicated online search results on home view when searching', () => {
    const { result } = renderHook(() => useAppSelectors(baseParams));
    expect(result.current.sidebarPlatformCounts).toEqual({
      windows: 2,
      macos: 2,
      linux: 1,
      ios: 1,
      android: 1,
      other: 1,
    });
  });

  it('does not shrink sidebarPlatformCounts when platform filter excludes some platforms', () => {
    const { result } = renderHook(() =>
      useAppSelectors({
        ...baseParams,
        selectedPlatforms: new Set<PlatformId>(['linux']),
      }),
    );
    expect(result.current.searchPlatformFilteredApps).toHaveLength(0);
    expect(result.current.platformFilteredOnlineApps).toHaveLength(1);
    expect(result.current.sidebarPlatformCounts).toEqual({
      windows: 2,
      macos: 2,
      linux: 1,
      ios: 1,
      android: 1,
      other: 1,
    });
  });

  it.each<{ label: string; override: Partial<Parameters<typeof useAppSelectors>[0]> }>([
    { label: 'isOnlineResults is false', override: { isOnlineResults: false } },
    { label: 'isOnlineResults is omitted (defaults false)', override: { isOnlineResults: undefined } },
    { label: 'searchQuery is empty', override: { searchQuery: '   ' } },
    { label: 'currentView is not home', override: { currentView: 'categories' } },
  ])('falls back to local platformCounts when $label', ({ override }) => {
    const { result } = renderHook(() => useAppSelectors({ ...baseParams, ...override }));
    expect(result.current.sidebarPlatformCounts).toEqual(localOnlyCounts);
  });
});

describe('useAppSelectors 全量目录基线与顶栏搜索隔离', () => {
  // 10 款已收录：vlc 双平台，其余 9 款 windows；顶栏残留搜索词 vlc 时 apps 只剩 1 款。
  const vlc = makeApp('videolan/vlc', ['windows', 'linux']);
  const others = Array.from({ length: 9 }, (_, i) => makeApp(`acme/tool-${i}`, ['windows']));
  const fullCatalog = [vlc, ...others];
  const fullCounts: Record<PlatformId, number> = {
    windows: 10,
    macos: 0,
    linux: 1,
    ios: 0,
    android: 0,
    other: 0,
  };

  const params = {
    apps: [vlc],
    fullCatalogApps: fullCatalog,
    onlineApps: [] as AppSummary[],
    uncatalogedExtraApps: [] as AppSummary[],
    installedApps: [],
    updates: [],
    selectedPlatforms: new Set<PlatformId>(PLATFORM_IDS),
    setSelectedPlatforms: (() => {}) as React.Dispatch<React.SetStateAction<Set<PlatformId>>>,
    platformResolvedOtherIds: new Set<string>(),
    selectedApp: null,
    recentlyViewedApps: [],
    currentView: 'categories' as Parameters<typeof useAppSelectors>[0]['currentView'],
    stagedDeepLinkInstall: null,
    searchQuery: 'vlc',
  };

  it('残留搜索词不截断目录链、收藏供给与非 home 视图侧栏计数', () => {
    const { result } = renderHook(() => useAppSelectors(params));
    expect(result.current.fullMergedCatalogApps).toHaveLength(10);
    expect(result.current.catalogPlatformFilteredApps).toHaveLength(10);
    expect(result.current.favoritesViewApps).toHaveLength(10);
    expect(result.current.sidebarPlatformCounts).toEqual(fullCounts);
    // 搜索链只服务 SearchResultsView。
    expect(result.current.searchPlatformFilteredApps.map((a) => a.id)).toEqual(['videolan/vlc']);
  });

  it('home 搜索态侧栏计数为本地搜索命中分布', () => {
    const { result } = renderHook(() => useAppSelectors({ ...params, currentView: 'home' }));
    expect(result.current.sidebarPlatformCounts).toEqual({ ...fullCounts, windows: 1 });
  });

  it('本地库行进入全量基线但不受搜索词裁剪；未收录补充行并入收藏池', () => {
    const local = { ...makeApp('me/local-only', ['macos']), status: 'collected', archived: false };
    const extra = makeApp('ghost/unlisted', []);
    const { result } = renderHook(() =>
      useAppSelectors({ ...params, customApps: [local], uncatalogedExtraApps: [extra, makeApp('VideoLAN/VLC', [])] }),
    );
    expect(result.current.fullMergedCatalogApps.map((a) => a.id)).toContain('me/local-only');
    expect(result.current.searchPlatformFilteredApps.map((a) => a.id)).toEqual(['videolan/vlc']);
    // 收藏池：全量目录 11 + 未收录 1（与目录大小写变体去重）。
    expect(result.current.allFavoritesPoolApps).toHaveLength(12);
  });

  it('platformFilteredFavoriteCount：平台过滤后命中收藏的去重条数，ID 大小写归一', () => {
    const favoriteIds = new Set(['VideoLAN/VLC', 'acme/tool-0', 'ghost/missing']);
    const { result, rerender } = renderHook((p: typeof params & { favoriteIds: Set<string> }) => useAppSelectors(p), {
      initialProps: { ...params, favoriteIds },
    });
    expect(result.current.platformFilteredFavoriteCount).toBe(2);
    rerender({ ...params, favoriteIds, selectedPlatforms: new Set<PlatformId>(['linux']) });
    expect(result.current.platformFilteredFavoriteCount).toBe(1);
  });

  it('pendingFilteredCount：未归档条目按平台过滤计数', () => {
    const entries = [
      { item: { platforms: ['windows'] }, archived: false },
      { item: { platforms: ['macos'] }, archived: false },
      { item: { platforms: [] }, archived: false },
      { item: { platforms: ['windows'] }, archived: true },
    ];
    const { result, rerender } = renderHook((p: typeof params) => useAppSelectors({ ...p, pendingEntries: entries }), {
      initialProps: params,
    });
    expect(result.current.pendingFilteredCount).toBe(3);
    rerender({ ...params, selectedPlatforms: new Set<PlatformId>(['windows']) });
    expect(result.current.pendingFilteredCount).toBe(1);
  });
});

describe('useAppSelectors 视图级侧栏平台计数通道', () => {
  const app = makeApp('acme/atlas', ['windows']);
  const latestCounts: Record<PlatformId, number> = {
    windows: 0,
    macos: 3,
    linux: 0,
    ios: 0,
    android: 0,
    other: 0,
  };
  const fullCounts: Record<PlatformId, number> = { ...latestCounts, windows: 1, macos: 0 };
  type View = Parameters<typeof useAppSelectors>[0]['currentView'];
  const render = (currentView: View) =>
    renderHook(
      ({ view }: { view: View }) =>
        useAppSelectors({
          apps: [app],
          fullCatalogApps: [app],
          onlineApps: [],
          uncatalogedExtraApps: [],
          installedApps: [],
          updates: [],
          selectedPlatforms: new Set<PlatformId>(PLATFORM_IDS),
          setSelectedPlatforms: (() => {}) as React.Dispatch<React.SetStateAction<Set<PlatformId>>>,
          platformResolvedOtherIds: new Set<string>(),
          selectedApp: null,
          recentlyViewedApps: [],
          currentView: view,
          stagedDeepLinkInstall: null,
        }),
      { initialProps: { view: currentView } },
    );

  it('当前视图上报值优先；其它视图上报不串用；非全库视图未上报时为 undefined（不闪全库），分类大厅 null 回退全库', () => {
    const { result } = render('latest');
    expect(result.current.sidebarPlatformCounts).toBeUndefined();
    act(() => result.current.setViewPlatformCounts('pending', latestCounts));
    expect(result.current.sidebarPlatformCounts).toBeUndefined();
    act(() => result.current.handleLatestPlatformCounts(latestCounts));
    expect(result.current.sidebarPlatformCounts).toEqual(latestCounts);
    act(() => result.current.handleLatestPlatformCounts(null));
    expect(result.current.sidebarPlatformCounts).toBeUndefined();

    const cat = render('categories');
    expect(cat.result.current.sidebarPlatformCounts).toEqual(fullCounts);
    act(() => cat.result.current.handleCategoryPlatformCounts(latestCounts));
    expect(cat.result.current.sidebarPlatformCounts).toEqual(latestCounts);
    act(() => cat.result.current.handleCategoryPlatformCounts(null));
    expect(cat.result.current.sidebarPlatformCounts).toEqual(fullCounts);
  });

  it('离开视图即复位该视图槽位，返回后在重新上报前回退全库', () => {
    const { result, rerender } = render('categories');
    act(() => result.current.handleCategoryPlatformCounts(latestCounts));
    expect(result.current.sidebarPlatformCounts).toEqual(latestCounts);
    rerender({ view: 'home' });
    expect(result.current.sidebarPlatformCounts).toEqual(fullCounts);
    rerender({ view: 'categories' });
    expect(result.current.sidebarPlatformCounts).toEqual(fullCounts);
  });

  it.each<[View, 'handleTrendsPlatformCounts' | 'handlePendingPlatformCounts' | 'handleInstalledPlatformCounts' | 'handleFavoritesPlatformCounts']>([
    ['trends', 'handleTrendsPlatformCounts'],
    ['pending', 'handlePendingPlatformCounts'],
    ['installed', 'handleInstalledPlatformCounts'],
    ['favorites', 'handleFavoritesPlatformCounts'],
  ])('%s 视图经 %s 上报', (view, handler) => {
    const { result } = render(view);
    act(() => result.current[handler](latestCounts));
    expect(result.current.sidebarPlatformCounts).toEqual(latestCounts);
  });
});
