/**
 * 侧栏平台计数（含搜索态在线结果纳入、行别名去重与平台并集）测试。
 */
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
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
    expect(result.current.platformFilteredApps).toHaveLength(0);
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
