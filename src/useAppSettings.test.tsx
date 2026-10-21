/**
 * useAppSettings 持久化健壮性回归：
 * - 持久化失败不再 unhandled rejection：回滚乐观值 + toast；
 * - 成功后按后端归一口径回写 state（save_setting 只回 bool，前端镜像钳制）；
 * - 快照合并显式判空：合法挡位 `'0'`（TTL 实时校验档）不被 truthy 兜底吞成默认 60；
 * - 启动镜像回放失败/被拒：state 回滚 direct + 提示（后端 fail-closed 保持直连）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const saveSettingMock = vi.fn(async () => true);
const switchMirrorMock = vi.fn(async () => true);

vi.mock('./services/api', async () => {
  const actual = await vi.importActual<typeof import('./services/api')>('./services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'saveSetting') return saveSettingMock;
        if (prop === 'switchMirror') return switchMirrorMock;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useAppSettings } from './useAppSettings';
import { DEFAULT_SETTINGS } from './services/api';
import type { AppSettings } from './types';

interface CapturedToast {
  text: string;
  type: string;
}

let toasts: CapturedToast[] = [];
let toastListener: ((e: Event) => void) | null = null;

function captureToasts(): void {
  toasts = [];
  toastListener = (e: Event) => {
    toasts.push((e as CustomEvent).detail as CapturedToast);
  };
  window.addEventListener('zstore:toast', toastListener);
}

beforeEach(() => {
  saveSettingMock.mockClear().mockResolvedValue(true);
  switchMirrorMock.mockClear().mockResolvedValue(true);
  captureToasts();
});

afterEach(() => {
  if (toastListener) window.removeEventListener('zstore:toast', toastListener);
  toastListener = null;
});

describe('useAppSettings 持久化', () => {
  it("快照合并保留 '0' 实时校验挡位，不再吞成默认 60", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ detail_cache_ttl_minutes: '0' });
    });
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(0);
  });

  it("快照合并垃圾值仍回默认（NaN 防护不回退）", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ detail_cache_ttl_minutes: 'abc' });
    });
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(
      DEFAULT_SETTINGS.detail_cache_ttl_minutes,
    );
  });

  it('成功保存合法挡位 0：落库透传 0，state 保持 0', async () => {
    const { result } = renderHook(() => useAppSettings());
    await act(async () => {
      await result.current.handleUpdateSetting('detail_cache_ttl_minutes', 0);
    });
    expect(saveSettingMock).toHaveBeenCalledWith('detail_cache_ttl_minutes', '0');
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(0);
    expect(toasts).toHaveLength(0);
  });

  it('成功保存非法挡位 30：按后端归一口径回写为默认 60', async () => {
    const { result } = renderHook(() => useAppSettings());
    await act(async () => {
      await result.current.handleUpdateSetting('detail_cache_ttl_minutes', 30);
    });
    expect(saveSettingMock).toHaveBeenCalledWith('detail_cache_ttl_minutes', '30');
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(
      DEFAULT_SETTINGS.detail_cache_ttl_minutes,
    );
  });

  it('成功保存非法通知频率：归一回写 daily', async () => {
    const { result } = renderHook(() => useAppSettings());
    await act(async () => {
      await result.current.handleUpdateSetting(
        'watch_notify_frequency',
        'hourly' as unknown as AppSettings['watch_notify_frequency'],
      );
    });
    expect(result.current.settings.watch_notify_frequency).toBe('daily');
  });

  it('持久化失败：回滚乐观值 + error toast，不再 unhandled rejection', async () => {
    saveSettingMock.mockRejectedValueOnce(new Error('db locked'));
    const { result } = renderHook(() => useAppSettings());
    await act(async () => {
      await result.current.handleUpdateSetting('detail_cache_ttl_minutes', 0);
    });
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(
      DEFAULT_SETTINGS.detail_cache_ttl_minutes,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].text).toContain('db locked');
  });

  it('同键两笔在途写：前一笔失败不回滚后一笔的值', async () => {
    let rejectFirst: (e: Error) => void = () => {};
    saveSettingMock
      .mockImplementationOnce(
        () => new Promise<boolean>((_, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => useAppSettings());
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.handleUpdateSetting('detail_cache_ttl_minutes', 10);
      second = result.current.handleUpdateSetting('detail_cache_ttl_minutes', 360);
      rejectFirst(new Error('db locked'));
      await Promise.allSettled([first, second]);
    });
    expect(result.current.settings.detail_cache_ttl_minutes).toBe(360);
  });

  it('主题切换持久化失败：settings 与 data-theme 一起回滚', async () => {
    saveSettingMock.mockRejectedValueOnce(new Error('db locked'));
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ theme: 'dark' });
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    act(() => {
      result.current.handleToggleTheme();
    });
    await act(async () => {});
    expect(result.current.settings.theme).toBe('dark');
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(toasts).toHaveLength(1);
  });

  it('启动镜像回放被拒（resolve false）：state 回滚 direct + warning toast', async () => {
    switchMirrorMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ active_mirror: 'https://127.0.0.1.bad' });
    });
    await act(async () => {});
    expect(switchMirrorMock).toHaveBeenCalledWith('https://127.0.0.1.bad');
    expect(result.current.settings.active_mirror).toBe('direct');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('warning');
  });

  it('启动镜像回放 IPC 失败（reject）：state 回滚 direct + warning toast', async () => {
    switchMirrorMock.mockRejectedValueOnce(new Error('mirror offline'));
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ active_mirror: 'ghproxy' });
    });
    await act(async () => {});
    expect(result.current.settings.active_mirror).toBe('direct');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('warning');
    expect(toasts[0].text).toContain('mirror offline');
  });

  it('启动镜像回放成功：state 保持存量档位且无 toast', async () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.applyPersistedSettings({ active_mirror: 'ghproxy' });
    });
    await act(async () => {});
    expect(result.current.settings.active_mirror).toBe('ghproxy');
    expect(toasts).toHaveLength(0);
  });
});
