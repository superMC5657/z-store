/**
 * useInstallState 回归：
 *
 * - 安装成功：列表按 app_id 大小写不敏感去重替换 + success toast；
 * - 重复安装守卫：在途集合去重（ref 读取，回调稳定）；
 * - D3 门禁：`unverified-asset-required:` 前缀错误 → 挂起待确认（非失败态：
 *   不弹错误 toast、不 rethrow），确认/取消共用清口 dismiss；
 * - 取消/中止/1602 → info 提示；其余失败 → error 提示并 rethrow；
 * - 卸载成功/取消双路；启动/取消管理/刷新（幽灵自愈）；
 * - 已装列表加载：进入 installed 视图自动触发，失败落 installLoadError（与空列表区分）。
 */
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
  };
  const rendered = renderHook(
    (props: { currentView: string }) =>
      useInstallState({
        currentView: props.currentView,
        apps: [],
        showToast: spies.showToast,
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

  it('刷新已装列表：成功替换 + success；失败 error；isRefreshing 复位', async () => {
    const { rendered, deps } = renderInstall();
    mocks.getInstalledApps.mockResolvedValueOnce([makeInstalled('acme/atlas')]);
    await act(async () => {
      await rendered.result.current.handleRefreshInstalledApps();
    });
    expect(rendered.result.current.installedApps).toHaveLength(1);
    expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), 'success');
    expect(rendered.result.current.isRefreshingInstalled).toBe(false);

    deps.showToast.mockClear();
    mocks.getInstalledApps.mockRejectedValueOnce(new Error('db gone'));
    await act(async () => {
      await rendered.result.current.handleRefreshInstalledApps();
    });
    expect(deps.showToast).toHaveBeenCalledWith(expect.stringContaining('toast.refresh_installed_failed'), 'error');
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
