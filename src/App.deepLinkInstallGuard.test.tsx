/**
 * P0-1 深度链接静默安装 RCE 防护测试（真实 <App/> 链路）。
 *
 * `zstore://install/<owner>/<repo>` 绝对不允许自行触发安装：
 * 它必须打开应用详情视图并弹出显式确认弹窗，
 * 仅在用户显式点击确认后方可启动安装。其余四种
 * 深度链接分支（app_detail / search / developer_profile / open_view）
 * 行为与此前完全保持一致。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { AppDetail, DeepLinkAction, InstalledApp } from './types';

const hooks = vi.hoisted(() => ({
  installApp: vi.fn(async (id: string): Promise<InstalledApp> => ({
    app_id: id,
    app_name: 'DeepLink Guard Fixture',
    version: '1.0.0',
    installed_at: Date.now(),
    install_method: 'test',
    install_path: 'C:\\test',
    asset_name: 'fixture.exe',
    asset_sha256: 'ab'.repeat(32),
  })),
  handleDeepLinkImpl: vi.fn(async (_url: string): Promise<DeepLinkAction> => ({
    action: 'app_detail',
    payload: { app_id: 'testowner/testrepo' },
  })),
  searchApps: vi.fn(async (_q: string) => []),
  getAppDetailsImpl: vi.fn(async (id: string, _forceRefresh?: boolean): Promise<AppDetail> => ({
    id,
    name: 'DeepLink Guard Fixture',
    owner: 'testowner',
    repo: 'testrepo',
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'fixture for deeplink install guard',
    stars: 1,
    forks: 0,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: true,
    readme_markdown: '',
    releases: [
      {
        name: 'fixture.exe',
        download_url: 'https://example.com/fixture.exe',
        size_bytes: 8,
        sha256: 'cd'.repeat(32),
        os: 'windows',
        arch: 'x64',
        kind: 'installer',
      },
    ],
    category: 'system',
    category_name: '应用',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  })),
}));

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'getInstalledApps',
    'getMirrorStatus',
    'getFavorites',
    'getUpdateRules',
    'getRecentlyViewedApps',
    'getDetectedInstalledAppIds',
    'getWatchedApps',
    'checkForUpdates',
    'getHostTokens',
    'getSearchHistory',
  ]);
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'installApp') return hooks.installApp;
        if (prop === 'handleDeepLink') return (url: string) => hooks.handleDeepLinkImpl(url);
        if (prop === 'searchApps') return (q: string) => hooks.searchApps(q);
        if (prop === 'getAppDetails') return (id: string, forceRefresh?: boolean) => hooks.getAppDetailsImpl(id, forceRefresh);
        if (prop === 'getSettings') return async () => ({});
        if (prop === 'getOAuthUser' || prop === 'getCliDeepLink') return async () => null;
        if (listMethods.has(prop)) return async () => [];
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return {
    api,
    DEFAULT_SETTINGS: {
      theme: 'dark',
      ui_scale: '100',
      font_size: '14',
      portable_dir: '',
      download_dir: '',
      active_mirror: '',
      max_concurrent_downloads: 3,
      github_token: '',
      close_to_tray: true,
      launch_on_startup: false,
      update_frequency: 'manual',
      detail_cache_ttl_minutes: 30,
      catalog_source_url: '',
      watch_notify_frequency: 'daily',
    },
  };
});

import { App } from './App';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

function dispatchDeepLink(url: string): void {
  const fn = (window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink'];
  if (typeof fn !== 'function') throw new Error('dispatchZStoreDeepLink not wired');
  (fn as (url: string) => Promise<void>)(url);
}

describe('P0-1 deeplink install guard (real App path)', () => {
  it('install_app deeplink never auto-installs: it opens detail + confirm dialog, install starts only on confirm click', async () => {
    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'install_app',
      payload: { app_id: 'testowner/testrepo' },
    });
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    await act(async () => {
      dispatchDeepLink('zstore://install/testowner/testrepo');
    });

    // 关卡门控：未经显式点击确认，绝不可启动安装。
    const dialog = await screen.findByRole('dialog', { name: /确认安装/ });
    expect(dialog).toBeTruthy();
    expect(hooks.installApp).not.toHaveBeenCalled();

    // 详情视图与弹窗同步打开（复用 handleOpenDetail 链路）。
    await waitFor(() => {
      expect(hooks.getAppDetailsImpl).toHaveBeenCalledWith('testowner/testrepo', false);
    });

    // 弹窗展示应用名称、仓库/来源以及 SHA-256（如可用）。
    expect(dialog.textContent).toContain('DeepLink Guard Fixture');
    expect(dialog.textContent).toContain('testowner/testrepo');
    expect(dialog.textContent).toContain('cd'.repeat(32));

    // 仅在显式点击确认按钮后才启动安装。
    fireEvent.click(screen.getByRole('button', { name: /确认安装/ }));
    await waitFor(() => {
      expect(hooks.installApp).toHaveBeenCalledTimes(1);
    });
    expect(hooks.installApp).toHaveBeenCalledWith('testowner/testrepo', undefined, undefined);
  });

  it('cancelling the confirm dialog aborts the deeplink install', async () => {
    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'install_app',
      payload: { app_id: 'testowner/testrepo' },
    });
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    await act(async () => {
      dispatchDeepLink('zstore://install/testowner/testrepo');
    });
    await screen.findByRole('dialog', { name: /确认安装/ });

    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /确认安装/ })).toBeNull();
    });
    expect(hooks.installApp).not.toHaveBeenCalled();
  });

  it('sibling deeplink branches behave as before and never install', async () => {
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'app_detail',
      payload: { app_id: 'testowner/testrepo' },
    });
    await act(async () => {
      dispatchDeepLink('zstore://app/testowner/testrepo');
    });
    await waitFor(() => {
      expect(hooks.getAppDetailsImpl).toHaveBeenCalledWith('testowner/testrepo', false);
    });
    expect(screen.queryByRole('dialog', { name: /确认安装/ })).toBeNull();

    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'search',
      payload: { query: 'editor' },
    });
    await act(async () => {
      dispatchDeepLink('zstore://search?query=editor');
    });
    await waitFor(() => {
      expect(hooks.searchApps).toHaveBeenCalledWith('editor');
    });

    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'developer_profile',
      payload: { owner: 'testowner' },
    });
    await act(async () => {
      dispatchDeepLink('zstore://developer/testowner');
    });
    await waitFor(() => {
      expect(screen.getByLabelText('关闭开发者详情')).toBeTruthy();
    });

    hooks.handleDeepLinkImpl.mockResolvedValueOnce({
      action: 'open_view',
      payload: { view: 'settings' },
    });
    await act(async () => {
      dispatchDeepLink('zstore://view/settings');
    });
    await waitFor(() => {
      expect(document.getElementById('settings-account')).toBeTruthy();
    });

    expect(hooks.installApp).not.toHaveBeenCalled();
  });
});
