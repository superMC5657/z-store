import type { Window } from '@tauri-apps/api/window';
import { isTauri } from './api';

/**
 * 窗口控制唯一出口（TitleBar 三键 + ResizeHandles 边缘拖拽共用）：
 * `@tauri-apps/api/window` 禁在视图/组件层直用（noDirectInvoke 卡点），一律经此封装。
 * 失败原样抛出，浏览器/演示模式的降级语义由调用方 try/catch 自持（与迁移前一致）。
 */

/** 单一数据源派生自上游 `startResizeDragging` 函数签名
 * （`@tauri-apps/api/window@2.11.1` 未导出 `ResizeDirection`，
 * 直接 `import type { ResizeDirection }` 会导致 tsc 编译失败 —— 通过参数类型自动推导）。 */
export type WindowResizeDirection = Parameters<Window['startResizeDragging']>[0];

async function currentWindow(): Promise<Window> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export function minimizeWindow(): Promise<void> {
  return currentWindow().then((w) => w.minimize());
}

export function toggleMaximizeWindow(): Promise<void> {
  return currentWindow().then((w) => w.toggleMaximize());
}

export function isWindowMaximized(): Promise<boolean> {
  return currentWindow().then((w) => w.isMaximized());
}

export function closeWindow(): Promise<void> {
  return currentWindow().then((w) => w.close());
}

/**
 * 边缘拖拽调窗（ResizeHandles 专用语义）：非 Tauri 一律 no-op；
 * 最大化状态下忽略拖拽（还原后才能 resize），失败吞错保证永不回退。
 */
export async function startWindowResizeDragging(direction: WindowResizeDirection): Promise<void> {
  if (!isTauri) return;
  try {
    const w = await currentWindow();
    if (await w.isMaximized()) return;
    await w.startResizeDragging(direction);
  } catch {
    // 非 Tauri 演示模式 / WebView2 降级：空操作，确保永不回退。
  }
}
