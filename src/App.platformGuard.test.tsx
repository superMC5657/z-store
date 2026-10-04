/**
 * 平台筛选允许空集合回归测试（真实 <App/> 链路）。
 *
 * 空平台选择为有效状态，代表空列表：三个发现页面均针对空选择渲染各自的筛选为空引导界面
 * （matchPlatformSet 对空集合不匹配任何应用）。绝不会弹出拒绝操作的 Toast——
 * 取消勾选最后一个平台会正常提交空集合并持久化 `[]`。
 *
 * 同一 tick 内的多次切换仍顺序执行：切换逻辑位于 `setSelectedPlatforms` 函数式 updater 内部，
 * 每次派发均能看到最新的提交状态。侧栏保持无状态（仅回调通知）。
 */
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
      launch_on_startup: false,
      update_frequency: 'manual',
      detail_cache_ttl_minutes: 30,
      catalog_source_url: '',
      watch_notify_frequency: 'daily',
    },
  };
});

import { App, PLATFORM_FILTER_STORAGE_KEY } from './App';

// 下方的同一 tick 派发直接使用 React.act（而非通过 fireEvent），
// 显式为 jsdom 环境启用 act() 以避免无害告警。
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
  it('sequential deselect of all 6 reaches the empty set and persists []', async () => {
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    for (let i = 0; i < 6; i += 1) {
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
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    expect(checkedIds()).toEqual([]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Linux/ }));
    expect(checkedIds()).toEqual(['linux']);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('["linux"]');
  });

  it('reload with stored [] restores [] (no full-set fallback)', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    expect(checkedIds()).toEqual([]);
  });

  it('same-tick double toggle applies sequentially against fresh state', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['windows', 'linux']));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    expect(checkedIds()).toEqual(['linux', 'windows']);
    // 两次点击之间无中间渲染刷新：两次派发都必须链接在最新状态上，
    // 而非依赖共享的渲染闭包快照。
    act(() => {
      screen.getByRole('checkbox', { name: /Windows/ }).click();
      screen.getByRole('checkbox', { name: /Linux/ }).click();
    });
    // {windows,linux} -windows -> {linux}; -linux -> {}（空选择有效）。
    expect(checkedIds()).toEqual([]);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('[]');
  });

  it('toggling off the last platform commits the empty set and the view shows the empty-filter state, not the full list', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['linux']));
    render(<App />);
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    expect(checkedIds()).toEqual(['linux']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Linux/ }));
    // 取消勾选最后一项 -> 选择变为由空 Set 组成的有效状态 ...
    expect(checkedIds()).toEqual([]);
    expect(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY)).toBe('[]');
    // ... 且发现视图渲染其筛选为空引导提示，绝非展示完整列表
    expect(document.querySelector('.filter-empty-reset')).toBeTruthy();
  });
});
