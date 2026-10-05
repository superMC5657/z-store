import React from 'react';
import type { Window } from '@tauri-apps/api/window';
import { isTauri } from '../services/api';

// Single-sourced from the upstream `startResizeDragging` signature
// (`ResizeDirection` is not exported from `@tauri-apps/api/window@2.11.1`,
// so a direct `import type { ResizeDirection }` fails tsc — this derives it).
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
    // Non-Tauri demo / WebView2 fallback: no-op, never regress.
  }
}

/**
 * Frameless all-edge resize affordances (Ubuntu Wayland/X11).
 * Eight invisible edge/corner zones positioned inside `.app-window`; the
 * titlebar keeps move-only drag and its `data-tauri-drag-region="false"`
 * islands (win-controls / search) keep working — handles own only the extreme
 * 8px edges / 12px corners. No-op (renders nothing) outside Tauri so the
 * browser/demo path never regresses.
 * Note: top-8px strip intentionally wins over titlebar dblclick-maximize (OS-native border behavior); E-handle/scrollbar overlap is accepted (wheel unaffected).
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
