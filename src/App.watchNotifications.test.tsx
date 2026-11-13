/**
 * 关注提醒持久化（真实 <App/> 链路）：
 * 启动时经 getWatchNotifications 读回后端保存的待处理提醒，在收藏页「关注」签顶部「有新版本」分节列出；
 * 「知道了」经 dismissWatchNotification 落库后移出，列表清空后分节不再渲染；
 * 已确认项在规则管理「关注已读」签列出（规则入口在「我的应用」），「恢复提醒」后回到关注签。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WatchDismissedEntry, WatchUpdatedPayload } from './types';

const hooks = vi.hoisted(() => {
  const pending: WatchUpdatedPayload[] = [];
  const dismissed: WatchDismissedEntry[] = [];
  const getWatchNotifications = vi.fn(async (): Promise<WatchUpdatedPayload[]> => pending.map((p) => ({ ...p })));
  const getDismissedWatchNotifications = vi.fn(async (): Promise<WatchDismissedEntry[]> =>
    dismissed.map((d) => ({ ...d })),
  );
  const dismissWatchNotification = vi.fn(async (appId: string): Promise<boolean> => {
    const idx = pending.findIndex((p) => p.app_id === appId);
    if (idx < 0) return false;
    const [item] = pending.splice(idx, 1);
    dismissed.unshift({ app_id: item.app_id, version: item.version, dismissed_at: 1_794_528_000 });
    return true;
  });
  const restoreWatchNotification = vi.fn(async (appId: string): Promise<boolean> => {
    const idx = dismissed.findIndex((d) => d.app_id === appId);
    if (idx < 0) return false;
    const [item] = dismissed.splice(idx, 1);
    pending.unshift({ app_id: item.app_id, version: item.version });
    return true;
  });
  // 捕获实时提醒订阅回调，供用例模拟 `zstore://watch-updated` 事件
  const live: { emit: ((p: WatchUpdatedPayload) => void) | null } = { emit: null };
  return {
    pending,
    dismissed,
    live,
    getWatchNotifications,
    getDismissedWatchNotifications,
    dismissWatchNotification,
    restoreWatchNotification,
  };
});

vi.mock('./services/api', () => {
  const listMethods = new Set([
    'searchApps',
    'getInstalledApps',
    'getFavorites',
    'getRecentlyViewedApps',
    'getWatchedApps',
    'getSearchHistory',
    'getUpdateRules',
    'getCachedUpdates',
    'checkForUpdates',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getWatchNotifications') return () => hooks.getWatchNotifications();
        if (prop === 'dismissWatchNotification') return (id: string) => hooks.dismissWatchNotification(id);
        if (prop === 'getDismissedWatchNotifications') return () => hooks.getDismissedWatchNotifications();
        if (prop === 'restoreWatchNotification') return (id: string) => hooks.restoreWatchNotification(id);
        if (prop === 'onWatchUpdated') {
          return async (cb: (p: WatchUpdatedPayload) => void) => {
            hooks.live.emit = cb;
            return () => {};
          };
        }
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
  hooks.pending.length = 0;
  hooks.dismissed.length = 0;
  hooks.live.emit = null;
  vi.clearAllMocks();
});

const RELEASE_V2 = '你关注的 owner/watched-app 发布了 v2.0.0';

/** 进入收藏页「关注」签（签名带关注总数角标）。 */
async function openWatchedTab() {
  fireEvent.click(screen.getByRole('button', { name: /^收藏/ }));
  fireEvent.click(await screen.findByRole('tab', { name: /^关注/ }));
}

/** 进入「我的应用」，规则按钮在其顶栏。 */
function openMyApps() {
  fireEvent.click(screen.getByRole('button', { name: /^我的应用/ }));
}

describe('watch notifications persistence (real App path)', () => {
  it('lists persisted alerts on startup and dismisses them through the backend', async () => {
    hooks.pending.push({ app_id: 'owner/watched-app', version: 'v2.0.0' });
    render(<App />);

    await openWatchedTab();
    expect(await screen.findByText(RELEASE_V2)).toBeTruthy();
    expect(screen.getByText('有新版本')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => {
      expect(hooks.dismissWatchNotification).toHaveBeenCalledWith('owner/watched-app');
    });
    await waitFor(() => {
      expect(screen.queryByText(RELEASE_V2)).toBeNull();
    });
    // 清空后仍停留在关注签，提醒分节不再渲染
    expect(screen.getByRole('tab', { name: /^关注/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('有新版本')).toBeNull();
  });

  it('lists confirmed alerts in the rules manager and restores them to the watch feed', async () => {
    hooks.pending.push({ app_id: 'owner/watched-app', version: 'v2.0.0' });
    render(<App />);

    await openWatchedTab();
    fireEvent.click(await screen.findByRole('button', { name: '知道了' }));
    await waitFor(() => {
      expect(screen.queryByText(RELEASE_V2)).toBeNull();
    });

    // 已读计入规则数，规则管理「关注已读」签列出
    openMyApps();
    fireEvent.click(await screen.findByRole('button', { name: /规则\s*1$/ }));
    expect(await screen.findByRole('heading', { name: '规则管理' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '关注已读 1' }));
    expect(await screen.findByText('已读 v2.0.0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '恢复提醒' }));
    await waitFor(() => {
      expect(hooks.restoreWatchNotification).toHaveBeenCalledWith('owner/watched-app');
    });
    await waitFor(() => {
      expect(screen.queryByText('已读 v2.0.0')).toBeNull();
    });

    // 回到收藏页关注签，提醒重新出现
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await openWatchedTab();
    expect(await screen.findByText(RELEASE_V2)).toBeTruthy();
  });

  it('reports a failed restore in the rules manager instead of claiming success', async () => {
    hooks.dismissed.push({ app_id: 'owner/watched-app', version: 'v2.0.0', dismissed_at: 1_794_528_000 });
    hooks.restoreWatchNotification.mockRejectedValueOnce(new Error('db locked'));
    render(<App />);

    openMyApps();
    fireEvent.click(await screen.findByRole('button', { name: /规则\s*1$/ }));
    fireEvent.click(await screen.findByRole('tab', { name: '关注已读 1' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复提醒' }));

    expect(await screen.findByText(/保存失败: Error: db locked/)).toBeTruthy();
    expect(screen.queryByText(/已恢复 owner\/watched-app 关注提醒/)).toBeNull();
    expect(screen.getByText('已读 v2.0.0')).toBeTruthy();
  });

  it('drops a seen entry from the rules count as soon as a newer release alerts', async () => {
    hooks.dismissed.push({ app_id: 'owner/watched-app', version: 'v2.0.0', dismissed_at: 1_794_528_000 });
    render(<App />);

    openMyApps();
    expect(await screen.findByRole('button', { name: /规则\s*1$/ })).toBeTruthy();

    await waitFor(() => expect(hooks.live.emit).not.toBeNull());
    await act(async () => {
      hooks.live.emit?.({ app_id: 'owner/watched-app', version: 'v2.1.0' });
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /规则\s*1$/ })).toBeNull();
    });
    await openWatchedTab();
    // 实时事件同时弹出同文案 Toast，这里只看关注签里的提醒分节
    const panel = (await waitFor(() => {
      const el = document.querySelector('.watch-releases-panel');
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;
    expect(within(panel).getByText('你关注的 owner/watched-app 发布了 v2.1.0')).toBeTruthy();
  });

  it('keeps the alert when the backend dismiss fails', async () => {
    hooks.pending.push({ app_id: 'owner/watched-app', version: 'v2.0.0' });
    hooks.dismissWatchNotification.mockRejectedValueOnce(new Error('db locked'));
    render(<App />);

    await openWatchedTab();
    expect(await screen.findByText(RELEASE_V2)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(await screen.findByText(/关注操作失败: Error: db locked/)).toBeTruthy();
    expect(screen.getByText(RELEASE_V2)).toBeTruthy();
  });
});
