import { useEffect, useRef, type RefObject } from 'react';

/**
 * 打开中的模态弹窗栈（按打开先后入栈）。Esc 与 Tab 焦点陷阱只作用于栈顶，
 * 叠放的弹窗（讨论 → 详情 → 安装确认）因此一次只关最上层。
 */
const openModalStack: symbol[] = [];

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
 * 模态弹窗的键盘与焦点约定：
 * - 打开时把焦点移入弹窗容器（容器需 `tabIndex={-1}`），关闭时归还给打开前的焦点元素；
 * - Tab / Shift+Tab 在弹窗内循环，不落到背后的页面；
 * - Esc 只关闭栈顶弹窗。弹窗内部控件若自行处理 Esc（收起浮层等），
 *   调用 `preventDefault()` 或 `stopPropagation()` 即可截留；输入法组字中的 Esc 不处理。
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  { open = true, onEscape }: ModalA11yOptions = {},
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('modal');
    openModalStack.push(token);
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
      const index = openModalStack.indexOf(token);
      if (index !== -1) openModalStack.splice(index, 1);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, containerRef]);
}
