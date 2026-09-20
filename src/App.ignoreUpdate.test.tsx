/**
 * P2-5 ignore-update persistence (real <App/> path).
 *
 * `忽略本次提醒` must flow through the same backend path as `跳过此版本`
 * (api.setAppSkipVersion + rules refresh): an ignored update stays absent
 * after re-check, and the rules UI reflects the persisted skip rule.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UpdateItem, UpdateRule } from './types';

const APP_ID = 'owner/ignored-app';
const LATEST = '2.0.0';

const UPDATE_FIXTURE: UpdateItem = {
  app_id: APP_ID,
  app_name: 'Ignored App',
  current_version: '1.0.0',
  latest_version: LATEST,
  changelog: '',
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
    'getMirrorStatus',
    'getFavorites',
    'getRecentlyViewedApps',
    'getDetectedInstalledAppIds',
    'getWatchedApps',
    'getHostTokens',
    'getSearchHistory',
  ]);
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'checkForUpdates') return (f?: boolean) => hooks.checkForUpdates(f);
        if (prop === 'setAppSkipVersion') return (id: string, v: string | null) => hooks.setAppSkipVersion(id, v);
        if (prop === 'getUpdateRules') return () => hooks.getUpdateRules();
        if (prop === 'getSettings') return async () => ({ update_frequency: 'startup' });
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

describe('P2-5 ignore-update persistence (real App path)', () => {
  it('ignore persists via setAppSkipVersion; re-check keeps it absent and rules UI reflects it', async () => {
    render(<App />);

    // Navigate to the updates center; the backend-fed fixture is listed.
    fireEvent.click(screen.getByRole('button', { name: '更新中心' }));
    expect(await screen.findByText('Ignored App')).toBeTruthy();

    // Ignore this update (same entry point as the user-facing menu).
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(await screen.findByText('忽略本次提醒'));

    // Backend path (copied from skip-version flow): skip persisted + rules refreshed.
    await waitFor(() => {
      expect(hooks.setAppSkipVersion).toHaveBeenCalledWith(APP_ID, LATEST);
    });
    await waitFor(() => {
      expect(hooks.getUpdateRules).toHaveBeenCalled();
    });

    // Item disappears immediately...
    await waitFor(() => {
      expect(screen.queryByText('Ignored App')).toBeNull();
    });

    // ...and stays absent after an explicit re-check (would return without persistence).
    const checksBefore = hooks.checkForUpdates.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => {
      expect(hooks.checkForUpdates.mock.calls.length).toBeGreaterThan(checksBefore);
    });
    await waitFor(() => {
      expect(screen.queryByText('Ignored App')).toBeNull();
    });
    expect(await screen.findByText('所有应用均已是最新版本')).toBeTruthy();

    // Rules UI reflects the persisted skip: updates header count...
    expect(screen.getByRole('button', { name: /规则.*\(1\)/ })).toBeTruthy();

    // ...and the rules manager modal lists the skipped app + version.
    fireEvent.click(screen.getByRole('button', { name: /规则.*\(1\)/ }));
    expect(await screen.findByText(/版本策略与屏蔽规则管理 \(1\)/)).toBeTruthy();
    expect(screen.getByText(APP_ID)).toBeTruthy();
    expect(screen.getByText(`跳过 ${LATEST}`)).toBeTruthy();
  });
});
