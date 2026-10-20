/**
 * 收藏切换失败路径测试（Issue 04）。
 *
 * 锁定契约：`tauriApi.toggleFavorite` reject 时，
 * - 错误经 Toast 呈现（收藏切换失败），不产生 unhandled rejection；
 * - 收藏集合不翻转（卡片不进入已收藏态，无成功提示）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { AppSummary } from './types';

function seedApp(id: string, name: string): AppSummary {
  return {
    id,
    name,
    owner: 'test',
    repo: 'demo-app',
    icon: '',
    icon_bg: '#333333',
    description: 'A test demo app',
    stars: 1200,
    forks: 300,
    license: 'MIT',
    latest_version: '1.2.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

const SEED_APPS: AppSummary[] = [seedApp('test/hero-app', 'Hero App'), seedApp('test/demo-app', 'Demo App')];

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'getInstalledApps',
    'getMirrorStatus',
    'getFavorites',
    'getUpdateRules',
    'getRecentlyViewedApps',
    'getWatchedApps',
    'getHostTokens',
    'getSearchHistory',
    'checkForUpdates',
    'listCustomApps',
    'getCachedUpdates',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSettings') return async () => ({ language: 'zh-CN' });
        if (prop === 'getOAuthUser' || prop === 'getCliDeepLink') return async () => null;
        if (prop === 'searchApps') return async () => SEED_APPS;
        if (prop === 'toggleFavorite')
          return async () => {
            throw new Error('db offline');
          };
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
      ui_scale: '100',
      font_size: '14',
      portable_dir: '',
      download_dir: '',
      active_mirror: '',
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

describe('toggleFavorite failure (real App path)', () => {
  it('toasts the failure and keeps the card unfavorited', async () => {
    render(<App />);
    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>)['dispatchZStoreDeepLink']).toBeTypeOf('function');
    });

    const favButton = await screen.findByRole('button', { name: '应用内收藏（保存至本机数据库）' });
    await act(async () => {
      fireEvent.click(favButton);
    });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('收藏切换失败');
    });
    expect(screen.getByRole('status').textContent).not.toContain('已成功添加至我的收藏夹');
    // 失败不翻转乐观态：按钮仍处于未收藏口径
    expect(screen.getByRole('button', { name: '应用内收藏（保存至本机数据库）' })).toBeTruthy();
  });
});
