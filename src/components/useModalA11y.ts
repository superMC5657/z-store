import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** 打开中的模态弹窗栈，用于确保 Esc、Tab 焦点陷阱与视觉层叠顺序一致。 */
const openModalStack: symbol[] = [];
const stackListeners = new Set<() => void>();

function notifyStackListeners(): void {
  for (const listener of stackListeners) {
    listener();
  }
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

interface ModalA11yOptions {
  /** 弹窗是否打开；常驻挂载、靠 `isOpen` 控制显隐的弹窗必须传入。 */
  open?: boolean;
  /** 栈顶时按 Esc 调用；不传则 Esc 不关闭（如导入进行中）。 */
  onEscape?: () => void;
}

/**
 * 模态弹窗键盘与焦点管理：打开时聚焦容器、关闭时归还焦点、循环 Tab 并仅对栈顶处理 Esc。
 * 返回该弹窗在 `openModalStack` 中的 0-based 位置（未打开时返回 -1），供外壳计算同层 z-index。
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  { open = true, onEscape }: ModalA11yOptions = {},
): number {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const [stackIndex, setStackIndex] = useState<number>(() => (open ? openModalStack.length : -1));

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setStackIndex(-1);
      return;
    }
    const token = Symbol('modal');
    const syncIndex = () => {
      setStackIndex(openModalStack.indexOf(token));
    };
    openModalStack.push(token);
    stackListeners.add(syncIndex);
    notifyStackListeners();
    const isTop = () => openModalStack[openModalStack.length - 1] === token;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      container.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      const root = containerRef.current;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || e.isComposing) return;
        const handler = onEscapeRef.current;
        if (!handler) return;
        e.preventDefault();
        handler();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = focusableWithin(root);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const outside = !root.contains(active);
      if (e.shiftKey && (outside || active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stackListeners.delete(syncIndex);
      const index = openModalStack.indexOf(token);
      if (index !== -1) openModalStack.splice(index, 1);
      notifyStackListeners();
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, containerRef]);

  return stackIndex;
}
