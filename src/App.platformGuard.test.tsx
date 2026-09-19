/**
 * Platform allow-empty regression (real <App/> path).
 *
 * Empty platform selection is VALID and means empty list: the three
 * discovery pages already render their own filter-empty states for an
 * empty selection (matchPlatformSet matches nothing against an empty
 * set). There is no refusal toast — unchecking the last platform
 * commits the empty set and persists `[]`.
 *
 * Same-tick toggles still apply sequentially: the toggle lives inside
 * the `setSelectedPlatforms` functional updater, so each dispatch sees
 * the latest committed state. Sidebar stays dumb (callback-only).
 */
// @ts-ignore - vitest is fetched transiently via npx (not a repo dep per task scope)
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    'checkForUpdates',
    'getHostTokens',
    'getSearchHistory',
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

// @ts-ignore - App.tsx ships without a vitest dep; resolved transiently via npx
import { App, PLATFORM_FILTER_STORAGE_KEY } from './App';

// Same-tick dispatches below use React.act directly (not via fireEvent), so
// opt the jsdom env into act() explicitly to avoid the benign warning.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function checkedIds(): string[] {
  return screen
    .getAllByRole('checkbox')
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.getAttribute('data-platform-id') ?? '')
    .sort();
}

describe('platform allow-empty (real App + Sidebar path)', () => {
  it('sequential deselect of all 5 reaches the empty set and persists []', async () => {
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      const current = screen.getAllByRole('checkbox');
      const target = current[i];
      if (target) fireEvent.click(target);
    }
    expect(checkedIds()).toEqual([]);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('[]');
  });

  it('rechecking from empty re-adds the platform', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(5);
    expect(checkedIds()).toEqual([]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Linux/ }));
    expect(checkedIds()).toEqual(['linux']);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('["linux"]');
  });

  it('reload with stored [] restores [] (no full-set fallback)', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(5);
    expect(checkedIds()).toEqual([]);
  });

  it('same-tick double toggle applies sequentially against fresh state', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['windows', 'linux']));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(5);
    expect(checkedIds()).toEqual(['linux', 'windows']);
    // No intermediate flush between the two clicks: both dispatches must
    // chain on the latest state, not on the shared render-closure snapshot.
    act(() => {
      screen.getByRole('checkbox', { name: /Windows/ }).click();
      screen.getByRole('checkbox', { name: /Linux/ }).click();
    });
    // {windows,linux} -windows -> {linux}; -linux -> {} (empty is valid).
    expect(checkedIds()).toEqual([]);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('[]');
  });

  it('toggling off the last platform commits the empty set and the view shows the empty-filter state, not the full list', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['linux']));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(5);
    expect(checkedIds()).toEqual(['linux']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Linux/ }));
    // toggle off last -> selection becomes the empty Set (empty is valid) ...
    expect(checkedIds()).toEqual([]);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('[]');
    // ... and the discovery view renders its empty-filter affordance, not the full list
    expect(document.querySelector('.filter-empty-reset')).toBeTruthy();
  });
});
