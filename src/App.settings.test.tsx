/**
 * Settings characterization (pre-extract guard for the useAppSettings split).
 *
 * Pins the persisted-settings apply contract before it moves into a hook:
 * backend `getSettings()` snapshot merges over defaults and drives
 * `data-theme` / `data-font-size` / `--font-scale` on <html>.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'searchApps',
    'getInstalledApps',
    'getMirrorStatus',
    'getFavorites',
    'getUpdateRules',
    'getRecentlyViewedApps',
    'getDetectedInstalledAppIds',
    'getWatchedApps',
    'getHostTokens',
    'getSearchHistory',
    'checkForUpdates',
  ]);
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSettings')
          return async () => ({
            theme: 'light',
            font_size: '16',
            ui_scale: '100',
            update_frequency: 'manual',
          });
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
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-font-size');
  vi.clearAllMocks();
});

describe('settings characterization (real App path)', () => {
  it('applies persisted theme/font-size snapshot to <html>', async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(document.documentElement.getAttribute('data-font-size')).toBe('16');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.14');
  });
});
