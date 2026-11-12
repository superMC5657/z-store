import type { Window } from '@tauri-apps/api/window';
import { isTauri, tauriInvokePlugin } from './api/client';

/**
 * 桌面原生窗口与进程控制唯一出口（TitleBar / ResizeHandles / ClientUpdateRow 共用）：
 * `@tauri-apps/api/window` 与原生进程插件禁在视图/组件层直用（`noDirectInvoke` 卡点）。
 */

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

/** 边缘拖拽调窗：非 Tauri 或最大化状态一律 no-op，失败吞错确保演示模式稳定。 */
export async function startWindowResizeDragging(direction: WindowResizeDirection): Promise<void> {
  if (!isTauri) return;
  try {
    const w = await currentWindow();
    if (await w.isMaximized()) return;
    await w.startResizeDragging(direction);
  } catch {
    // 非 Tauri 演示模式 / WebView2 降级：空操作。
  }
}

/** 客户端自更新完成后的进程重启（官方 `plugin:process|restart`，未启用时由调用方提示手动重启）。 */
export async function restartApp(): Promise<void> {
  await tauriInvokePlugin('plugin:process|restart');
}
