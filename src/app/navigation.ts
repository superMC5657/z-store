/**
 * 集中导航入口（App 内视图切换唯一收口）：
 * - `VIEW_TYPES` 是合法视图唯一清单（Sidebar 项/深链校验/类型收口共用）；
 * - `navigate(view)` 内聚合法性校验：非法视图一律拒绝（不回落 home，
 *   与拆分前深链侧静默忽略同语义），合法才落 `setCurrentView`。
 */
import type { ViewType } from '../types';

/** 全部合法视图（与 types.ts 的 ViewType 联合逐一对应）。 */
export const VIEW_TYPES = [
  'home',
  'trends',
  'categories',
  'pending',
  'installed',
  'updates',
  'favorites',
  'settings',
] as const;

/** 运行时守卫：未知值（深链载荷/URL 参数等）判定为非法视图。 */
export function isViewType(value: unknown): value is ViewType {
  return typeof value === 'string' && (VIEW_TYPES as readonly string[]).includes(value);
}

/** 集中导航函数签名：入参放宽为 unknown，由实现内部校验。 */
export type Navigate = (view: unknown) => void;

/** 以 App 持有的 setCurrentView 构造集中导航入口。 */
export function createNavigate(setCurrentView: (view: ViewType) => void): Navigate {
  return (view) => {
    if (!isViewType(view)) return;
    setCurrentView(view);
  };
}
