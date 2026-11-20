/**
 * 桌面端浏览器行为锁闭：禁用右键菜单、缩放、查找、历史导航、打印与文件拖入，
 * 并将 `window.open` 及外链点击转发至外部打开器（保留 Ctrl+K、Escape 与常用编辑快捷键）。
 */

let isInitialized = false;
let openExternalHandler: ((url: string) => unknown) | null = null;

/** 解析绕过劫持的原生 opener（优先 `__ZSTORE_NATIVE_OPEN__` / `__ZSTORE_DEMO_NATIVE_OPEN__`）。 */
export function resolveFallbackOpener(): typeof window.open | null {
  if (typeof window === 'undefined') return null;
  try {
    const w = window as unknown as Record<string, unknown>;
    const stored = w['__ZSTORE_NATIVE_OPEN__'] ?? w['__ZSTORE_DEMO_NATIVE_OPEN__'];
    if (typeof stored === 'function') {
      return (stored as typeof window.open).bind(window);
    }
    if (typeof window.open === 'function') return window.open.bind(window);
    return null;
  } catch {
    return null;
  }
}

const BLOCKED_CTRL_KEYS = new Set([
  '+',
  '-',
  '=',
  '_',
  '0',
  'f',
  'g',
  'h',
  'j',
  'd',
  'o',
  'n',
  't',
  'w',
  'r',
  's',
  'p',
  'u',
]);

export function isBlockedShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): boolean {
  const { key, ctrlKey, metaKey, shiftKey, altKey } = e;
  const isCtrlOrMeta = ctrlKey || metaKey;

  // 1. 单键拦截：F5（刷新）、F12（开发者工具）
  if (key === 'F5' || key === 'F12') {
    return true;
  }

  // 2. Alt 组合键：Alt+ArrowLeft / Alt+ArrowRight（浏览器前进后退导航）
  if (altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return true;
  }

  // 3. Ctrl/Cmd 组合键
  if (isCtrlOrMeta) {
    const lowerKey = key.toLowerCase();

    // 开发者工具检查器快捷键：Ctrl/Cmd + Shift + I / J / C
    if (shiftKey && (lowerKey === 'i' || lowerKey === 'j' || lowerKey === 'c')) {
      return true;
    }

    // 浏览器功能快捷键（缩放、查找、导航、标签、窗口管理、源码等）
    if (BLOCKED_CTRL_KEYS.has(lowerKey) || BLOCKED_CTRL_KEYS.has(key)) {
      return true;
    }
  }

  return false;
}

export function initBrowserLockdown(openExternal?: (url: string) => unknown): void {
  if (openExternal) {
    openExternalHandler = openExternal;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  if (isInitialized) {
    return;
  }
  isInitialized = true;

  // 1. 全局禁用右键菜单
  document.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
    },
    { capture: true }
  );

  // 2. 捕获阶段拦截浏览器快捷键
  document.addEventListener(
    'keydown',
    (e) => {
      if (isBlockedShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  // 3. 避免图片和链接被拖拽脱出
  document.addEventListener(
    'dragstart',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'IMG' || target.tagName === 'A' || Boolean(target.closest?.('a, img')))) {
        e.preventDefault();
      }
    },
    { capture: true }
  );

  // 4. 滚轮事件：阻止 Ctrl/Cmd + 滚轮缩放，普通滚动放行
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    },
    { passive: false, capture: true }
  );

  // 5. 全局阻止 dragover / drop，防止本地文件拖拽落入顶替整个窗口 (file://)
  document.addEventListener(
    'dragover',
    (e) => {
      e.preventDefault();
    },
    { capture: true }
  );

  document.addEventListener(
    'drop',
    (e) => {
      e.preventDefault();
    },
    { capture: true }
  );

  // 6. 鼠标前进后退侧键（button 3/4）拦截
  const blockSideButtons = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('auxclick', blockSideButtons, { capture: true });
  document.addEventListener('mouseup', blockSideButtons, { capture: true });

  // 7. window.print 禁用
  try {
    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  } catch {
    window.print = () => {};
  }

  // 保留原生 opener 供未注入 handler 时的兜底调用
  try {
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.__ZSTORE_NATIVE_OPEN__ !== 'function' && typeof window.open === 'function') {
      w.__ZSTORE_NATIVE_OPEN__ = window.open.bind(window);
    }
  } catch {
    /* 忽略 */
  }
  const forwardExternal = (urlStr: string): void => {
    if (openExternalHandler) {
      void Promise.resolve(openExternalHandler(urlStr)).catch(() => {});
      return;
    }
    const fallback = resolveFallbackOpener();
    if (fallback) fallback(urlStr, '_blank', 'noopener,noreferrer');
  };

  const hijackedOpen = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
    void target;
    void features;
    if (url == null) return null;
    const urlStr = typeof url === 'string' ? url : url.toString();
    forwardExternal(urlStr);
    return null;
  };

  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: hijackedOpen,
    });
  } catch {
    window.open = hijackedOpen;
  }

  // 9. 全局外链点击事件委托：a[target="_blank"] 及 http/https 链接拦截转走注入打开器
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      const isTargetBlank = anchor.getAttribute('target') === '_blank';
      const isHttp = href ? /^https?:\/\//i.test(href.trim()) : false;

      if (isTargetBlank || isHttp) {
        e.preventDefault();
        e.stopPropagation();
        if (href) {
          forwardExternal(href.trim());
        }
      }
    },
    { capture: true }
  );
}
