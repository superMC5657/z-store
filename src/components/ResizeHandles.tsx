import React from 'react';
import { isTauri } from '../services/api';
import { startWindowResizeDragging, type WindowResizeDirection } from '../services/window';

interface HandleDef {
  direction: WindowResizeDirection;
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
            void startWindowResizeDragging(direction);
          }}
          onTouchStart={() => void startWindowResizeDragging(direction)}
        />
      ))}
    </>
  );
};
