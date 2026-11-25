/** 回归测试 AppDetailModal 原地切换应用时的状态重置与过期异步结果丢弃（F-32 / F-31）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppDetailViewModel, ReleaseAsset } from '../../types';
import '../../i18n';

vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

const hooks = vi.hoisted(() => ({
  fetchStarredStatus: vi.fn(async (_id: string) => false),
  downloadAsset: vi.fn(),
  cycleAppIcon: vi.fn(),
  restoreOrFetchIconCycle: vi.fn(async () => null),
  getSimilarApps: vi.fn(async () => ({ items: [], target_alternatives: [] })),
}));

vi.mock('../../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'fetchStarredStatus') return (id: string) => hooks.fetchStarredStatus(id);
        if (prop === 'downloadAsset') return (...args: unknown[]) => hooks.downloadAsset(...args);
        if (prop === 'cycleAppIcon') return (...args: unknown[]) => hooks.cycleAppIcon(...args);
        if (prop === 'restoreOrFetchIconCycle') return () => hooks.restoreOrFetchIconCycle();
        if (prop === 'getSimilarApps') return () => hooks.getSimilarApps();
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

import { AppDetailModal } from './index';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// jsdom 默认 UA 携带宿主机平台信息，固定为 Windows 宿主以保证跨平台 CI 行为一致。
const HOST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
let userAgentSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  userAgentSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(HOST_UA);
});

afterEach(() => {
  cleanup();
  userAgentSpy?.mockRestore();
  vi.clearAllMocks();
});

function makeAsset(overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: 'demo-win-x64.exe',
    download_url: 'https://example.com/demo-win-x64.exe',
    size_bytes: 1024 * 1024,
    os: 'windows',
    arch: 'x86_64',
    kind: 'setup_exe',
    ...overrides,
  };
}

function makeApp(id: string, name: string, releases: ReleaseAsset[]): AppDetailViewModel {
  const [owner, repo] = id.split('/');
  return {
    id,
    name,
    owner,
    repo,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${name} desc`,
    stars: 100,
    forks: 10,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: false,
    is_cataloged: false,
    readme_markdown: `# ${name}`,
    releases,
    category: 'system',
    category_name: '系统',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    isLoading: false,
  };
}

describe('AppDetailModal in-place app switch (F-32)', () => {
  it('resets showAllAssets and isInstalling on app.id change and discards stale install error', async () => {
    let rejectInstallA!: (err: Error) => void;
    const onInstall = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstallA = reject;
        }),
    );

    const appA = makeApp('Org/AppA', 'App Alpha', [
      makeAsset({ name: 'alpha-x64.exe' }),
      makeAsset({ name: 'alpha-arm64.exe', arch: 'aarch64' }),
    ]);
    const appB = makeApp('Org/AppB', 'App Beta', [
      makeAsset({ name: 'beta-x64.exe' }),
      makeAsset({ name: 'beta-arm64.exe', arch: 'aarch64' }),
    ]);

    const { rerender, container } = render(
      <AppDetailModal
        app={appA}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={onInstall}
        onLaunch={() => {}}
      />,
    );

    // Expand asset list on App A
    const toggleBtn = screen.getByRole('button', { name: /全部资产|All assets/i });
    fireEvent.click(toggleBtn);
    expect(container.querySelector('.asset-list-scroll')).toBeTruthy();

    // Start installing App A
    const installBtn = screen.getByRole('button', { name: /^安装$|^Install$/i });
    fireEvent.click(installBtn);
    expect(onInstall).toHaveBeenCalledWith('Org/AppA', 'alpha-x64.exe', undefined);

    // Switch in-place to App B before App A install finishes
    rerender(
      <AppDetailModal
        app={appB}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={onInstall}
        onLaunch={() => {}}
      />,
    );

    // showAllAssets and isInstalling must both reset for App B
    expect(container.querySelector('.asset-list-scroll')).toBeNull();
    const installBtnB = screen.getByRole('button', { name: /^安装$|^Install$/i }) as HTMLButtonElement;
    expect(installBtnB.disabled).toBe(false);

    // Reject App A's install after switch — App B must NOT display App A's error
    await act(async () => {
      rejectInstallA(new Error('App A boom'));
      await Promise.resolve();
    });
    expect(screen.queryByText(/App A boom/)).toBeNull();
  });

  it('discards stale downloadAsset result and refresh notice after switching apps', async () => {
    let resolveDownloadA!: (v: { file_path: string; file_name: string }) => void;
    hooks.downloadAsset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownloadA = resolve;
        }),
    );

    let resolveRefreshA!: () => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefreshA = resolve;
        }),
    );

    const appA = makeApp('org/apk-a', 'APK Alpha', [
      makeAsset({ name: 'alpha.apk', os: 'android', arch: 'universal', kind: 'apk' }),
    ]);
    const appB = makeApp('org/apk-b', 'APK Beta', [
      makeAsset({ name: 'beta.apk', os: 'android', arch: 'universal', kind: 'apk' }),
    ]);

    const { rerender, container } = render(
      <AppDetailModal
        app={appA}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
        onRefresh={onRefresh}
      />,
    );

    // Trigger download-only and refresh on App A
    const downloadBtnA = screen.getByRole('button', { name: /下载|Download/i });
    fireEvent.click(downloadBtnA);
    const refreshBtnA = container.querySelector('.modal-actions-header button') as HTMLButtonElement;
    fireEvent.click(refreshBtnA);

    await waitFor(() => {
      expect(hooks.downloadAsset).toHaveBeenCalledWith('org/apk-a', 'alpha.apk');
      expect(onRefresh).toHaveBeenCalledWith('org/apk-a');
    });

    // Switch in-place to App B before either settles
    rerender(
      <AppDetailModal
        app={appB}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
        onRefresh={onRefresh}
      />,
    );

    await act(async () => {
      resolveDownloadA({ file_path: 'C:/Downloads/alpha.apk', file_name: 'alpha.apk' });
      resolveRefreshA();
      await Promise.resolve();
    });

    // App B must NOT show App A's "Open folder" button or refresh success notice
    expect(screen.queryByRole('button', { name: /打开所在文件夹|Open folder/i })).toBeNull();
    expect(container.querySelector('.modal-tag-success')).toBeNull();
  });
});
