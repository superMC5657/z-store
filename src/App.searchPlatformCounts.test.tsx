/**
 * 真实 <App/> 链路回归测试：在线搜索结果纳入左侧栏平台统计计数（含本地+在线同仓去重）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSummary } from './types';

function makeApp(id: string, platforms: string[]): AppSummary {
  const [owner = 'o', repo = id] = id.split('/');
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: `${repo} desc`,
    stars: 1000,
    forks: 10,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'dev',
    category_name: 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms,
  };
}

const LOCAL_CATALOG: AppSummary[] = [
  makeApp('zai-org/ZCode', ['windows', 'macos']),
  makeApp('other/tool', ['linux']),
];

const ONLINE_ZCODE_RESULTS: AppSummary[] = [
  makeApp('zai-org/zcode', ['windows', 'macos']),
  makeApp('ZiChuanLan/agent-purge', ['windows']),
  makeApp('TriDefender/zcode-api', ['windows', 'linux']),
  makeApp('pipy/zcode-switch', ['windows', 'macos', 'linux']),
  makeApp('asgeirtj/system_prompts', []),
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
    'getCustomApps',
    'getConfirmedIconsBatch',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSettings') return async () => ({});
        if (prop === 'getOAuthUser' || prop === 'getCliDeepLink') return async () => null;
        if (prop === 'searchApps') {
          return async (q: string) => {
            const trimmed = q.trim().toLowerCase();
            if (!trimmed) return LOCAL_CATALOG;
            return LOCAL_CATALOG.filter((a) => a.id.toLowerCase().includes(trimmed));
          };
        }
        if (prop === 'searchAppsOnline') {
          return async () => ({ rows: ONLINE_ZCODE_RESULTS, sid: 'sid-1' });
        }
        if (prop === 'getPlatformsLite') {
          return async () => ({ platforms: [], is_stale: false });
        }
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

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function sidebarChipCount(platformId: string): string | null {
  const chip = document.querySelector(`[data-platform-id="${platformId}"]`);
  return chip?.querySelector('.platform-chip-count')?.textContent ?? null;
}

describe('App sidebar platform counts include online search results', () => {
  it('updates sidebar platform counts with deduplicated local + online search results and restores on clear', async () => {
    render(<App />);

    // 初始加载：仅本地目录（zai-org/ZCode: win+mac, other/tool: linux）
    await waitFor(() => {
      expect(sidebarChipCount('windows')).toBe('1');
      expect(sidebarChipCount('macos')).toBe('1');
      expect(sidebarChipCount('linux')).toBe('1');
    });

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ZCode' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // 本地搜索阶段：只有 1 个本地匹配（win+mac），linux 为 0
    await waitFor(() => {
      expect(sidebarChipCount('windows')).toBe('1');
      expect(sidebarChipCount('macos')).toBe('1');
      expect(sidebarChipCount('linux')).toBe('0');
    });

    // 触发在线搜索：合并在线结果（zai-org/zcode 去重，agent-purge/zcode-api/zcode-switch 计入，system_prompts 落定为 other）
    const onlineBtn = await screen.findByTestId('search-online-trigger');
    fireEvent.click(onlineBtn);

    await waitFor(() => {
      expect(sidebarChipCount('windows')).toBe('4');
      expect(sidebarChipCount('macos')).toBe('2');
      expect(sidebarChipCount('linux')).toBe('2');
      expect(sidebarChipCount('other')).toBe('1');
    });

    // 取消勾选某个平台过滤后，侧栏统计保持全量搜索分布不变
    const winChip = document.querySelector('[data-platform-id="windows"]') as HTMLElement;
    fireEvent.click(winChip);
    expect(sidebarChipCount('windows')).toBe('4');
    expect(sidebarChipCount('linux')).toBe('2');

    // 清空搜索后恢复为全量目录分布
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => {
      expect(sidebarChipCount('windows')).toBe('1');
      expect(sidebarChipCount('macos')).toBe('1');
      expect(sidebarChipCount('linux')).toBe('1');
      expect(sidebarChipCount('other')).toBe('0');
    });
  });
});
