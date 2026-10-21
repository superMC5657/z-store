import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTransientFeedback } from './useTransientFeedback';

afterEach(() => {
  vi.useRealTimers();
});

describe('useTransientFeedback', () => {
  it('到期自动清空文案', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFeedback(5000));
    act(() => {
      result.current.show('ok', false);
    });
    expect(result.current.text).toBe('ok');
    expect(result.current.isError).toBe(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.text).toBeNull();
  });

  it('卸载清除定时器，卸载后不再更新状态', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTransientFeedback(5000));
    act(() => {
      result.current.show('ok', true);
    });
    expect(result.current.isError).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('新文案替换旧定时器，只保留一个', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFeedback(5000));
    act(() => {
      result.current.show('first', false);
      result.current.show('second', false);
    });
    expect(result.current.text).toBe('second');
    expect(vi.getTimerCount()).toBe(1);
  });
});
