/**
 * 真实 <App/> 回归：
 * 顶栏存在搜索词过滤了 apps 时，切到收藏页「Star 同步」仍能识别全部远端已收录（蓝标）
 * 与本地收录（黄标）及待收录草稿（含 owner/repo 别名），不误显示「移入收录」按钮。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSummary } from './types';

function makeApp(id: string, extra: Partial<AppSummary> = {}): AppSummary {
  const [owner = 'o', repo = id] = id.split('/');
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: `${repo} desc`,
    stars: 100,
    forks: 10,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    ...extra,
  };
}

const FULL_CATALOG: AppSummary[] = [
  makeApp('zed-industries/zed', { name: 'Zed Editor', is_verified: true }),
  makeApp('other/only-search-hit', { name: 'SearchHit' }),
];

const CUSTOM_ENTRIES = [
  {
    id: 'local-alias-id',
    item: {
      id: 'local-alias-id',
      name: 'LocalTool',
      owner: 'acme',
      repo: 'local-tool',
      icon: '',
      icon_bg: '',
      description: 'local tool',
      description_en: null,
      category: 'dev',
      category_name: '开发工具',
      aliases: [],
      default_version: 'v1.0.0',
      license: 'MIT',
      stars: 50,
      forks: 2,
      is_verified: false,
      homepage: null,
      install_dirs: [],
      search_subdirs: [],
      publishers: [],
      platforms: ['windows'],
      identifiers: {},
    },
    status: 'collected',
    pr_url: null,
    created_at: 1,
    updated_at: 1,
    archived: false,
  },
];

const STARRED_ROWS: AppSummary[] = [
  makeApp('zed-industries/zed', { name: 'Zed Editor', is_verified: true, is_cataloged: true }),
  makeApp('acme/local-tool', { name: 'LocalTool', is_cataloged: false }),
  makeApp('acme/fresh-repo', { name: 'FreshRepo', is_cataloged: false }),
];

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'getInstalledApps',
    'getFavorites',
    'getUpdateRules',
    'getRecentlyViewedApps',
    'getWatchedApps',
    'checkForUpdates',
    'getSearchHistory',
    'getConfirmedIconsBatch',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSettings') return async () => ({ language: 'zh-CN' });
        if (prop === 'getOAuthUser') {
          return async () => ({ login: 'superMC5657', avatar_url: '', has_list_scope: true, is_expired: false });
        }
        if (prop === 'getCliDeepLink') return async () => null;
        if (prop === 'searchApps') {
          return async (q: string) => {
            const trimmed = q.trim().toLowerCase();
            if (!trimmed) return FULL_CATALOG;
            return FULL_CATALOG.filter((a) => a.id.toLowerCase().includes(trimmed));
          };
        }
        if (prop === 'listCustomApps') return async () => CUSTOM_ENTRIES;
        if (prop === 'listGithubStarred') {
          return async () => ({ rows: STARRED_ROWS, has_more: false });
        }
        if (prop === 'getPlatformsLite') return async (id: string) => ({ id, platforms: ['windows'], is_stale: false });
        if (prop === 'recordSearchQuery') return async () => undefined;
        if (listMethods.has(prop)) return async () => [];
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return {
    tauriApi,
    ONLINE_SEARCH_PER_PAGE: 20,
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
import { resetStarredFeedMemory } from './views/FavoritesView/StarredFeed';
import { clearSearchListCache } from './services/search/searchListCache';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  resetStarredFeedMemory();
  clearSearchListCache();
  window.localStorage.clear();
});

describe('App StarredFeed move-in suppression with active search & local aliases', () => {
  it('hides move-in for cataloged and yellow-badge local apps even when top search filters apps', async () => {
    render(<App />);

    // 先在顶栏搜索一个与 zed-industries/zed 无关的词，使 apps 被裁剪为子集。
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'only-search-hit' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('SearchHit')).toBeTruthy();
    });

    // 切换到「收藏」→「Star 同步」并查看登录账号的 Star 列表。
    fireEvent.click(await screen.findByText('收藏'));

    fireEvent.click(await screen.findByText('Star 同步'));
    fireEvent.click(await screen.findByRole('button', { name: '查看' }));

    await screen.findByText('Zed Editor');
    await screen.findByText('LocalTool');
    await screen.findByText('FreshRepo');

    // 已收录（蓝标）与本地收录（黄标，含 id 与 owner/repo 别名）绝不显示「移入收录」；未收录项正常显示。
    expect(screen.queryByTestId('move-in-zed-industries/zed')).toBeNull();
    expect(screen.queryByTestId('move-in-acme/local-tool')).toBeNull();
    expect(screen.getByTestId('move-in-acme/fresh-repo')).toBeTruthy();
  });
});
