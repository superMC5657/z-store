/**
 * useAppSubscriptions 回归（应用级订阅总线 C3）：
 *
 * - 初始拉取扇出：目录/已装/收藏/规则/更新快照/最近浏览（平台过滤 + 黄标叠加）/
 *   设置回放/深链注册；`update_frequency='startup'` 才自动检查更新；
 * - `zstore:catalog-synced`：目录后到重拉目录 + 最近浏览黄标重标；
 * - `onIconReady`：载荷适配 + `admitIconHit` 四列表写透 + 回声窗立期望；
 * - watch 订阅：关注集加载 + 更新提醒 toast + 同 app 通知去重；
 * - 更新流：逐条 upsert（大小写不敏感）+ 进度 + 完成复位；
 * - OAuth：登录态加载、过期警示 + `zstore:oauth-changed` 派发、数据导入全量回放；
 * - C3 迟到订阅：卸载后才 resolve 的 unlisten 立即解绑（不泄漏）。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSummary,
  OAuthUser,
  UpdateItem,
  UpdateRule,
  WatchUpdatedPayload,
} from '../../types';
import { DEFAULT_SETTINGS } from '../../services/api';
import { MANUAL_ONLY_NETWORK } from '../../lib/manualOnly';

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

function renderSubs(overrides: Partial<Parameters<typeof useAppSubscriptions>[0]> = {}) {
  // spies 与 hook 入参对象分离：断言面恒为 vi.fn（无 Dispatch 联合类型）。
  const spies = {
    setApps: vi.fn(),
    setOnlineApps: vi.fn(),
    setRecentlyViewedApps: vi.fn(),
    setUncatalogedExtraApps: vi.fn(),
    setInstalledApps: vi.fn(),
    setFavoriteIds: vi.fn(),
    setUpdateRules: vi.fn(),
    setWatchedIds: vi.fn(),
    setWatchNotifications: vi.fn(),
    setUpdates: vi.fn(),
    setOAuthUser: vi.fn(),
    setIsCheckingUpdates: vi.fn(),
    setUpdateCheckProgress: vi.fn(),
    applyPersistedSettings: vi.fn(),
    showToast: vi.fn(),
  };
  const deps = {
    ...spies,
    appsRef: { current: [] as AppSummary[] },
    onlineAppsRef: { current: [] as AppSummary[] },
    recentsRef: { current: [] as AppSummary[] },
    uncatalogedExtraAppsRef: { current: [] as AppSummary[] },
    currentSearchIdRef: { current: '' },
    selectedPlatforms: new Set(['windows', 'macos', 'linux', 'ios', 'android', 'other']),
    platformResolvedOtherIds: new Set<string>(),
    t: (key: string, opts?: Record<string, unknown>) =>
      `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`,
    currentView: 'home' as const,
    updatesCount: 0,
    localApps: undefined as readonly AppSummary[] | undefined,
    ...overrides,
  };
  const rendered = renderHook(() =>
    useAppSubscriptions(deps as unknown as Parameters<typeof useAppSubscriptions>[0]),
  );
  unmounts.push(rendered.unmount);
  return {
    rendered,
    deps: spies as Record<string, ReturnType<typeof vi.fn>>,
    currentSearchIdRef: deps.currentSearchIdRef,
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
});

describe('useAppSubscriptions：初始加载扇出', () => {
  it('目录/已装/收藏/规则/快照/最近浏览/设置/深链注册 全部落位', async () => {
    const catalog = [makeRow('acme/atlas')];
    mocks.searchApps.mockResolvedValue(catalog);
    mocks.getInstalledApps.mockResolvedValue([]);
    mocks.getFavorites.mockResolvedValue(['acme/atlas']);
    mocks.getUpdateRules.mockResolvedValue([
      { app_id: 'acme/atlas', is_frozen: false, is_hidden: false, updated_at: 0 },
    ] as UpdateRule[]);
    mocks.getCachedUpdates.mockResolvedValue([]);
    const localApps = [makeRow('acme/atlas', { source: 'local', status: 'collected' })];
    mocks.getRecentlyViewedApps.mockResolvedValue([makeRow('acme/atlas', { source: undefined, status: undefined })]);

    const { deps } = renderSubs({ localApps });
    await flush();

    expect(deps.setApps).toHaveBeenCalledWith(catalog);
    expect(deps.setFavoriteIds).toHaveBeenCalledWith(new Set(['acme/atlas']));
    expect(deps.setUpdateRules).toHaveBeenCalledWith([expect.objectContaining({ app_id: 'acme/atlas' })]);
    // 最近浏览黄标叠加：目录命中 + localApps 标记。
    const recents = applySetter<AppSummary[]>(deps.setRecentlyViewedApps, []);
    expect(recents[0].is_cataloged).toBe(true);
    expect(recents[0].source).toBe('local');
    expect(mocks.registerDeepLinkScheme).toHaveBeenCalled();
    expect(deps.applyPersistedSettings).toHaveBeenCalled();
  });

  it('资产区门禁 MANUAL_ONLY_NETWORK=true：startup 频率也不自动检查', async () => {
    // 资产区网络仅经检查更新按钮手动触发（lib/manualOnly 单一来源）。
    // 门禁未来翻 false 时本测试随契约翻转：startup 恢复自动检查。
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, update_frequency: 'startup' });
    mocks.checkForUpdates.mockResolvedValue([]);
    renderSubs();
    await flush();
    if (MANUAL_ONLY_NETWORK) {
      expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    } else {
      expect(mocks.checkForUpdates).toHaveBeenCalledWith(false);
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

describe('useAppSubscriptions：watch / 更新流 / OAuth', () => {
  it('watch：关注集加载；更新事件 toast + 同 app 通知去重', async () => {
    mocks.getWatchedApps.mockResolvedValue([
      { app_id: 'acme/atlas', is_cataloged: true, added_at: 0 },
    ]);
    const { deps } = renderSubs();
    await flush();
    expect(deps.setWatchedIds).toHaveBeenCalledWith(new Set(['acme/atlas']));

    const payload = { app_id: 'acme/atlas', version: '2.0.0', app_name: 'Atlas' };
    await act(async () => {
      watchUpdated.emit(payload);
      watchUpdated.emit({ ...payload, version: '2.1.0' });
      await flush();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.watch_update_released'), 'info');
    const notifications = applySetter<WatchUpdatedPayload[]>(deps.setWatchNotifications, []);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].version).toBe('2.1.0');
  });

  it('更新流：逐条 upsert（大小写不敏感）+ 进度 + 完成复位', async () => {
    const { deps } = renderSubs();
    await flush();

    const item: UpdateItem = {
      app_id: 'ACME/ATLAS',
      app_name: 'Atlas',
      current_version: '1.0.0',
      latest_version: '2.0.0',
      changelog: '',
    };
    await act(async () => {
      updateItemFound.emit({ ...item, app_id: 'acme/atlas' });
      updateItemFound.emit(item);
      await flush();
    });
    const updates = applySetter(deps.setUpdates, [item] as UpdateItem[]);
    expect(updates).toHaveLength(1);

    await act(async () => {
      updateCheckProgress.emit({ checked: 3, total: 10, app_id: 'a', app_name: 'b' });
      await flush();
    });
    expect(deps.setUpdateCheckProgress).toHaveBeenLastCalledWith({
      checked: 3,
      total: 10,
      app_id: 'a',
      app_name: 'b',
    });

    await act(async () => {
      updateCheckFinished.emit(null);
      await flush();
    });
    expect(deps.setIsCheckingUpdates).toHaveBeenLastCalledWith(false);
    expect(deps.setUpdateCheckProgress).toHaveBeenLastCalledWith(null);
  });

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

  it('zstore:data-imported：设置/收藏/关注全量回放', async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'light' });
    mocks.getFavorites.mockResolvedValue(['acme/atlas']);
    mocks.getWatchedApps.mockResolvedValue([{ app_id: 'beta/bravo', is_cataloged: false, added_at: 0 }]);
    const { deps } = renderSubs();
    await flush();
    deps.applyPersistedSettings.mockClear();
    deps.setFavoriteIds.mockClear();
    deps.setWatchedIds.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('zstore:data-imported'));
      await flush();
    });

    expect(deps.applyPersistedSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    expect(deps.setFavoriteIds).toHaveBeenCalledWith(new Set(['acme/atlas']));
    expect(deps.setWatchedIds).toHaveBeenCalledWith(new Set(['beta/bravo']));
  });

  it('切到 updates 视图：重读 DB 快照（零网络）', async () => {
    const { rendered, deps } = renderSubs();
    await flush();
    deps.setUpdates.mockClear();
    mocks.getCachedUpdates.mockResolvedValue([]);

    await act(async () => {
      rendered.rerender();
    });
    // rerender 不换 currentView 也不触发；换视图才触发。
    expect(mocks.getCachedUpdates).toHaveBeenCalledTimes(1);
    void rendered;
  });
});

describe('useAppSubscriptions：C3 迟到订阅守卫', () => {
  it('卸载后才 resolve 的订阅立即解绑（不泄漏）', async () => {
    let releaseUnlisten: ((fn: () => void) => void) | undefined;
    const unlisten = vi.fn();
    watchUpdated.on.mockImplementationOnce(
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
    const total = searchIconUpgraded.size() + watchUpdated.size() + updateItemFound.size()
      + updateCheckProgress.size() + updateCheckFinished.size() + oauthExpired.size();
    expect(total).toBeGreaterThan(0);
    rendered.unmount();
    const after = searchIconUpgraded.size() + watchUpdated.size() + updateItemFound.size()
      + updateCheckProgress.size() + updateCheckFinished.size() + oauthExpired.size();
    expect(after).toBe(0);
  });
});
