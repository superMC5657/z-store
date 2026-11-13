import { useCallback, useEffect, useRef } from 'react';

/**
 * 在线搜索段「亮边界 + 越界续拉」触发器。
 *
 * 在线搜索列表到底时不自动拉下一页：`armed` 边界条（`online-armed`）先亮出，
 * 用户在列表底部继续下拉（桌面滚轮下滚 / 触摸手指上滑越界）才真正调一次
 * `onLoadMore`（续 1 页 20 个）。按钮点击走同一回调（键盘/拖滚动条用户兜底）。
 *
 * 门控（缺一即不触发；失败/加载中不重复触发，冷静过后可再拉重试）：
 * - `enabled`：在线段还有下一页（`onlineActive`）；
 * - `loading`：首屏搜索中或翻页中；
 * - armed 条可见（用户已真实到达底部；短列表首绘即见仍需一次下拉手势）；
 * - 滚动容器已在底部（`scrollHeight - scrollTop - clientHeight <= 8`）；
 * - 触发后 1000ms 冷静窗：一次手势只续一页。
 *
 * 发现页/类别/趋势的哨兵自动续刷一律不动（见 `useHomeFeed` 注释）。
 */
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
