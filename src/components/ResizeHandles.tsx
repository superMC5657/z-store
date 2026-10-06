import React from 'react';
import type { Window } from '@tauri-apps/api/window';
import { isTauri } from '../services/api';

// 单一数据源派生自上游 `startResizeDragging` 函数签名
// （`@tauri-apps/api/window@2.11.1` 未导出 `ResizeDirection`，
// 直接 `import type { ResizeDirection }` 会导致 tsc 编译失败 —— 此处通过参数类型自动推导）。
type ResizeDirection = Parameters<Window['startResizeDragging']>[0];

interface HandleDef {
  direction: ResizeDirection;
  className: string;
}

const HANDLES: readonly HandleDef[] = [
  { direction: 'North', className: 'resize-n' },
  { direction: 'South', className: 'resize-s' },
  { direction: 'East', className: 'resize-e' },
  { direction: 'West', className: 'resize-w' },
  { direction: 'NorthEast', className: 'resize-ne' },
  { direction: 'NorthWest', className: 'resize-nw' },
  { direction: 'SouthEast', className: 'resize-se' },
  { direction: 'SouthWest', className: 'resize-sw' },
];

async function beginResize(direction: ResizeDirection): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    if (await getCurrentWindow().isMaximized()) return;
    await getCurrentWindow().startResizeDragging(direction);
  } catch {
    // 非 Tauri 演示模式 / WebView2 降级：空操作，确保永不回退。
  }
}

/**
 * 无边框全边缘调整大小支持（Ubuntu Wayland/X11）。
 * 在 `.app-window` 内部放置 8 个隐形边缘/角落区域；
 * 标题栏保持仅移动拖拽，且其 `data-tauri-drag-region="false"`
 * 隔离区域（窗口控制按钮 / 搜索框）继续正常工作 —— 缩放手柄仅占用最外层
 * 8px 边缘与 12px 角落。在 Tauri 环境之外为 no-op（不渲染任何内容），
 * 确保浏览器/演示模式永不退化。
 * 注意：顶部 8px 区域有意优先于标题栏双击最大化（贴合操作系统原生边框交互逻辑）；
 * 东侧（E）手柄与滚动条重叠属预期内表现（滚轮事件不受影响）。
 */
export const ResizeHandles: React.FC = () => {
  if (!isTauri) return null;
  return (
    <>
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={`resize-handle ${className}`}
          aria-hidden="true"
          onMouseDown={(e) => {
            if (e.buttons !== 1) return;
            e.preventDefault();
            void beginResize(direction);
          }}
          onTouchStart={() => void beginResize(direction)}
        />
      ))}
    </>
  );
};
