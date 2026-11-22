/** 测试「我的应用」状态域：已装列表单发加载、卸载即清更新项、受管态门控与平台过滤视图。 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary, InstalledApp, UpdateItem, ViewType } from '../../types';
import { PLATFORM_IDS, type PlatformId } from '../../lib/platformFilter';

const mocks = vi.hoisted(() => ({
  getInstalledApps: vi.fn(async (): Promise<InstalledApp[]> => []),
  getUpdateRules: vi.fn(async () => []),
  getCachedUpdates: vi.fn(async (): Promise<UpdateItem[]> => []),
  uninstallApp: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
  hydrateCardsByIds: vi.fn(async () => ({ byId: new Map() })),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  const table: Record<string, unknown> = {
    getInstalledApps: mocks.getInstalledApps,
    getUpdateRules: mocks.getUpdateRules,
    getCachedUpdates: mocks.getCachedUpdates,
    uninstallApp: mocks.uninstallApp,
    onUpdateItemFound: mocks.listen,
    onUpdateCheckProgress: mocks.listen,
    onUpdateCheckFinished: mocks.listen,
  };
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        typeof prop === 'string' && prop in table ? table[prop] : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

vi.mock('../../services/repoEnrichCache', async () => {
  const actual = await vi.importActual<typeof import('../../services/repoEnrichCache')>('../../services/repoEnrichCache');
  return { ...actual, hydrateCardsByIds: mocks.hydrateCardsByIds };
});

import { useMyAppsState } from './useMyAppsState';

function makeInstalled(id: string): InstalledApp {
  return {
    app_id: id,
    app_name: `${id} App`,
    version: '1.0.0',
    installed_at: 1700000000,
    install_method: 'msi',
    install_path: 'C:\\x',
    asset_name: 'a.msi',
    asset_sha256: 'ab'.repeat(32),
  };
}

function makeSummary(id: string, platforms: string[]): AppSummary {
  const [owner, repo] = id.split('/');
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: '',
    stars: 0,
    forks: 0,
    license: 'MIT',
    latest_version: '2.0.0',
    category: 'dev',
    category_name: 'dev',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms,
  };
}

function renderMyApps(initialView: ViewType = 'home', selected: PlatformId[] = [...PLATFORM_IDS]) {
  const appsById = new Map([
    ['acme/win', makeSummary('acme/win', ['windows'])],
    ['acme/mac', makeSummary('acme/mac', ['macos'])],
  ]);
  return renderHook(
    ({ view, platforms }: { view: ViewType; platforms: Set<PlatformId> }) =>
      useMyAppsState({
        currentView: view,
        catalogLists: { apps: [], setApps: vi.fn(), setFullCatalogApps: vi.fn() },
        searchQuery: '',
        appsById,
        selectedPlatforms: platforms,
        platformResolvedOtherIds: new Set<string>(),
        showToast: vi.fn(),
        t: ((key: string) => key) as never,
      }),
    { initialProps: { view: initialView, platforms: new Set<PlatformId>(selected) } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInstalledApps.mockResolvedValue([makeInstalled('acme/win'), makeInstalled('acme/mac')]);
  mocks.getCachedUpdates.mockResolvedValue([]);
});

describe('useMyAppsState：已装列表加载', () => {
  it('启动读一次，进入「我的应用」仅再读一次', async () => {
    const { result, rerender } = renderMyApps('home');
    await waitFor(() => expect(result.current.managedLoaded).toBe(true));
    expect(mocks.getInstalledApps).toHaveBeenCalledTimes(1);
    expect(result.current.installedApps).toHaveLength(2);

    rerender({ view: 'installed', platforms: new Set<PlatformId>(PLATFORM_IDS) });
    await waitFor(() => expect(mocks.getInstalledApps).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getInstalledApps).toHaveBeenCalledTimes(2);
  });

  it('首读失败同样放行受管态并记录错误', async () => {
    mocks.getInstalledApps.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderMyApps('home');
    await waitFor(() => expect(result.current.managedLoaded).toBe(true));
    expect(result.current.installLoadError).toContain('boom');
  });
});

describe('useMyAppsState：卸载与更新项同域', () => {
  it('卸载成功即剔除该应用的残留更新项', async () => {
    mocks.getCachedUpdates.mockResolvedValue([
      { app_id: 'acme/win', app_name: 'win', current_version: '1.0.0', latest_version: '2.0.0', changelog: '' },
      { app_id: 'acme/mac', app_name: 'mac', current_version: '1.0.0', latest_version: '2.0.0', changelog: '' },
    ]);
    const { result } = renderMyApps('home');
    await waitFor(() => expect(result.current.updates).toHaveLength(2));
    await waitFor(() => expect(result.current.installedApps).toHaveLength(2));

    await act(async () => {
      await result.current.handleUninstallApp('ACME/Win');
    });
    expect(result.current.installedApps.map((a) => a.app_id)).toEqual(['acme/mac']);
    expect(result.current.updates.map((u) => u.app_id)).toEqual(['acme/mac']);
    expect(result.current.updatableInstalledCount).toBe(1);
  });
});

describe('useMyAppsState：平台过滤视图', () => {
  it('已装列表与更新按全局平台勾选过滤', async () => {
    mocks.getCachedUpdates.mockResolvedValue([
      { app_id: 'acme/mac', app_name: 'mac', current_version: '1.0.0', latest_version: '2.0.0', changelog: '' },
    ]);
    const { result } = renderMyApps('home', ['windows']);
    await waitFor(() => expect(result.current.installedApps).toHaveLength(2));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));
    expect(result.current.filteredInstalledApps.map((a) => a.app_id)).toEqual(['acme/win']);
    expect(result.current.filteredUpdates).toEqual([]);
    expect(result.current.updatableInstalledCount).toBe(0);
    expect(mocks.hydrateCardsByIds).not.toHaveBeenCalled();
  });
});
