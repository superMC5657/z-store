/** 测试 `useWatchState` 的关注订阅加载、实时提醒与卸载解绑。 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchDismissedEntry, WatchUpdatedPayload } from '../../types';

const subs = vi.hoisted(() => {
  type Listener = (payload: WatchUpdatedPayload) => void;
  const listeners = new Set<Listener>();
  const on = vi.fn((cb: Listener): Promise<() => void> => {
    listeners.add(cb);
    return Promise.resolve(() => {
      listeners.delete(cb);
    });
  });
  return {
    on,
    emit: (p: WatchUpdatedPayload): void => {
      for (const cb of [...listeners]) cb(p);
    },
    size: (): number => listeners.size,
    clear: (): void => listeners.clear(),
  };
});

const mocks = vi.hoisted(() => ({
  getWatchedApps: vi.fn(async () => [] as { app_id: string }[]),
  getWatchNotifications: vi.fn(async () => [] as WatchUpdatedPayload[]),
  getDismissedWatchNotifications: vi.fn(async () => [] as WatchDismissedEntry[]),
  watchApp: vi.fn(async () => {}),
  unwatchApp: vi.fn(async () => {}),
  checkWatchedUpdates: vi.fn(async () => [] as WatchUpdatedPayload[]),
  dismissWatchNotification: vi.fn(async () => true),
  restoreWatchNotification: vi.fn(async () => true),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        const table: Record<string, unknown> = {
          getWatchedApps: mocks.getWatchedApps,
          getWatchNotifications: mocks.getWatchNotifications,
          getDismissedWatchNotifications: mocks.getDismissedWatchNotifications,
          watchApp: mocks.watchApp,
          unwatchApp: mocks.unwatchApp,
          checkWatchedUpdates: mocks.checkWatchedUpdates,
          dismissWatchNotification: mocks.dismissWatchNotification,
          restoreWatchNotification: mocks.restoreWatchNotification,
          onWatchUpdated: subs.on,
        };
        if (prop in table) return table[prop as string];
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useWatchState } from './useWatchState';

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWatch(isRulesModalOpen = false) {
  const showToast = vi.fn();
  const t = ((key: string, opts?: Record<string, unknown>) =>
    `${key}${opts ? ` ${JSON.stringify(opts)}` : ''}`) as never;
  const rendered = renderHook(
    ({ open }: { open: boolean }) => useWatchState({ isRulesModalOpen: open, showToast, t }),
    { initialProps: { open: isRulesModalOpen } },
  );
  return { rendered, showToast };
}

beforeEach(() => {
  vi.clearAllMocks();
  subs.clear();
  mocks.getWatchedApps.mockResolvedValue([]);
  mocks.getWatchNotifications.mockResolvedValue([]);
  mocks.getDismissedWatchNotifications.mockResolvedValue([]);
});

describe('useWatchState：关注集与提醒流', () => {
  it('初始加载关注集、实时提醒去重与已读互斥', async () => {
    mocks.getWatchedApps.mockResolvedValue([{ app_id: 'acme/atlas' }]);
    mocks.getDismissedWatchNotifications.mockResolvedValue([
      { app_id: 'acme/atlas', version: '1.0.0', dismissed_at: 100 },
      { app_id: 'beta/bravo', version: '1.0.0', dismissed_at: 100 },
    ]);
    const { rendered, showToast } = renderWatch();
    await flush();
    expect(rendered.result.current.watchedIds).toEqual(new Set(['acme/atlas']));
    expect(rendered.result.current.activeDismissedWatches).toHaveLength(2);

    const payload = { app_id: 'acme/atlas', version: '2.0.0', app_name: 'Atlas' };
    await act(async () => {
      subs.emit(payload);
      subs.emit({ ...payload, version: '2.1.0' });
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('toast.watch_update_released'), 'info');
    expect(rendered.result.current.watchNotifications).toHaveLength(1);
    expect(rendered.result.current.watchNotifications[0].version).toBe('2.1.0');
    expect(rendered.result.current.activeDismissedWatches.map((d) => d.app_id)).toEqual(['beta/bravo']);
  });

  it('zstore:data-imported 重载关注集；卸载后迟到订阅立即解绑', async () => {
    mocks.getWatchedApps
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ app_id: 'beta/bravo' }]);
    const { rendered } = renderWatch();
    await flush();

    mocks.getWatchedApps.mockResolvedValue([{ app_id: 'beta/bravo' }]);
    await act(async () => {
      window.dispatchEvent(new Event('zstore:data-imported'));
    });
    await waitFor(() => {
      expect(rendered.result.current.watchedIds).toEqual(new Set(['beta/bravo']));
    });
    rendered.unmount();

    let releaseUnlisten: ((fn: () => void) => void) | undefined;
    const unlisten = vi.fn();
    subs.on.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          releaseUnlisten = resolve;
        }),
    );
    const late = renderWatch();
    late.rendered.unmount();
    await act(async () => {
      releaseUnlisten?.(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
