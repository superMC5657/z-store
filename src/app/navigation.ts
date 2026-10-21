/**
 * 集中导航入口（App 内视图切换唯一收口）：
 * - `VIEW_TYPES` 是合法视图唯一清单（Sidebar 项/深链校验/类型收口共用），
 *   `ViewType` 由该清单推导，`types` 侧仅 re-export（既有 import 路径不变）；
 * - `navigate(view)` 入参收窄为 `ViewType`：外部载荷（深链/URL）须先经
 *   `isViewType` 收窄再调用。
 */
/**
 * 全部合法视图，顺序即侧栏渲染顺序。
 */
export const VIEW_TYPES = [
  'home',
  'categories',
  'trends',
  'pending',
  'installed',
  'updates',
  'favorites',
  'settings',
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

/** 运行时守卫：未知值（深链载荷/URL 参数等）判定为非法视图。 */
export function isViewType(value: unknown): value is ViewType {
  return typeof value === 'string' && (VIEW_TYPES as readonly string[]).includes(value);
}

/** 集中导航函数签名：编译期仅接受合法视图。 */
export type Navigate = (view: ViewType) => void;

/** 以 App 持有的 setCurrentView 构造集中导航入口。 */
export function createNavigate(setCurrentView: (view: ViewType) => void): Navigate {
  return (view) => {
    // 类型已收窄，运行时仍守一道：绕过类型系统的调用方不得写入非法视图。
    if (!isViewType(view)) return;
    setCurrentView(view);
  };
}
