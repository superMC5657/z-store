import type React from 'react';

/** 行内自带交互的元素：点击它们不触发整行打开。 */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, [role="button"], [role="menu"], [role="menuitem"], [contenteditable="true"], [data-row-click-ignore]';

/**
 * 管理列表行的整行点击：点在行内空白或文字上即调用 `open`；点在按钮、链接、菜单等
 * 交互元素上（以及其所在的 `[data-row-click-ignore]` 区域）交给它们自己处理；
 * 用户正在拖选文字时不触发。键盘入口由行内的图标按钮提供。
 */
export function rowClickHandler(open: (() => void) | undefined) {
  if (!open) return undefined;
  return (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    const hit = target?.closest?.(INTERACTIVE_SELECTOR);
    if (hit && e.currentTarget.contains(hit) && hit !== e.currentTarget) return;
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
    open();
  };
}
