import React, { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useViewScrollMemory } from './useViewScrollMemory';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** jsdom 不做布局：用可写的 scrollHeight/clientHeight 模拟内容高度，scrollTop 按其钳制。 */
function makeScrollable(el: HTMLElement, contentHeight: { value: number }) {
  let top = 0;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => contentHeight.value });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, contentHeight.value - 100));
    },
  });
}

const Shell: React.FC<{ viewKey: string | null; onMount: (el: HTMLElement) => void }> = ({ viewKey, onMount }) => {
  const ref = useRef<HTMLElement>(null);
  useViewScrollMemory(ref, viewKey);
  return (
    <main
      ref={(el) => {
        (ref as React.MutableRefObject<HTMLElement | null>).current = el;
        if (el && !el.dataset.ready) {
          el.dataset.ready = '1';
          onMount(el);
        }
      }}
    />
  );
};

function setup(initialKey: string | null, height = 2000) {
  const content = { value: height };
  let main!: HTMLElement;
  const utils = render(<Shell viewKey={initialKey} onMount={(el) => { main = el; makeScrollable(el, content); }} />);
  const scrollTo = (top: number) => {
    main.scrollTop = top;
    fireEvent.scroll(main);
  };
  const switchTo = (key: string | null) => utils.rerender(<Shell viewKey={key} onMount={() => {}} />);
  return { main: () => main, content, scrollTo, switchTo };
}

describe('useViewScrollMemory', () => {
  it('restores each view’s own position and starts unseen views at the top', () => {
    const s = setup('home');
    s.scrollTo(600);
    s.switchTo('trends');
    expect(s.main().scrollTop).toBe(0);
    s.scrollTo(150);
    s.switchTo('home');
    expect(s.main().scrollTop).toBe(600);
    s.switchTo('trends');
    expect(s.main().scrollTop).toBe(150);
  });

  it('resets to top and does not remember while the key is null', () => {
    const s = setup('home');
    s.scrollTo(400);
    s.switchTo(null);
    expect(s.main().scrollTop).toBe(0);
    s.scrollTo(300);
    s.switchTo('home');
    expect(s.main().scrollTop).toBe(400);
  });

  it('keeps retrying while async content grows, then stops at the target', () => {
    vi.useFakeTimers();
    const s = setup('home');
    s.scrollTo(900);
    s.switchTo('trends');
    s.content.value = 300;
    s.switchTo('home');
    expect(s.main().scrollTop).toBe(200);
    s.content.value = 2000;
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(s.main().scrollTop).toBe(900);
  });

  it('gives up restoring once something else moves the scroll position', () => {
    vi.useFakeTimers();
    const s = setup('home');
    s.scrollTo(900);
    s.switchTo('trends');
    s.content.value = 300;
    s.switchTo('home');
    s.main().scrollTop = 50;
    s.content.value = 2000;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(s.main().scrollTop).toBe(50);
  });
});
