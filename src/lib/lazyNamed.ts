import React from 'react';

/**
 * 按具名导出懒加载组件，并附带 `preload()`：空闲时预取分块，首次打开不必等待解析。
 * 加载失败（分块缺失）时清掉缓存的 Promise，下次渲染或预取会重新发起。
 */
export function lazyNamed<M extends Record<K, React.ComponentType<any>>, K extends keyof M>(
  loader: () => Promise<M>,
  name: K,
): React.LazyExoticComponent<M[K]> & { preload: () => Promise<M> } {
  let pending: Promise<M> | null = null;
  const preload = (): Promise<M> => {
    if (!pending) {
      pending = loader().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
  const component = React.lazy(() => preload().then((m) => ({ default: m[name] })));
  return Object.assign(component, { preload });
}

/** 浏览器空闲时执行（无 `requestIdleCallback` 时退化为短延时）；返回取消函数。 */
export function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(task, 1500);
  return () => window.clearTimeout(timer);
}
