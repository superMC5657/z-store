import { useCallback, useEffect, useRef } from 'react';

/** 到达列表底部后通过继续下拉或上滑越界手势触发 `onLoadMore`（带冷却防连发）。 */
interface OnlinePullToLoadMoreOptions {
  enabled: boolean;
  loading: boolean;
  onLoadMore?: () => void;
}

const BOTTOM_SLOP_PX = 8;
const WHEEL_DOWN_PX = 4;
const TOUCH_UP_PX = 48;
const COOLDOWN_MS = 1000;

function findScroller(el: HTMLElement | null): HTMLElement | Window {
  const scroller = el?.closest?.('.content-area');
  if (scroller instanceof HTMLElement) return scroller;
  return window;
}

function isAtBottom(scroller: HTMLElement | Window): boolean {
  if (scroller instanceof HTMLElement) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_SLOP_PX;
  }
  const doc = document.documentElement;
  const scrollTop = window.scrollY || doc.scrollTop || 0;
  const viewport = window.innerHeight || doc.clientHeight || 0;
  return doc.scrollHeight - scrollTop - viewport <= BOTTOM_SLOP_PX;
}

function readFirstTouch(touches: TouchList | null | undefined): { clientY: number } | undefined {
  if (!touches) return undefined;
  try {
    if (typeof touches.item === 'function') {
      const viaItem = touches.item(0);
      if (viaItem) return viaItem;
    }
  } catch {
    //  synthetic 事件对象无 item 方法时走下标读取
  }
  return (touches as unknown as Array<{ clientY: number }>)[0];
}

/** 绑定到 `online-armed` 边界条：返回 ref 回调，挂载即开始「到达底部」可见性跟踪。 */
export function useOnlinePullToLoadMore({ enabled, loading, onLoadMore }: OnlinePullToLoadMoreOptions) {
  const armedElRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const coolUntilRef = useRef(0);
  const stateRef = useRef({ enabled, loading, onLoadMore });
  stateRef.current = { enabled, loading, onLoadMore };

  const setArmedRef = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    armedElRef.current = el;
    visibleRef.current = false;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  useEffect(() => {
    const tryFire = (): void => {
      const s = stateRef.current;
      if (!s.enabled || s.loading || !s.onLoadMore) return;
      if (!visibleRef.current) return;
      if (!isAtBottom(findScroller(armedElRef.current))) return;
      const now = Date.now();
      if (now < coolUntilRef.current) return;
      coolUntilRef.current = now + COOLDOWN_MS;
      s.onLoadMore();
    };
    const onWheel = (e: WheelEvent): void => {
      // 只响应继续下拉（deltaY>0）；上滚/横滚/无位移一律忽略。
      if (e.deltaY <= WHEEL_DOWN_PX) return;
      tryFire();
    };
    const onTouchStart = (e: TouchEvent): void => {
      const first = readFirstTouch(e.touches);
      touchStartYRef.current = first ? first.clientY : null;
    };
    const onTouchMove = (e: TouchEvent): void => {
      const first = readFirstTouch(e.touches);
      const startY = touchStartYRef.current;
      if (!first || startY === null) return;
      // 手指上滑（内容下拉方向）越界 TOUCH_UP_PX 才算续拉意图。
      if (startY - first.clientY < TOUCH_UP_PX) return;
      tryFire();
    };
    const onTouchEnd = (): void => {
      touchStartYRef.current = null;
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return setArmedRef;
}
