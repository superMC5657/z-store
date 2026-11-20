/** 测试「跳过此版本」规则持久化及规则管理弹窗的同步展示。 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InstalledApp, UpdateItem, UpdateRule } from './types';

const APP_ID = 'owner/ignored-app';
const LATEST = '2.0.0';

const UPDATE_FIXTURE: UpdateItem = {
  app_id: APP_ID,
  app_name: 'Ignored App',
  current_version: '1.0.0',
  latest_version: LATEST,
  changelog: '',
};

const INSTALLED_FIXTURE: InstalledApp = {
  app_id: APP_ID,
  app_name: 'Ignored App',
  version: '1.0.0',
  installed_at: 1790000000,
  install_method: 'msi',
  install_path: 'C:\\Apps\\Ignored',
  asset_name: 'ignored.msi',
  asset_sha256: 'abc',
};

const hooks = vi.hoisted(() => {
  const skipped = new Map<string, string>();
  const checkForUpdates = vi.fn(async (_forceRefresh?: boolean): Promise<UpdateItem[]> => {
    if (skipped.get(APP_ID) === LATEST) return [];
    return [{ ...UPDATE_FIXTURE }];
  });
  const setAppSkipVersion = vi.fn(async (appId: string, version: string | null): Promise<boolean> => {
    if (version === null) skipped.delete(appId);
    else skipped.set(appId, version);
    return true;
  });
  const getUpdateRules = vi.fn(async (): Promise<UpdateRule[]> => {
    return [...skipped.entries()].map(([app_id, skipped_version]) => ({
      app_id,
      skipped_version,
      is_frozen: false,
      is_hidden: false,
      updated_at: Date.now(),
    }));
  });
  return { skipped, checkForUpdates, setAppSkipVersion, getUpdateRules };
});

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'searchApps',
    'getInstalledApps',
    'getFavorites',
    'getRecentlyViewedApps',
    'getWatchedApps',
    'getSearchHistory',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'checkForUpdates') return (f?: boolean) => hooks.checkForUpdates(f);
        if (prop === 'setAppSkipVersion') return (id: string, v: string | null) => hooks.setAppSkipVersion(id, v);
        if (prop === 'getUpdateRules') return () => hooks.getUpdateRules();
        if (prop === 'getInstalledApps') return async () => [{ ...INSTALLED_FIXTURE }];
        if (prop === 'getSettings') return async () => ({ update_frequency: 'startup', language: 'zh-CN' });
        if (prop === 'getOAuthUser' || prop === 'getCliDeepLink') return async () => null;
        if (listMethods.has(prop)) return async () => [];
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return {
    tauriApi,
    DEFAULT_SETTINGS: {
      theme: 'dark',
      language: 'zh-CN',
      ui_scale: '100',
      font_size: '14',
      portable_dir: '',
      download_dir: '',
      active_mirror: '',
      launch_on_startup: false,
      update_frequency: 'startup',
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
  hooks.skipped.clear();
  vi.clearAllMocks();
});

describe('ignore-update persistence (real App path)', () => {
  it('ignore persists via setAppSkipVersion; re-check keeps it absent and rules UI reflects it', async () => {
    render(<App />);

    // 「我的应用」属资产区：打开/切签不自动检查，经检查更新按钮显式刷新。
    // 导航后手动触发检查，已装行就地呈现目标版本与「更新」按钮。
    fireEvent.click(screen.getByRole('button', { name: '我的应用' }));
    expect(await screen.findByText('Ignored App')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText(LATEST)).toBeTruthy();
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy();

    // 跳过该版本（入口与用户界面菜单一致）。
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(await screen.findByText('跳过此版本'));

    // 后端链路（对齐跳过版本流程）：跳过规则已持久化 + 规则列表已刷新。
    await waitFor(() => {
      expect(hooks.setAppSkipVersion).toHaveBeenCalledWith(APP_ID, LATEST);
    });
    await waitFor(() => {
      expect(hooks.getUpdateRules).toHaveBeenCalled();
    });

    // 该行立即回到无更新态（行保留，目标版本与「更新」按钮消失）...
    await waitFor(() => {
      expect(screen.queryByText(LATEST)).toBeNull();
    });
    expect(screen.getByText('Ignored App')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();

    // ...且显式触发重新检查后依然保持排除状态（若无持久化则会重新出现）。
    const checksBefore = hooks.checkForUpdates.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => {
      expect(hooks.checkForUpdates.mock.calls.length).toBeGreaterThan(checksBefore);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(false);
    });
    expect(screen.queryByText(LATEST)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '有更新 0' }));
    expect(await screen.findByText('已是最新版本')).toBeTruthy();

    // 规则管理界面反映该持久化跳过规则：更新头部统计...
    const rulesBtn = screen.getByRole('button', { name: /规则\s*1$/ });
    expect(rulesBtn).toBeTruthy();

    // ...且规则管理器弹窗列出跳过的应用及其版本号。
    fireEvent.click(rulesBtn);
    expect(await screen.findByRole('heading', { name: '规则管理' })).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: '全部 1' })).toBeTruthy();
    expect(within(dialog).getByText(APP_ID)).toBeTruthy();
    expect(within(dialog).getByText(`跳过 ${LATEST}`)).toBeTruthy();
  });
});
