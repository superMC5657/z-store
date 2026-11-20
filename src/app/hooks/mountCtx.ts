import { useRef, type MutableRefObject } from 'react';

/** 异步订阅挂载上下文：收集 `unlisten`，卸载后迟到 resolve 的订阅立即解绑。 */
export interface MountCtx {
  mounted: boolean;
  cleanups: Array<() => void>;
}

/** 将回调/最新值镜像到稳定 ref，供长期订阅/异步闭包无陈旧读读取。 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function newMountCtx(): MountCtx {
  return { mounted: true, cleanups: [] };
}

export function releaseMountCtx(ctx: MountCtx): void {
  ctx.mounted = false;
  for (const fn of ctx.cleanups) {
    try {
      fn();
    } catch {
      // 清理幂等，忽略二次解绑异常
    }
  }
  ctx.cleanups.length = 0;
}

/** 登记 `window` 事件监听并纳入 `MountCtx` 统一卸载清理。 */
export function listenWindowEvent(
  ctx: MountCtx,
  type: string,
  listener: EventListener,
): void {
  window.addEventListener(type, listener);
  ctx.cleanups.push(() => {
    window.removeEventListener(type, listener);
  });
}

/** 登记订阅并在卸载后自动解绑迟到的异步结果。 */
export function trackSubscription(ctx: MountCtx, promise: Promise<() => void>): void {
  promise
    .then((unlisten) => {
      if (ctx.mounted) {
        ctx.cleanups.push(unlisten);
      } else {
        try {
          unlisten();
        } catch {
          // 迟到解绑忽略异常
        }
      }
    })
    .catch(() => {});
}
