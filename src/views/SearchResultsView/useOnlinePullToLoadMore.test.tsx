import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOnlinePullToLoadMore } from './useOnlinePullToLoadMore';

type IoEntry = { isIntersecting: boolean };

let ioCallbacks: Array<(entries: IoEntry[]) => void>;
let mountedDivs: HTMLElement[];

function stubIntersectionObserver() {
  ioCallbacks = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      callback: (entries: IoEntry[]) => void;
      constructor(callback: (entries: IoEntry[]) => void) {
        this.callback = callback;
        ioCallbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

function fireVisible(visible: boolean): void {
  act(() => {
    for (const cb of ioCallbacks) cb([{ isIntersecting: visible }]);
  });
}

function fireWheel(deltaY: number): void {
  let event: Event;
  try {
    event = new WheelEvent('wheel', { deltaY, bubbles: true });
  } catch {
    event = new Event('wheel', { bubbles: true });
    (event as unknown as { deltaY: number }).deltaY = deltaY;
  }
  window.dispatchEvent(event);
}

function fireTouchSwipe(startY: number, endY: number): void {
  const start = new Event('touchstart', { bubbles: true });
  (start as unknown as { touches: Array<{ clientY: number }> }).touches = [{ clientY: startY }];
  window.dispatchEvent(start);
  const move = new Event('touchmove', { bubbles: true });
  (move as unknown as { touches: Array<{ clientY: number }> }).touches = [{ clientY: endY }];
  window.dispatchEvent(move);
  window.dispatchEvent(new Event('touchend', { bubbles: true }));
}

let now = 1_000_000;

beforeEach(() => {
  stubIntersectionObserver();
  mountedDivs = [];
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  for (const div of mountedDivs) div.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface HookProps {
  enabled: boolean;
  loading: boolean;
  onLoadMore?: () => void;
}

function mountHook(props: HookProps) {
  const hook = renderHook((p: HookProps) => useOnlinePullToLoadMore(p), { initialProps: props });
  const div = document.createElement('div');
  document.body.appendChild(div);
  mountedDivs.push(div);
  act(() => {
    hook.result.current(div);
  });
  return hook;
}

describe('useOnlinePullToLoadMore', () => {
  it('wheel down at the bottom triggers exactly one page per gesture burst', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireVisible(true);
    fireWheel(120);
    fireWheel(120);
    fireWheel(120);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // 冷静过后再拉才续下一页。
    now += 1200;
    fireWheel(120);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('does not trigger before the armed boundary becomes visible', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
    fireVisible(false);
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('does not trigger while loading; retry works after loading settles', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: true, onLoadMore });
    fireVisible(true);
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.rerender({ enabled: true, loading: false, onLoadMore });
    fireWheel(120);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('does not trigger when there is no next page', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: false, loading: false, onLoadMore });
    fireVisible(true);
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('ignores wheel up and zero-delta wheel', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireVisible(true);
    fireWheel(-120);
    fireWheel(0);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('touch upward swipe across the boundary triggers; small swipes do not', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireVisible(true);
    fireTouchSwipe(300, 200);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    now += 1200;
    fireTouchSwipe(300, 280);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('touch swipe does nothing while loading', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: true, onLoadMore });
    fireVisible(true);
    fireTouchSwipe(300, 100);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('stops listening after unmount', () => {
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireVisible(true);
    hook.unmount();
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('without IntersectionObserver the gesture never fires (button remains the fallback)', () => {
    vi.unstubAllGlobals();
    const onLoadMore = vi.fn();
    const hook = mountHook({ enabled: true, loading: false, onLoadMore });
    fireWheel(120);
    expect(onLoadMore).not.toHaveBeenCalled();
    hook.unmount();
  });
});
