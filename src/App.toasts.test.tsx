/**
 * Toast characterization (pre-extract guard for the useToasts split).
 *
 * Pins the App-level toast contract before it moves into a hook:
 * - `zstore:toast` window events surface text in the toast region;
 * - only the latest toast is visible;
 * - the dismiss button clears it.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';

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

function sendToast(text: string, type = 'info'): void {
  window.dispatchEvent(new CustomEvent('zstore:toast', { detail: { text, type } }));
}

describe('toast characterization (real App path)', () => {
  it('surfaces zstore:toast events and dismisses via close button', async () => {
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    await act(async () => {
      sendToast('char-toast-alpha');
    });
    expect(screen.getByRole('status').textContent).toContain('char-toast-alpha');

    fireEvent.click(screen.getByRole('button', { name: /关闭通知/ }));
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('shows only the latest toast when several arrive', async () => {
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    await act(async () => {
      sendToast('char-toast-first');
      sendToast('char-toast-second');
    });
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('char-toast-second');
    expect(region.textContent).not.toContain('char-toast-first');
  });
});
