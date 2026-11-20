/** 测试 `useAppSubscriptions` 的初始快照加载、事件订阅及卸载解绑。 */
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSummary,
  OAuthUser,
} from '../../types';
import { DEFAULT_SETTINGS } from '../../services/api';

// 订阅事件发射器：on 注册 / emit 触发 / size 观测解绑 / clear 跨测试复位。
const subs = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;
  function makeEmitter() {
    const listeners = new Set<Listener>();
    const on = vi.fn((cb: Listener): Promise<() => void> => {
      listeners.add(cb);
      return Promise.resolve(() => {
        listeners.delete(cb);
      });
    });
    return {
      on,
      emit: (payload: unknown): void => {
        for (const cb of [...listeners]) cb(payload);
      },
      size: (): number => listeners.size,
      clear: (): void => listeners.clear(),
    };
  }
  const emitters = {
    catalogSynced: makeEmitter(),
    searchIconUpgraded: makeEmitter(),
    watchUpdated: makeEmitter(),
    updateItemFound: makeEmitter(),
    updateCheckProgress: makeEmitter(),
    updateCheckFinished: makeEmitter(),
    oauthExpired: makeEmitter(),
  };
  const clearAll = (): void => {
    for (const e of Object.values(emitters)) e.clear();
  };
  return { ...emitters, clearAll };
});

const mocks = vi.hoisted(() => ({
  searchApps: vi.fn(),
  getInstalledApps: vi.fn(),
  getFavorites: vi.fn(),
  getUpdateRules: vi.fn(),
  getCachedUpdates: vi.fn(),
  getRecentlyViewedApps: vi.fn(),
  registerDeepLinkScheme: vi.fn(),
  getSettings: vi.fn(),
  checkForUpdates: vi.fn(),
  getWatchedApps: vi.fn(),
  getOAuthUser: vi.fn(),
  getFavoriteEntries: vi.fn(),
  syncCatalog: vi.fn(),
  consumeStartupCatalogSynced: vi.fn(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        const table: Record<string, unknown> = {
          searchApps: mocks.searchApps,
          getInstalledApps: mocks.getInstalledApps,
          getFavorites: mocks.getFavorites,
          getUpdateRules: mocks.getUpdateRules,
          getCachedUpdates: mocks.getCachedUpdates,
          getRecentlyViewedApps: mocks.getRecentlyViewedApps,
          registerDeepLinkScheme: mocks.registerDeepLinkScheme,
          getSettings: mocks.getSettings,
          checkForUpdates: mocks.checkForUpdates,
          getWatchedApps: mocks.getWatchedApps,
          getOAuthUser: mocks.getOAuthUser,
          syncCatalog: mocks.syncCatalog,
          consumeStartupCatalogSynced: mocks.consumeStartupCatalogSynced,
          onCatalogSynced: subs.catalogSynced.on,
          onIconReady: subs.searchIconUpgraded.on,
          onWatchUpdated: subs.watchUpdated.on,
          onUpdateItemFound: subs.updateItemFound.on,
          onUpdateCheckProgress: subs.updateCheckProgress.on,
          onUpdateCheckFinished: subs.updateCheckFinished.on,
          onOAuthExpired: subs.oauthExpired.on,
        };
        if (prop in table) return table[prop as string];
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useAppSubscriptions } from './useAppSubscriptions';

// emitters 须在 vi.mock 工厂可见（hoist 顺序），统一收进 vi.hoisted。
const catalogSynced = subs.catalogSynced;
const searchIconUpgraded = subs.searchIconUpgraded;
const watchUpdated = subs.watchUpdated;
const updateItemFound = subs.updateItemFound;
const updateCheckProgress = subs.updateCheckProgress;
const updateCheckFinished = subs.updateCheckFinished;
const oauthExpired = subs.oauthExpired;

function makeRow(id: string, over: Partial<AppSummary> = {}): AppSummary {
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

const unmounts: Array<() => void> = [];

import { patchAppIconList } from '../../services/iconStore';

function renderSubs(
  overrides: {
    appsRef?: { current: AppSummary[] };
    fullCatalogAppsRef?: { current: AppSummary[] };
    localApps?: readonly AppSummary[];
    currentView?: 'home' | 'installed';
  } = {},
  options: { strict?: boolean } = {},
) {
  const spies = {
    setApps: vi.fn(),
    setFullCatalogApps: vi.fn(),
    setOnlineApps: vi.fn(),
    setRecentlyViewedApps: vi.fn(),
    setUncatalogedExtraApps: vi.fn(),
    setInstalledApps: vi.fn(),
    setFavoriteIds: vi.fn(),
    setOAuthUser: vi.fn(),
    applyPersistedSettings: vi.fn(),
    showToast: vi.fn(),
  };
  const appsRef = overrides.appsRef ?? { current: [] as AppSummary[] };
  const fullCatalogAppsRef = overrides.fullCatalogAppsRef ?? { current: [] as AppSummary[] };
  const onlineAppsRef = { current: [] as AppSummary[] };
  const recentsRef = { current: [] as AppSummary[] };
  const uncatalogedExtraAppsRef = { current: [] as AppSummary[] };
  const currentSearchIdRef = { current: '' };
  const patchIcons = (tid: string, icon: string) => {
    const updater = (prev: AppSummary[]) => patchAppIconList(prev, tid, icon);
    spies.setApps(updater);
    spies.setFullCatalogApps(updater);
    spies.setOnlineApps(updater);
    spies.setRecentlyViewedApps(updater);
    spies.setUncatalogedExtraApps(updater);
  };
  const findById = (idLower: string) => {
    const lk = idLower.trim().toLowerCase();
    return (
      appsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      onlineAppsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      recentsRef.current.find((a) => a.id.toLowerCase() === lk) ??
      uncatalogedExtraAppsRef.current.find((a) => a.id.toLowerCase() === lk)
    );
  };
  const deps = {
    catalogLists: {
      appsRef,
      fullCatalogAppsRef,
      setApps: spies.setApps,
      setFullCatalogApps: spies.setFullCatalogApps,
      setRecentlyViewedApps: spies.setRecentlyViewedApps,
      patchIcons,
      findById,
    },
    searchContext: { currentSearchIdRef },
    currentView: overrides.currentView ?? ('home' as const),
    localApps: overrides.localApps,
    library: {
      setInstalledApps: spies.setInstalledApps,
      setFavoriteIds: spies.setFavoriteIds,
      setOAuthUser: spies.setOAuthUser,
      applyPersistedSettings: spies.applyPersistedSettings,
    },
    notify: {
      showToast: spies.showToast,
      t: ((key: string, opts?: Record<string, unknown>) =>
        `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`) as never,
    },
  };
  const rendered = renderHook(
    () => useAppSubscriptions(deps as Parameters<typeof useAppSubscriptions>[0]),
    options.strict ? { wrapper: StrictMode } : undefined,
  );
  unmounts.push(rendered.unmount);
  return {
    rendered,
    deps: spies as Record<string, ReturnType<typeof vi.fn>>,
    currentSearchIdRef,
  };
}

function applySetter<T>(setter: { mock: { calls: unknown[][] } }, prev: T): T {
  const arg = setter.mock.calls[setter.mock.calls.length - 1][0];
  return typeof arg === 'function' ? (arg as (p: T) => T)(prev) : (arg as T);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  while (unmounts.length) {
    try {
      unmounts.pop()!();
    } catch {
      // 已卸载实例重复 unmount 忽略
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  subs.clearAll();
  catalogSynced.on.mockClear();
  searchIconUpgraded.on.mockClear();
  watchUpdated.on.mockClear();
  updateItemFound.on.mockClear();
  updateCheckProgress.on.mockClear();
  updateCheckFinished.on.mockClear();
  oauthExpired.on.mockClear();

  mocks.searchApps.mockResolvedValue([]);
  mocks.getInstalledApps.mockResolvedValue([]);
  mocks.getFavorites.mockResolvedValue([]);
  mocks.getUpdateRules.mockResolvedValue([]);
  mocks.getCachedUpdates.mockResolvedValue([]);
  mocks.getRecentlyViewedApps.mockResolvedValue([]);
  mocks.getWatchedApps.mockResolvedValue([]);
  mocks.getFavoriteEntries.mockResolvedValue([]);
  mocks.registerDeepLinkScheme.mockResolvedValue(undefined);
  mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, update_frequency: 'manual' });
  mocks.getOAuthUser.mockResolvedValue(null);
  mocks.checkForUpdates.mockResolvedValue([]);
  mocks.syncCatalog.mockResolvedValue({ updated: false, count: 0, message: '' });
  mocks.consumeStartupCatalogSynced.mockResolvedValue(false);
});

describe('useAppSubscriptions：初始加载扇出', () => {
  it('目录/已装/收藏/最近浏览/设置 全部落位，且不从前端重复调 syncCatalog/registerDeepLinkScheme', async () => {
    const catalog = [makeRow('acme/atlas')];
    mocks.searchApps.mockResolvedValue(catalog);
    mocks.getInstalledApps.mockResolvedValue([]);
    mocks.getFavorites.mockResolvedValue(['acme/atlas']);
    const localApps = [makeRow('acme/atlas', { source: 'local', status: 'collected' })];
    mocks.getRecentlyViewedApps.mockResolvedValue([makeRow('acme/atlas', { source: undefined, status: undefined })]);

    const { deps } = renderSubs({ localApps });
    await flush();

    expect(deps.setApps).toHaveBeenCalledWith(catalog);
    expect(deps.setFavoriteIds).toHaveBeenCalledWith(new Set(['acme/atlas']));
    // 最近浏览黄标叠加：目录命中 + localApps 标记。
    const recents = applySetter<AppSummary[]>(deps.setRecentlyViewedApps, []);
    expect(recents[0].is_cataloged).toBe(true);
    expect(recents[0].source).toBe('local');
    expect(mocks.registerDeepLinkScheme).not.toHaveBeenCalled();
    expect(mocks.syncCatalog).not.toHaveBeenCalled();
    expect(deps.applyPersistedSettings).toHaveBeenCalled();
  });

  it('资产区门禁：startup 频率也不自动检查', async () => {
    // 资产区网络仅经检查更新按钮手动触发。
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, update_frequency: 'startup' });
    mocks.checkForUpdates.mockResolvedValue([]);
    renderSubs();
    await flush();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it('订阅后端 zstore://catalog-synced：StrictMode 双挂载只保留 1 个有效监听且收到事件后刷新目录', async () => {
    const seededRows = [makeRow('acme/seed')];
    const remoteRows = [makeRow('acme/remote-new')];
    mocks.searchApps
      .mockResolvedValueOnce(seededRows)
      .mockResolvedValueOnce(seededRows)
      .mockResolvedValue(remoteRows);

    const syncedEvents: string[] = [];
    const onSynced = () => syncedEvents.push('catalog');
    const onCustom = () => syncedEvents.push('custom');
    window.addEventListener('zstore:catalog-synced', onSynced);
    window.addEventListener('zstore:custom-apps-changed', onCustom);
    try {
      const { deps } = renderSubs({}, { strict: true });
      await flush();

      expect(mocks.syncCatalog).not.toHaveBeenCalled();
      expect(catalogSynced.size()).toBe(1);
      expect(deps.setApps).toHaveBeenLastCalledWith(seededRows);

      await act(async () => {
        catalogSynced.emit(undefined);
        await flush();
      });

      expect(syncedEvents).toEqual(['catalog', 'custom']);
      expect(deps.setApps).toHaveBeenLastCalledWith(remoteRows);
      expect(deps.showToast).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('zstore:catalog-synced', onSynced);
      window.removeEventListener('zstore:custom-apps-changed', onCustom);
    }
  });

  it('监听就绪前后端已落库广播：StrictMode 只由活动挂载消费一次标记并补齐刷新，不与实时事件双刷', async () => {
    const seededRows = [makeRow('acme/seed')];
    const remoteRows = [makeRow('acme/remote-new')];
    mocks.searchApps
      .mockResolvedValueOnce(seededRows)
      .mockResolvedValueOnce(seededRows)
      .mockResolvedValue(remoteRows);
    mocks.consumeStartupCatalogSynced.mockResolvedValueOnce(true);

    const syncedEvents: string[] = [];
    const onSynced = () => syncedEvents.push('catalog');
    const onCustom = () => syncedEvents.push('custom');
    window.addEventListener('zstore:catalog-synced', onSynced);
    window.addEventListener('zstore:custom-apps-changed', onCustom);
    try {
      const { deps } = renderSubs({}, { strict: true });
      await flush();

      // StrictMode 卸载的首个挂载不消费标记，仅活动挂载消费一次。
      expect(mocks.consumeStartupCatalogSynced).toHaveBeenCalledTimes(1);
      expect(syncedEvents).toEqual(['catalog', 'custom']);
      expect(deps.setApps).toHaveBeenLastCalledWith(remoteRows);
    } finally {
      window.removeEventListener('zstore:catalog-synced', onSynced);
      window.removeEventListener('zstore:custom-apps-changed', onCustom);
    }
  });

  it('实时事件先于 consumeStartupCatalogSynced 返回时只刷新一次（不双刷）', async () => {
    const seededRows = [makeRow('acme/seed')];
    const remoteRows = [makeRow('acme/remote-new')];
    mocks.searchApps.mockResolvedValueOnce(seededRows).mockResolvedValue(remoteRows);
    let resolveConsume!: (v: boolean) => void;
    mocks.consumeStartupCatalogSynced.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConsume = resolve;
        }),
    );

    const syncedEvents: string[] = [];
    const onSynced = () => syncedEvents.push('catalog');
    const onCustom = () => syncedEvents.push('custom');
    window.addEventListener('zstore:catalog-synced', onSynced);
    window.addEventListener('zstore:custom-apps-changed', onCustom);
    try {
      renderSubs();
      await flush();

      await act(async () => {
        catalogSynced.emit(undefined);
        resolveConsume(true);
        await flush();
      });

      expect(syncedEvents).toEqual(['catalog', 'custom']);
    } finally {
      window.removeEventListener('zstore:catalog-synced', onSynced);
      window.removeEventListener('zstore:custom-apps-changed', onCustom);
    }
  });
});

describe('useAppSubscriptions：目录同步与图标升级', () => {
  it('zstore:catalog-synced：重拉目录 + localApps 黄标重标最近浏览', async () => {
    const localApps = [makeRow('acme/atlas', { source: 'local', status: 'collected' })];
    mocks.getRecentlyViewedApps.mockResolvedValue([makeRow('acme/atlas')]);
    const { deps } = renderSubs({ localApps });
    await flush();
    deps.setRecentlyViewedApps.mockClear();

    mocks.searchApps.mockResolvedValue([makeRow('acme/atlas')]);
    await act(async () => {
      window.dispatchEvent(new Event('zstore:catalog-synced'));
      await flush();
    });

    expect(deps.setApps).toHaveBeenCalledWith([expect.objectContaining({ id: 'acme/atlas' })]);
    const restamped = applySetter<AppSummary[]>(deps.setRecentlyViewedApps, [makeRow('acme/atlas')]);
    expect(restamped[0].is_cataloged).toBe(true);
    expect(restamped[0].source).toBe('local');
  });

  it('zstore:catalog-synced：localApps 因转正归档清空([])时也应校准最近浏览为 remote 蓝标', async () => {
    const emptyLocal: AppSummary[] = [];
    mocks.getRecentlyViewedApps.mockResolvedValue([
      makeRow('acme/graduated', { source: 'local', status: 'collected', is_cataloged: true }),
    ]);
    const { deps } = renderSubs({ localApps: emptyLocal });
    await flush();
    deps.setRecentlyViewedApps.mockClear();

    mocks.searchApps.mockResolvedValue([makeRow('acme/graduated')]);
    await act(async () => {
      window.dispatchEvent(new Event('zstore:catalog-synced'));
      await flush();
    });

    const restamped = applySetter<AppSummary[]>(deps.setRecentlyViewedApps, [
      makeRow('acme/graduated', { source: 'local', status: 'collected', is_cataloged: true }),
    ]);
    expect(restamped[0].is_cataloged).toBe(true);
    expect(restamped[0].source).toBe('remote');
    expect(restamped[0].status).toBeUndefined();
  });

  it('初始 searchApps 晚于 zstore:catalog-synced 返回时不得覆盖同步后新目录', async () => {
    let resolveInitial!: (rows: AppSummary[]) => void;
    const initialPromise = new Promise<AppSummary[]>((r) => {
      resolveInitial = r;
    });
    const staleRows = [makeRow('acme/old')];
    const freshRows = [makeRow('acme/fresh')];
    mocks.searchApps.mockReturnValueOnce(initialPromise).mockResolvedValueOnce(freshRows);

    const { deps } = renderSubs();
    await act(async () => {
      window.dispatchEvent(new Event('zstore:catalog-synced'));
      await flush();
    });
    expect(deps.setApps).toHaveBeenLastCalledWith(freshRows);

    deps.setApps.mockClear();
    await act(async () => {
      resolveInitial(staleRows);
      await flush();
    });
    expect(deps.setApps).not.toHaveBeenCalled();
  });

  it('onIconReady：回声窗立期望 + 图标四列表写透', async () => {
    const rows = [makeRow('acme/atlas', { icon: '' })];
    const { deps, currentSearchIdRef } = renderSubs({ appsRef: { current: rows } });
    await flush();
    expect(searchIconUpgraded.on).toHaveBeenCalled();

    const searchIdRef = currentSearchIdRef;
    searchIdRef.current = '';
    await act(async () => {
      searchIconUpgraded.emit({
        id: 'acme/atlas',
        icon: 'https://cdn.example.com/i.png',
        level: 2,
        via: 'cycle',
        context: { kind: 'search', search_id: 'sid-77' },
      });
      await flush();
    });

    // 回声窗：窗内（期望空）首个搜索回声立期望。
    expect(searchIdRef.current).toBe('sid-77');
    // 图标写透四列表（真实 admitIconHit → patchAppIconList）。
    const arg = deps.setApps.mock.calls.at(-1)![0] as (prev: AppSummary[]) => AppSummary[];
    expect(arg(rows)[0].icon).toBe('https://cdn.example.com/i.png');
  });
});

describe('useAppSubscriptions：OAuth / 导入刷新', () => {
  it('OAuth：过期 → warning toast + oauth-changed 派发 + 登录态重载', async () => {
    const user: OAuthUser = { login: 'acme', has_list_scope: true, is_expired: false };
    mocks.getOAuthUser.mockResolvedValue(user);
    const { deps } = renderSubs();
    await flush();
    expect(deps.setOAuthUser).toHaveBeenCalledWith(user);

    const oauthEvents: Event[] = [];
    const onEvt = (e: Event): void => {
      oauthEvents.push(e);
    };
    window.addEventListener('zstore:oauth-changed', onEvt);

    try {
      await act(async () => {
        oauthExpired.emit(null);
        await flush();
      });
      expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'warning');
      expect(oauthEvents.length).toBeGreaterThanOrEqual(1);
      // 单实例语义：初始加载 1 次 + 过期事件直调重载 1 次 + oauth-changed 派发回放 1 次。
      expect(mocks.getOAuthUser).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('zstore:oauth-changed', onEvt);
    }
  });

  it('zstore:data-imported：设置/收藏全量回放', async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'light' });
    mocks.getFavorites.mockResolvedValue(['acme/atlas']);
    const { deps } = renderSubs();
    await flush();
    deps.applyPersistedSettings.mockClear();
    deps.setFavoriteIds.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('zstore:data-imported'));
      await flush();
    });

    expect(deps.applyPersistedSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    expect(deps.setFavoriteIds).toHaveBeenCalledWith(new Set(['acme/atlas']));
  });
});

describe('useAppSubscriptions：迟到订阅守卫', () => {
  it('卸载后才 resolve 的订阅立即解绑（不泄漏）', async () => {
    let releaseUnlisten: ((fn: () => void) => void) | undefined;
    const unlisten = vi.fn();
    oauthExpired.on.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          releaseUnlisten = resolve;
        }),
    );

    const { rendered } = renderSubs();
    rendered.unmount();
    // 订阅 promise 在卸载后才落地：unlisten 应被立即调用。
    await act(async () => {
      releaseUnlisten?.(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('正常卸载：已注册的 unlisten 全部执行', async () => {
    const { rendered } = renderSubs();
    await flush();
    const total = searchIconUpgraded.size() + catalogSynced.size() + oauthExpired.size();
    expect(total).toBeGreaterThan(0);
    rendered.unmount();
    const after = searchIconUpgraded.size() + catalogSynced.size() + oauthExpired.size();
    expect(after).toBe(0);
  });
});
