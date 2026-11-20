import React from 'react';
import { isTauri } from '../services/api';
import { startWindowResizeDragging, type WindowResizeDirection } from '../services/desktop';

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
 * 无边框窗口全边缘缩放手柄（仅 Tauri 桌面端渲染；顶部边缘有意优先于标题栏双击最大化）。
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
