/**
 * 脚本触发的滚动行为：系统偏好减弱动态效果时用瞬时滚动。
 * CSS 的全局 reduced-motion 规则（utilities-a11y.css）管不到 `scrollIntoView({ behavior })` 显式参数，需在调用处判定。
 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
