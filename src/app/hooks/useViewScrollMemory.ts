import { useLayoutEffect, useRef, type RefObject } from 'react';

/** 恢复滚动位置时，等待异步内容撑开高度的最长时间。 */
const RESTORE_TIMEOUT_MS = 2000;

const nextFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => window.setTimeout(cb, 16);
const cancelFrame: (id: number) => void =
  typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => window.clearTimeout(id);

/**
 * 按视图记住滚动位置并在切回时恢复（逐帧等待异步内容撑开高度，若期间被外部改动则放弃）。
 * `key` 为 `null` 时表示不记忆的临时视图，进入时回到顶部。
 */
export function useViewScrollMemory(scrollRef: RefObject<HTMLElement | null>, key: string | null): void {
  const positions = useRef(new Map<string, number>());
  const activeKey = useRef<string | null>(key);
  const restoring = useRef(false);

  // 在切换视图的这次渲染里读取旧视图的位置：提交阶段旧内容已被替换、scrollTop 可能已被钳制。
  // 恢复尚未完成时保留原目标，不用半途的位置覆盖。
  if (key !== activeKey.current) {
    const el = scrollRef.current;
    const previous = activeKey.current;
    if (el && previous !== null && !restoring.current) positions.current.set(previous, el.scrollTop);
  }

  useLayoutEffect(() => {
    activeKey.current = key;
    const el = scrollRef.current;
    if (!el) return;
    const target = key === null ? 0 : positions.current.get(key) ?? 0;
    el.scrollTop = target;
    if (el.scrollTop >= target - 1) return;

    restoring.current = true;
    let lastSeen = el.scrollTop;
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    let frame = 0;
    const finish = () => {
      restoring.current = false;
      cancelFrame(frame);
      if (key !== null) positions.current.set(key, el.scrollTop);
    };
    const step = () => {
      if (Math.abs(el.scrollTop - lastSeen) > 1 || Date.now() > deadline) {
        finish();
        return;
      }
      el.scrollTop = target;
      lastSeen = el.scrollTop;
      if (lastSeen >= target - 1) {
        finish();
        return;
      }
      frame = nextFrame(step);
    };
    frame = nextFrame(step);
    return () => {
      restoring.current = false;
      cancelFrame(frame);
    };
  }, [scrollRef, key]);
}
