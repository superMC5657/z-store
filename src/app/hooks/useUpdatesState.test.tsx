/** 测试 `useUpdatesState` 的快照加载、流式更新、规则变更与批量更新。 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledApp, UpdateItem, UpdateRule, ViewType } from '../../types';

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
    updateItemFound: makeEmitter(),
    updateCheckProgress: makeEmitter(),
    updateCheckFinished: makeEmitter(),
  };
  const clearAll = (): void => {
    for (const e of Object.values(emitters)) e.clear();
  };
  return { ...emitters, clearAll };
});

const mocks = vi.hoisted(() => ({
  installApp: vi.fn(),
  setAppSkipVersion: vi.fn(async () => {}),
  setAppFrozen: vi.fn(async () => {}),
  setAppHidden: vi.fn(async () => {}),
  getUpdateRules: vi.fn(async (): Promise<UpdateRule[]> => []),
  checkForUpdates: vi.fn(async (): Promise<UpdateItem[]> => []),
  getCachedUpdates: vi.fn(async (): Promise<UpdateItem[]> => []),
  searchApps: vi.fn(async (_q: string): Promise<unknown[]> => []),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        const table: Record<string, unknown> = {
          installApp: mocks.installApp,
          setAppSkipVersion: mocks.setAppSkipVersion,
          setAppFrozen: mocks.setAppFrozen,
          setAppHidden: mocks.setAppHidden,
          getUpdateRules: mocks.getUpdateRules,
          checkForUpdates: mocks.checkForUpdates,
          getCachedUpdates: mocks.getCachedUpdates,
          searchApps: mocks.searchApps,
          onUpdateItemFound: subs.updateItemFound.on,
          onUpdateCheckProgress: subs.updateCheckProgress.on,
          onUpdateCheckFinished: subs.updateCheckFinished.on,
        };
        if (prop in table) return table[prop as string];
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useUpdatesState } from './useUpdatesState';

function makeUpdate(id: string, over: Partial<UpdateItem> = {}): UpdateItem {
  return {
    app_id: id,
    app_name: `${id} App`,
    current_version: '1.0.0',
    latest_version: '2.0.0',
    changelog: 'fixed stuff',
    ...over,
  };
}

function makeInstalled(id: string): InstalledApp {
  return {
    app_id: id,
    app_name: `${id} App`,
    version: '2.0.0',
    installed_at: 1700000000,
    install_method: 'installer',
    install_path: 'C:\\x',
    asset_name: 'a.exe',
    asset_sha256: 'ab'.repeat(32),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderUpdates(initialUpdates: UpdateItem[] = [], searchQuery = '', initialView: ViewType = 'home') {
  mocks.getCachedUpdates.mockResolvedValue(initialUpdates);
  const deps = {
    setApps: vi.fn(),
    setFullCatalogApps: vi.fn(),
    setInstalledApps: vi.fn(),
    showToast: vi.fn(),
    t: ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`) as never,
  };
  const rendered = renderHook(
    ({ q, view }: { q: string; view: ViewType }) =>
      useUpdatesState({
        catalogLists: { setApps: deps.setApps, setFullCatalogApps: deps.setFullCatalogApps },
        setInstalledApps: deps.setInstalledApps,
        searchQuery: q,
        currentView: view,
        showToast: deps.showToast,
        t: deps.t,
      }),
    { initialProps: { q: searchQuery, view: initialView } },
  );
  return { rendered, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  subs.clearAll();
  mocks.getUpdateRules.mockResolvedValue([]);
  mocks.getCachedUpdates.mockResolvedValue([]);
  mocks.checkForUpdates.mockResolvedValue([]);
  mocks.searchApps.mockResolvedValue([]);
});

describe('useUpdatesState：状态自有与流式事件', () => {
  it('初始加载快照与规则；切入 installed 视图重读 DB 快照', async () => {
    const initial = [makeUpdate('acme/atlas')];
    const rules = [{ app_id: 'acme/atlas', skipped_version: null, is_frozen: false, is_hidden: false, updated_at: 1 }];
    mocks.getUpdateRules.mockResolvedValueOnce(rules);
    const { rendered } = renderUpdates(initial, '', 'home');
    await flush();
    expect(rendered.result.current.updates).toEqual(initial);
    expect(rendered.result.current.updateRules).toEqual(rules);

    const nextSnap = [makeUpdate('beta/bravo')];
    mocks.getCachedUpdates.mockResolvedValueOnce(nextSnap);
    rendered.rerender({ q: '', view: 'installed' });
    await flush();
    expect(rendered.result.current.updates).toEqual(nextSnap);
  });

  it('更新流：逐条 upsert（大小写不敏感）+ 进度 + 完成复位', async () => {
    const { rendered } = renderUpdates([]);
    await flush();

    const item = makeUpdate('ACME/ATLAS');
    await act(async () => {
      subs.updateItemFound.emit({ ...item, app_id: 'acme/atlas' });
      subs.updateItemFound.emit(item);
    });
    expect(rendered.result.current.updates).toHaveLength(1);

    await act(async () => {
      subs.updateCheckProgress.emit({ checked: 3, total: 10, app_id: 'a', app_name: 'b' });
    });
    expect(rendered.result.current.updateCheckProgress).toEqual({
      checked: 3,
      total: 10,
      app_id: 'a',
      app_name: 'b',
    });

    await act(async () => {
      subs.updateCheckFinished.emit(null);
    });
    expect(rendered.result.current.isCheckingUpdates).toBe(false);
    expect(rendered.result.current.updateCheckProgress).toBeNull();
  });
});

describe('useUpdatesState：单项与规则动作', () => {
  it('单项更新成功：installed 替换 + updates 剔除 + success toast', async () => {
    const { rendered, deps } = renderUpdates([makeUpdate('acme/atlas'), makeUpdate('beta/bravo')]);
    await flush();
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas'));

    await act(async () => {
      await rendered.result.current.handleApplyUpdate('acme/atlas');
    });

    expect(mocks.installApp).toHaveBeenCalledWith('acme/atlas');
    expect(deps.setInstalledApps).toHaveBeenCalled();
    expect(rendered.result.current.updates).toEqual([makeUpdate('beta/bravo')]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.update_success'), 'success');
  });

  it('单项更新失败：error toast，不剔除 updates', async () => {
    const { rendered, deps } = renderUpdates([makeUpdate('acme/atlas')]);
    await flush();
    mocks.installApp.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await rendered.result.current.handleApplyUpdate('acme/atlas');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.update_failed'), 'error');
    expect(rendered.result.current.updates).toEqual([makeUpdate('acme/atlas')]);
  });

  it('跳过指定版本：写后剔除该更新项并重读规则', async () => {
    const { rendered } = renderUpdates([makeUpdate('acme/atlas')], 'query-x');
    await flush();
    await act(async () => {
      await rendered.result.current.handleSkipVersion('acme/atlas', '2.0.0');
    });
    expect(mocks.setAppSkipVersion).toHaveBeenCalledWith('acme/atlas', '2.0.0');
    expect(rendered.result.current.updates).toEqual([]);
    expect(mocks.getUpdateRules).toHaveBeenCalled();
  });

  it('清除跳过：重读规则 + checkForUpdates 网络刷新', async () => {
    const { rendered } = renderUpdates([makeUpdate('acme/atlas')]);
    await flush();
    mocks.checkForUpdates.mockResolvedValue([makeUpdate('beta/bravo')]);
    await act(async () => {
      await rendered.result.current.handleClearRuleSkip('acme/atlas');
    });
    expect(mocks.setAppSkipVersion).toHaveBeenCalledWith('acme/atlas', null);
    expect(rendered.result.current.updates).toEqual([makeUpdate('beta/bravo')]);
  });

  it('toggle 冻结/隐藏：按入参写', async () => {
    const { rendered } = renderUpdates();
    await flush();
    mocks.checkForUpdates.mockResolvedValue([]);
    await act(async () => {
      await rendered.result.current.handleToggleRuleFrozen('acme/atlas', true);
    });
    expect(mocks.setAppFrozen).toHaveBeenCalledWith('acme/atlas', true);
    await act(async () => {
      await rendered.result.current.handleToggleRuleHidden('acme/atlas', false);
    });
    expect(mocks.setAppHidden).toHaveBeenCalledWith('acme/atlas', false);
  });
});

describe('useUpdatesState：批量升级与手动检查', () => {
  it('混合成败：失败者保留，partial warning', async () => {
    const a = makeUpdate('acme/atlas');
    const b = makeUpdate('beta/bravo');
    const { rendered, deps } = renderUpdates([a, b]);
    await flush();
    mocks.installApp.mockResolvedValueOnce(makeInstalled('acme/atlas')).mockRejectedValueOnce(new Error('x'));

    await act(async () => {
      await rendered.result.current.handleBatchUpdateAll();
    });

    expect(mocks.installApp).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.updates).toEqual([b]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.batch_update_partial'), 'warning');
  });

  it('targets 之外的更新项既不安装也不剔除', async () => {
    const a = makeUpdate('acme/atlas');
    const b = makeUpdate('beta/bravo');
    const { rendered } = renderUpdates([a, b]);
    await flush();
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas'));
    await act(async () => {
      await rendered.result.current.handleBatchUpdateAll([a]);
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(1);
    expect(mocks.installApp).toHaveBeenCalledWith('acme/atlas');
    expect(rendered.result.current.updates).toEqual([b]);
  });

  it('force 检查后优先读 DB 快照；隐藏规则不计入提示数；支持 countVisibleUpdatable', async () => {
    const { rendered, deps } = renderUpdates();
    await flush();
    const visible = makeUpdate('acme/atlas');
    const hidden = makeUpdate('Yetone/Magpie');
    mocks.checkForUpdates.mockResolvedValue([makeUpdate('net/only')]);
    mocks.getCachedUpdates.mockResolvedValue([visible, hidden]);
    mocks.getUpdateRules.mockResolvedValueOnce([
      { app_id: 'yetone/magpie', skipped_version: null, is_frozen: false, is_hidden: true, updated_at: 1 } as UpdateRule,
    ]);

    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });

    expect(mocks.checkForUpdates).toHaveBeenCalledWith(true);
    expect(rendered.result.current.updates).toEqual([visible, hidden]);
    expect(deps.showToast).toHaveBeenCalledWith('toast.updates_found {"count":1}', 'info');
    expect(rendered.result.current.isCheckingUpdates).toBe(false);
    expect(rendered.result.current.updateCheckProgress).toBeNull();

    const customCounter = vi.fn(() => 2);
    mocks.getCachedUpdates.mockResolvedValue([visible]);
    await act(async () => {
      await rendered.result.current.handleCheckUpdates(customCounter);
    });
    expect(customCounter).toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith('toast.updates_found {"count":2}', 'info');
  });

  it('空结果 all_latest；快照缺席回退网络回包；检查失败 finally 复位进度', async () => {
    const { rendered, deps } = renderUpdates();
    await flush();
    mocks.checkForUpdates.mockResolvedValue([]);
    mocks.getCachedUpdates.mockResolvedValue([]);
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'success');

    mocks.checkForUpdates.mockResolvedValue([makeUpdate('net/fallback')]);
    mocks.getCachedUpdates.mockRejectedValue(new Error('no db'));
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(rendered.result.current.updates).toEqual([makeUpdate('net/fallback')]);

    mocks.checkForUpdates.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.check_failed'), 'error');
    expect(rendered.result.current.isCheckingUpdates).toBe(false);
    expect(rendered.result.current.updateCheckProgress).toBeNull();
  });
});

describe('useUpdatesState：大小写归一与隐藏目录同步', () => {
  it('单项更新 & 跳过版本大小写不敏感剔除', async () => {
    const { rendered, deps } = renderUpdates([makeUpdate('owner/repo'), makeUpdate('beta/bravo')]);
    await flush();
    mocks.installApp.mockResolvedValue(makeInstalled('Owner/Repo'));
    await act(async () => {
      await rendered.result.current.handleApplyUpdate('Owner/Repo');
    });
    const installedUpdater = deps.setInstalledApps.mock.calls[0][0] as (p: InstalledApp[]) => InstalledApp[];
    expect(installedUpdater([makeInstalled('owner/repo')]).map((a) => a.app_id)).toEqual(['Owner/Repo']);
    expect(rendered.result.current.updates).toEqual([makeUpdate('beta/bravo')]);
  });

  it('空/非空搜索词隐藏规则同步 fullCatalogApps 与 apps', async () => {
    const full = [{ id: 'acme/atlas' }, { id: 'videolan/vlc' }];
    const hits = [{ id: 'videolan/vlc' }];
    mocks.searchApps.mockImplementation(async (q: string) => (q === '' ? full : hits));

    const { rendered, deps } = renderUpdates([], '');
    await flush();
    await act(async () => {
      await rendered.result.current.handleToggleRuleHidden('acme/atlas', true);
    });
    expect(mocks.searchApps).toHaveBeenCalledWith('');
    expect(deps.setFullCatalogApps).toHaveBeenCalledWith(full);
    expect(deps.setApps).toHaveBeenCalledWith(full);

    rendered.rerender({ q: 'vlc', view: 'home' });
    await act(async () => {
      await rendered.result.current.handleToggleRuleHidden('acme/atlas', true);
    });
    expect(deps.setFullCatalogApps).toHaveBeenCalledWith(full);
    expect(deps.setApps).toHaveBeenCalledWith(hits);
  });

  it('规则变更 IPC 失败时捕获异常并弹 error toast', async () => {
    const { rendered, deps } = renderUpdates([makeUpdate('acme/atlas')]);
    await flush();
    mocks.setAppSkipVersion.mockRejectedValueOnce(new Error('skip fail'));
    mocks.setAppFrozen.mockRejectedValueOnce(new Error('freeze fail'));
    mocks.setAppHidden.mockRejectedValueOnce(new Error('hide fail'));

    await act(async () => {
      await expect(rendered.result.current.handleSkipVersion('acme/atlas', '2.0.0')).resolves.toBeUndefined();
      await expect(rendered.result.current.handleToggleRuleFrozen('acme/atlas', true)).resolves.toBeUndefined();
      await expect(rendered.result.current.handleToggleRuleHidden('acme/atlas', true)).resolves.toBeUndefined();
    });

    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('skip fail'), 'error');
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('freeze fail'), 'error');
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('hide fail'), 'error');
  });
});
