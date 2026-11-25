import React, { useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalA11y } from './useModalA11y';

/** 弹窗叠放层级（对应 `components-modal.css` 修饰类：`sub < base < confirm < top`）。 */
export type ModalLayer = 'sub' | 'base' | 'confirm' | 'top';

const LAYER_CLASS: Record<ModalLayer, string | null> = {
  sub: 'modal-layer-sub',
  base: null,
  confirm: 'modal-layer-confirm',
  top: 'modal-layer-top',
};

/** 与 `components-modal.css` 层级基线对齐，同层按 `openModalStack` 顺序递增，保证后开弹窗视觉置顶且不越层。 */
const LAYER_Z_RANGE: Record<ModalLayer, { base: number; maxOffset: number }> = {
  sub: { base: 90, maxOffset: 9 },
  base: { base: 100, maxOffset: 99 },
  confirm: { base: 200, maxOffset: 799 },
  top: { base: 1000, maxOffset: 8998 },
};

export interface ModalShellProps {
  layer?: ModalLayer;
  /** 为 `false` 时点击遮罩不关闭（如导入进行中）。 */
  closeOnBackdrop?: boolean;
  /** 遮罩点击关闭；未传 `onEscape` 时也作为 Esc 行为。 */
  onClose?: () => void;
  /** 覆盖 Esc 行为（如先收起内部浮层）；与 `onClose` 均未传时 Esc 不响应。 */
  onEscape?: () => void;
  backdropClassName?: string;
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  panelRef?: React.Ref<HTMLDivElement>;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: React.ReactNode;
}

/** `.app-window` 是整窗层叠上下文：挂在这里才能盖住标题栏并继承 `--app-zoom`。 */
function findAppWindow(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('.app-window');
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as React.MutableRefObject<T | null>).current = value;
}

/** 全站模态弹窗外壳：Portal 至 `.app-window`，提供层级控制、遮罩关闭与无障碍焦点管理。 */
export const ModalShell: React.FC<ModalShellProps> = ({
  layer = 'base',
  closeOnBackdrop = true,
  onClose,
  onEscape,
  backdropClassName,
  panelClassName,
  panelStyle,
  panelRef,
  ariaLabel,
  ariaLabelledBy,
  children,
}) => {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const mouseDownOnBackdropRef = useRef(false);

  const panelRefRef = useRef(panelRef);
  panelRefRef.current = panelRef;
  const setPanel = useCallback((node: HTMLDivElement | null) => {
    internalRef.current = node;
    assignRef(panelRefRef.current, node);
  }, []);

  const stackIndex = useModalA11y(internalRef, { open: true, onEscape: onEscape ?? onClose });
  const { base: layerBaseZ, maxOffset: layerMaxOffset } = LAYER_Z_RANGE[layer];
  const backdropZIndex = layerBaseZ + Math.min(Math.max(stackIndex, 0), layerMaxOffset);

  // 每次挂载时解析一次挂载点，打开期间保持不变，避免挂载点切换导致子树重挂。
  const portalTarget = useMemo(() => findAppWindow(), []);

  const backdropClass = ['modal-backdrop', LAYER_CLASS[layer], backdropClassName].filter(Boolean).join(' ');
  const panelClass = ['detail-modal', panelClassName].filter(Boolean).join(' ');

  const shell = (
    <div
      className={backdropClass}
      style={{ zIndex: backdropZIndex }}
      onMouseDown={(e) => {
        mouseDownOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // 只有按下与松开都落在遮罩本身才关闭：在面板里拖选文本松手到遮罩上不算。
        const pressedOnBackdrop = mouseDownOnBackdropRef.current;
        mouseDownOnBackdropRef.current = false;
        if (closeOnBackdrop && pressedOnBackdrop && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={setPanel}
        className={panelClass}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );

  return portalTarget ? createPortal(shell, portalTarget) : shell;
};
