import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReportPlatformCounts } from './useReportPlatformCounts';
import type { PlatformCounts } from '../selectors';

const COUNTS_A: PlatformCounts = {
  windows: 2,
  macos: 1,
  linux: 0,
  android: 0,
  ios: 0,
  other: 0,
};

const COUNTS_B: PlatformCounts = {
  windows: 0,
  macos: 3,
  linux: 1,
  android: 0,
  ios: 0,
  other: 0,
};

describe('useReportPlatformCounts', () => {
  it('默认跳过 null 且不在卸载时复位', () => {
    const onReport = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ counts }: { counts: PlatformCounts | null }) => useReportPlatformCounts(counts, onReport),
      { initialProps: { counts: null as PlatformCounts | null } },
    );

    expect(onReport).not.toHaveBeenCalled();

    rerender({ counts: COUNTS_A });
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenLastCalledWith(COUNTS_A);

    rerender({ counts: null });
    expect(onReport).toHaveBeenCalledTimes(1);

    unmount();
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('支持 reportNull 与 resetOnUnmount，且回调引用变更不触发虚假复位', () => {
    const onReport1 = vi.fn();
    const onReport2 = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ counts, cb }: { counts: PlatformCounts | null; cb: (c: PlatformCounts | null) => void }) =>
        useReportPlatformCounts(counts, cb, { reportNull: true, resetOnUnmount: true }),
      { initialProps: { counts: null as PlatformCounts | null, cb: onReport1 } },
    );

    expect(onReport1).toHaveBeenCalledTimes(1);
    expect(onReport1).toHaveBeenLastCalledWith(null);

    rerender({ counts: COUNTS_B, cb: onReport2 });
    expect(onReport1).toHaveBeenCalledTimes(1);
    expect(onReport2).toHaveBeenCalledTimes(1);
    expect(onReport2).toHaveBeenLastCalledWith(COUNTS_B);

    unmount();
    expect(onReport2).toHaveBeenCalledTimes(2);
    expect(onReport2).toHaveBeenLastCalledWith(null);
  });
});
