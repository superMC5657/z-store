import type React from 'react';

/** 行内自带交互的元素：点击它们不触发整行打开。 */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, [role="button"], [role="menu"], [role="menuitem"], [contenteditable="true"], [data-row-click-ignore]';

/** 管理列表整行点击处理器：忽略行内交互控件点击与文字拖选，其余区域点击触发 `open`。 */
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
