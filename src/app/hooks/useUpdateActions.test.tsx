/**
 * useUpdateActions 回归（更新规则动作簇）：
 *
 * - 单项更新：installed 列表替换 + updates 剔除 + success/失败 error toast；
 * - 忽略更新取目标行 latest_version（无目标行落 null）；跳过/锁定/隐藏/
 *   清除跳过/双 toggle 各自写后重读规则（网络刷新仅 clear/toggle 系）；
 * - 批量升级：逐条安装、失败者保留在 updates、部分失败 warning；
 * - 手动检查：force 写库后优先读 DB 快照（get_cached_updates）；
 *   空快照回退网络回包；空列表 all_latest；finally 复位进度与 isCheckingUpdates。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledApp, UpdateItem, UpdateRule } from '../../types';

const mocks = vi.hoisted(() => ({
  installApp: vi.fn(),
  setAppSkipVersion: vi.fn(async () => {}),
  setAppFrozen: vi.fn(async () => {}),
  setAppHidden: vi.fn(async () => {}),
  getUpdateRules: vi.fn(async (): Promise<UpdateRule[]> => []),
  checkForUpdates: vi.fn(),
  getCachedUpdates: vi.fn(),
  searchApps: vi.fn(),
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
        };
        if (prop in table) return table[prop as string];
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useUpdateActions } from './useUpdateActions';

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

function renderActions(updates: UpdateItem[] = [], searchQuery = '') {
  const deps = {
    updates,
    setUpdates: vi.fn(),
    setInstalledApps: vi.fn(),
    setUpdateRules: vi.fn(),
    setApps: vi.fn(),
    setIsCheckingUpdates: vi.fn(),
    setUpdateCheckProgress: vi.fn(),
    searchQuery,
    showToast: vi.fn(),
    t: ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`) as never,
  };
  const rendered = renderHook(() => useUpdateActions(deps));
  return { rendered, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUpdateRules.mockResolvedValue([]);
  mocks.searchApps.mockResolvedValue([]);
});

describe('useUpdateActions：单项动作', () => {
  it('单项更新成功：installed 替换 + updates 剔除 + success toast', async () => {
    const { rendered, deps } = renderActions([makeUpdate('acme/atlas'), makeUpdate('beta/bravo')]);
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas'));

    await act(async () => {
      await rendered.result.current.handleApplyUpdate('acme/atlas');
    });

    expect(mocks.installApp).toHaveBeenCalledWith('acme/atlas');
    expect(deps.setInstalledApps).toHaveBeenCalled();
    // setUpdates 经 updater 剔除：以原 updates 求 updater 得剔除结果。
    const updater = deps.setUpdates.mock.calls[0][0] as (prev: UpdateItem[]) => UpdateItem[];
    expect(updater([makeUpdate('acme/atlas'), makeUpdate('beta/bravo')])).toEqual([makeUpdate('beta/bravo')]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.update_success'), 'success');
  });

  it('单项更新失败：error toast，不剔除 updates', async () => {
    const { rendered, deps } = renderActions([makeUpdate('acme/atlas')]);
    mocks.installApp.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await rendered.result.current.handleApplyUpdate('acme/atlas');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.update_failed'), 'error');
    expect(deps.setUpdates).not.toHaveBeenCalled();
  });

  it('跳过指定版本：写后剔除该更新项并重读规则', async () => {
    const { rendered, deps } = renderActions([makeUpdate('acme/atlas')], 'query-x');
    await act(async () => {
      await rendered.result.current.handleSkipVersion('acme/atlas', '2.0.0');
    });
    expect(mocks.setAppSkipVersion).toHaveBeenCalledWith('acme/atlas', '2.0.0');
    expect(deps.setUpdates).toHaveBeenCalled();
    expect(mocks.getUpdateRules).toHaveBeenCalled();
  });

  it('清除跳过：重读规则 + checkForUpdates 网络刷新', async () => {
    const { rendered, deps } = renderActions([makeUpdate('acme/atlas')]);
    mocks.checkForUpdates.mockResolvedValue([makeUpdate('beta/bravo')]);
    await act(async () => {
      await rendered.result.current.handleClearRuleSkip('acme/atlas');
    });
    expect(mocks.setAppSkipVersion).toHaveBeenCalledWith('acme/atlas', null);
    expect(deps.setUpdates).toHaveBeenCalledWith([makeUpdate('beta/bravo')]);
  });

  it('toggle 冻结/隐藏：按入参写', async () => {
    const { rendered } = renderActions();
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

describe('useUpdateActions：批量升级', () => {
  it('混合成败：失败者保留，partial warning', async () => {
    const a = makeUpdate('acme/atlas');
    const b = makeUpdate('beta/bravo');
    const { rendered, deps } = renderActions([a, b]);
    mocks.installApp.mockResolvedValueOnce(makeInstalled('acme/atlas')).mockRejectedValueOnce(new Error('x'));

    await act(async () => {
      await rendered.result.current.handleBatchUpdateAll();
    });

    expect(mocks.installApp).toHaveBeenCalledTimes(2);
    const updater = deps.setUpdates.mock.calls.at(-1)?.[0] as (prev: UpdateItem[]) => UpdateItem[];
    expect(updater([a, b])).toEqual([b]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.batch_update_partial'), 'warning');
  });

  it('全部成功：success toast 且 updates 清空', async () => {
    const a = makeUpdate('acme/atlas');
    const { rendered, deps } = renderActions([a]);
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas'));
    await act(async () => {
      await rendered.result.current.handleBatchUpdateAll();
    });
    const updater = deps.setUpdates.mock.calls.at(-1)?.[0] as (prev: UpdateItem[]) => UpdateItem[];
    expect(updater([a])).toEqual([]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.batch_update_success'), 'success');
  });
});

describe('useUpdateActions：批量升级只升给定目标', () => {
  it('targets 之外的更新项既不安装也不剔除', async () => {
    const a = makeUpdate('acme/atlas');
    const b = makeUpdate('beta/bravo');
    const { rendered, deps } = renderActions([a, b]);
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas'));
    await act(async () => {
      await rendered.result.current.handleBatchUpdateAll([a]);
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(1);
    expect(mocks.installApp).toHaveBeenCalledWith('acme/atlas');
    const updater = deps.setUpdates.mock.calls.at(-1)?.[0] as (prev: UpdateItem[]) => UpdateItem[];
    expect(updater([a, b])).toEqual([b]);
  });
});

describe('useUpdateActions：手动检查更新', () => {
  it('force 检查后优先读 DB 快照；计数 toast 收口', async () => {
    const { rendered, deps } = renderActions();
    mocks.checkForUpdates.mockResolvedValue([makeUpdate('net/only')]);
    mocks.getCachedUpdates.mockResolvedValue([makeUpdate('db/snapshot')]);

    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });

    expect(mocks.checkForUpdates).toHaveBeenCalledWith(true);
    expect(mocks.getCachedUpdates).toHaveBeenCalled();
    expect(deps.setUpdates).toHaveBeenLastCalledWith([makeUpdate('db/snapshot')]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.updates_found'), 'info');
    expect(deps.setIsCheckingUpdates).toHaveBeenLastCalledWith(false);
    expect(deps.setUpdateCheckProgress).toHaveBeenLastCalledWith(null);
  });

  it('隐藏应用的更新留在快照里，但不计入提示数', async () => {
    const { rendered, deps } = renderActions();
    const visible = makeUpdate('acme/atlas');
    const hidden = makeUpdate('Yetone/Magpie');
    mocks.checkForUpdates.mockResolvedValue([visible, hidden]);
    mocks.getCachedUpdates.mockResolvedValue([visible, hidden]);
    mocks.getUpdateRules.mockResolvedValueOnce([
      { app_id: 'yetone/magpie', skipped_version: null, is_frozen: false, is_hidden: true, updated_at: 1 } as UpdateRule,
    ]);

    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });

    expect(deps.setUpdates).toHaveBeenLastCalledWith([visible, hidden]);
    expect(deps.showToast).toHaveBeenCalledWith('toast.updates_found {"count":1}', 'info');
  });

  it('空结果 all_latest；快照缺席回退网络回包', async () => {
    const { rendered, deps } = renderActions();
    mocks.checkForUpdates.mockResolvedValue([]);
    mocks.getCachedUpdates.mockResolvedValue([]);
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'success');
    expect(deps.setUpdates).toHaveBeenLastCalledWith([]);

    deps.showToast.mockClear();
    mocks.checkForUpdates.mockResolvedValue([makeUpdate('net/fallback')]);
    mocks.getCachedUpdates.mockRejectedValue(new Error('no db'));
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(deps.setUpdates).toHaveBeenLastCalledWith([makeUpdate('net/fallback')]);
  });

  it('检查失败：error toast，finally 复位进度', async () => {
    const { rendered, deps } = renderActions();
    mocks.checkForUpdates.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await rendered.result.current.handleCheckUpdates();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.check_failed'), 'error');
    expect(deps.setIsCheckingUpdates).toHaveBeenLastCalledWith(false);
    expect(deps.setUpdateCheckProgress).toHaveBeenLastCalledWith(null);
  });
});
