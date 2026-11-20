/** 返回脚本触发滚动的 `ScrollBehavior`（CSS reduced-motion 规则管不到显式 `scrollIntoView` 参数）。 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
