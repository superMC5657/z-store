/** 测试 `useInstallState` 的安装/卸载、无校验资产确认门禁与加载错误状态。 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledApp } from '../../types';
import { UNVERIFIED_ASSET_MARKER } from '../../services/api';

const mocks = vi.hoisted(() => ({
  installApp: vi.fn(),
  launchApp: vi.fn(async () => {}),
  uninstallApp: vi.fn(async () => {}),
  unmanageApp: vi.fn(async () => {}),
  getInstalledApps: vi.fn(async (): Promise<InstalledApp[]> => []),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'installApp') return mocks.installApp;
        if (prop === 'launchApp') return mocks.launchApp;
        if (prop === 'uninstallApp') return mocks.uninstallApp;
        if (prop === 'unmanageApp') return mocks.unmanageApp;
        if (prop === 'getInstalledApps') return mocks.getInstalledApps;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useInstallState } from './useInstallState';

function makeInstalled(id: string, over: Partial<InstalledApp> = {}): InstalledApp {
  return {
    app_id: id,
    app_name: `${id} App`,
    version: '1.0.0',
    installed_at: 1700000000,
    install_method: 'installer',
    install_path: 'C:\\test',
    asset_name: 'setup.exe',
    asset_sha256: 'ab'.repeat(32),
    ...over,
  };
}

function renderInstall(currentView = 'home') {
  // spies 与 hook 入参对象分离：断言面恒为 vi.fn（无联合类型）。
  const spies = {
    showToast: vi.fn(),
    onAppRemoved: vi.fn(),
  };
  const rendered = renderHook(
    (props: { currentView: string }) =>
      useInstallState({
        currentView: props.currentView,
        apps: [],
        showToast: spies.showToast,
        onAppRemoved: spies.onAppRemoved,
        t: ((key: string, opts?: Record<string, unknown>) =>
          `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`) as never,
      } as Parameters<typeof useInstallState>[0]),
    { initialProps: { currentView } },
  );
  return { rendered, deps: spies };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInstalledApps.mockResolvedValue([]);
});

describe('useInstallState：安装流', () => {
  it('成功：列表大小写不敏感去重替换 + success toast', async () => {
    const { rendered, deps } = renderInstall();
    rendered.result.current.setInstalledApps([makeInstalled('ACME/Atlas', { app_name: 'Old Atlas' })]);
    mocks.installApp.mockResolvedValue(makeInstalled('acme/atlas', { app_name: 'Atlas' }));

    await act(async () => {
      await rendered.result.current.handleInstallApp('acme/atlas');
    });

    expect(rendered.result.current.installedApps).toHaveLength(1);
    expect(rendered.result.current.installedApps[0].app_name).toBe('Atlas');
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.install_success'), 'success');
    expect(rendered.result.current.installingAppIds.size).toBe(0);
  });

  it('在途去重：同 id 第二次调用直接忽略', async () => {
    const { rendered } = renderInstall();
    let release: ((v: InstalledApp) => void) | undefined;
    mocks.installApp.mockImplementation(
      () => new Promise<InstalledApp>((resolve) => { release = resolve; }),
    );

    let first!: Promise<void>;
    act(() => {
      first = rendered.result.current.handleInstallApp('acme/atlas');
    });
    await act(async () => {
      await rendered.result.current.handleInstallApp('acme/atlas');
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.(makeInstalled('acme/atlas'));
      await first;
    });
  });

  it(`D3 门禁：${UNVERIFIED_ASSET_MARKER} 前缀 → 挂起待确认，非失败态`, async () => {
    const { rendered, deps } = renderInstall();
    mocks.installApp.mockRejectedValue(`${UNVERIFIED_ASSET_MARKER}acme/atlas`);

    await act(async () => {
      await expect(
        rendered.result.current.handleInstallApp('acme/atlas', 'setup.exe', 'C:\\dir'),
      ).resolves.toBeUndefined();
    });

    expect(deps.showToast).not.toHaveBeenCalled();
    expect(rendered.result.current.unverifiedInstallPrompt).toEqual({
      id: 'acme/atlas',
      assetName: 'setup.exe',
      customInstallDir: 'C:\\dir',
    });
    expect(rendered.result.current.installingAppIds.size).toBe(0);

    act(() => {
      rendered.result.current.dismissUnverifiedInstall();
    });
    expect(rendered.result.current.unverifiedInstallPrompt).toBeNull();
  });

  it('用户取消（取消/中止/1602）：info 提示；其余失败 error 提示并 rethrow', async () => {
    const { rendered, deps } = renderInstall();
    mocks.installApp.mockRejectedValueOnce('用户取消');
    await act(async () => {
      await expect(rendered.result.current.handleInstallApp('acme/atlas')).rejects.toBe('用户取消');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.install_cancelled'), 'info');

    deps.showToast.mockClear();
    mocks.installApp.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await expect(rendered.result.current.handleInstallApp('acme/atlas')).rejects.toBeInstanceOf(Error);
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.install_failed'), 'error');
  });
});

describe('useInstallState：卸载 / 启动 / 管理 / 刷新', () => {
  it('卸载成功：列表精准移除 + success；取消关键词 → info', async () => {
    const { rendered, deps } = renderInstall();
    rendered.result.current.setInstalledApps([makeInstalled('acme/atlas'), makeInstalled('beta/bravo')]);
    mocks.uninstallApp.mockResolvedValueOnce(undefined);

    await act(async () => {
      await rendered.result.current.handleUninstallApp('ACME/ATLAS');
    });
    expect(
      rendered.result.current.installedApps.map((a) => a.app_id),
    ).toEqual(['beta/bravo']);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.uninstall_success'), 'success');

    deps.showToast.mockClear();
    mocks.uninstallApp.mockRejectedValueOnce('操作被中止');
    await act(async () => {
      await rendered.result.current.handleUninstallApp('beta/bravo');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('启动成功/失败 toast 各归其位', async () => {
    const { rendered, deps } = renderInstall();
    rendered.result.current.setInstalledApps([makeInstalled('acme/atlas')]);
    mocks.launchApp.mockResolvedValueOnce(undefined);
    await act(async () => {
      await rendered.result.current.handleLaunchApp('acme/atlas');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.launch_success'), 'success');

    deps.showToast.mockClear();
    mocks.launchApp.mockRejectedValueOnce(new Error('missing exe'));
    await act(async () => {
      await rendered.result.current.handleLaunchApp('acme/atlas');
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.launch_failed'), 'error');
  });

  it('取消管理：移出列表 + info，本地文件不动', async () => {
    const { rendered, deps } = renderInstall();
    rendered.result.current.setInstalledApps([makeInstalled('acme/atlas')]);
    mocks.unmanageApp.mockResolvedValueOnce(undefined);
    await act(async () => {
      await rendered.result.current.handleUnmanageApp('acme/atlas');
    });
    expect(mocks.unmanageApp).toHaveBeenCalledWith('acme/atlas');
    expect(rendered.result.current.installedApps).toEqual([]);
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.unmanage_success'), 'info');
  });
});

describe('useInstallState：已装列表加载（installed 视图驱动）', () => {
  it('进入 installed 视图自动加载；失败落 installLoadError；重试成功清除', async () => {
    mocks.getInstalledApps.mockRejectedValueOnce(new Error('load boom'));
    const { rendered } = renderInstall('installed');
    await waitFor(() => {
      expect(rendered.result.current.installLoadError).toContain('load boom');
    });

    mocks.getInstalledApps.mockResolvedValueOnce([makeInstalled('acme/atlas')]);
    await act(async () => {
      await rendered.result.current.loadInstalledApps();
    });
    expect(rendered.result.current.installLoadError).toBeNull();
    expect(rendered.result.current.installedApps).toHaveLength(1);
  });

  it('非 installed 视图不触发加载', () => {
    renderInstall('home');
    expect(mocks.getInstalledApps).not.toHaveBeenCalled();
  });
});

describe('useInstallState：移除后清理与大小写归一', () => {
  it('取消管理：大小写不同的已装行被移除，并通知 onAppRemoved 清理更新项', async () => {
    const { rendered, deps } = renderInstall();
    act(() => {
      rendered.result.current.setInstalledApps([makeInstalled('owner/repo'), makeInstalled('beta/bravo')]);
    });
    await act(async () => {
      await rendered.result.current.handleUnmanageApp('Owner/Repo');
    });
    expect(rendered.result.current.installedApps.map((a) => a.app_id)).toEqual(['beta/bravo']);
    expect(deps.showToast).toHaveBeenCalledWith(
      expect.stringContaining('owner/repo App'),
      'info',
    );
    expect(deps.onAppRemoved).toHaveBeenCalledWith('Owner/Repo');
  });

  it('卸载成功通知 onAppRemoved；取消/失败不通知', async () => {
    const { rendered, deps } = renderInstall();
    act(() => {
      rendered.result.current.setInstalledApps([makeInstalled('acme/atlas')]);
    });
    mocks.uninstallApp.mockRejectedValueOnce('用户取消');
    await act(async () => {
      await rendered.result.current.handleUninstallApp('acme/atlas');
    });
    expect(deps.onAppRemoved).not.toHaveBeenCalled();

    mocks.uninstallApp.mockResolvedValueOnce(undefined);
    await act(async () => {
      await rendered.result.current.handleUninstallApp('acme/atlas');
    });
    expect(deps.onAppRemoved).toHaveBeenCalledWith('acme/atlas');
  });

  it('启动：大小写不同仍取到已装行名称', async () => {
    const { rendered, deps } = renderInstall();
    act(() => {
      rendered.result.current.setInstalledApps([makeInstalled('owner/repo')]);
    });
    await act(async () => {
      await rendered.result.current.handleLaunchApp('Owner/Repo');
    });
    expect(deps.showToast).toHaveBeenCalledWith(
      expect.stringContaining('owner/repo App'),
      'success',
    );
  });
});

describe('useInstallState：批量安装无校验确认门禁', () => {
  it('命中无校验清单时暂停等待确认，确认后携带 allowUnverified=true 重试并完成', async () => {
    const { rendered } = renderInstall();
    mocks.installApp
      .mockRejectedValueOnce(`${UNVERIFIED_ASSET_MARKER}acme/unverified`)
      .mockResolvedValueOnce(makeInstalled('acme/unverified', { app_name: 'Unverified' }));

    let settled = false;
    let outcomePromise!: Promise<string>;
    act(() => {
      outcomePromise = rendered.result.current.handleBatchInstallApp('acme/unverified').then((res) => {
        settled = true;
        return res;
      });
    });

    await waitFor(() => {
      expect(rendered.result.current.unverifiedInstallPrompt).toEqual({ id: 'acme/unverified' });
    });
    expect(settled).toBe(false);

    await act(async () => {
      rendered.result.current.confirmUnverifiedInstall();
      await outcomePromise;
    });

    await expect(outcomePromise).resolves.toBe('installed');
    expect(mocks.installApp).toHaveBeenCalledTimes(2);
    expect(mocks.installApp).toHaveBeenNthCalledWith(2, 'acme/unverified', undefined, undefined, true);
    expect(rendered.result.current.unverifiedInstallPrompt).toBeNull();
  });

  it('取消无校验弹窗返回 cancelled 且不覆盖队列中下一款应用的确认弹窗', async () => {
    const { rendered } = renderInstall();
    mocks.installApp
      .mockRejectedValueOnce(`${UNVERIFIED_ASSET_MARKER}acme/first`)
      .mockRejectedValueOnce(`${UNVERIFIED_ASSET_MARKER}acme/second`)
      .mockResolvedValueOnce(makeInstalled('acme/second', { app_name: 'Second' }));

    const results: string[] = [];
    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = (async () => {
        results.push(await rendered.result.current.handleBatchInstallApp('acme/first'));
        results.push(await rendered.result.current.handleBatchInstallApp('acme/second'));
      })();
    });

    // 第一款弹窗打开期间，第二款尚未触发（不覆盖单槽位状态）
    await waitFor(() => {
      expect(rendered.result.current.unverifiedInstallPrompt).toEqual({ id: 'acme/first' });
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      rendered.result.current.dismissUnverifiedInstall();
    });

    // 取消第一款后推进到第二款，弹出第二款的确认窗
    await waitFor(() => {
      expect(rendered.result.current.unverifiedInstallPrompt).toEqual({ id: 'acme/second' });
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(2);

    await act(async () => {
      rendered.result.current.confirmUnverifiedInstall();
      await firstPromise;
    });

    expect(results).toEqual(['cancelled', 'installed']);
  });
});

describe('useInstallState：大小写归一锁与取消管理错误捕获', () => {
  it('混合大小写安装/卸载共用归一化键，阻断并发重复安装', async () => {
    const { rendered } = renderInstall();
    let release!: (v: InstalledApp) => void;
    mocks.installApp.mockImplementationOnce(
      () => new Promise<InstalledApp>((resolve) => { release = resolve; }),
    );

    let first!: Promise<void>;
    act(() => {
      first = rendered.result.current.handleInstallApp('RustDesk/RustDesk');
    });

    expect(rendered.result.current.installingAppIds.has('rustdesk/rustdesk')).toBe(true);
    await act(async () => {
      // 小写变体并发调用应被全局锁去重拦截
      await rendered.result.current.handleInstallApp('rustdesk/rustdesk');
    });
    expect(mocks.installApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(makeInstalled('rustdesk/rustdesk'));
      await first;
    });
    expect(rendered.result.current.installingAppIds.size).toBe(0);
  });

  it('unmanageApp IPC 失败时弹出错误 toast，不抛未捕获异常且保留已装项', async () => {
    const { rendered, deps } = renderInstall();
    act(() => {
      rendered.result.current.setInstalledApps([makeInstalled('acme/atlas')]);
    });
    mocks.unmanageApp.mockRejectedValueOnce(new Error('db locked'));

    await act(async () => {
      await expect(rendered.result.current.handleUnmanageApp('acme/atlas')).resolves.toBeUndefined();
    });

    expect(rendered.result.current.installedApps).toHaveLength(1);
    expect(deps.onAppRemoved).not.toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('db locked'), 'error');
  });
});
