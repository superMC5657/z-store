import { tauriApi } from '../services/api';

/**
 * 桌面原生化锁闭（第二轮去浏览器化）：
 * 关闭右键、缩放、查找、浏览器历史导航、另存为、打印、源码、调试器等浏览器默认行为。
 *
 * 拦截范围：
 * - contextmenu：禁用右键菜单
 * - keydown（capture 阶段）：
 *     - F5、F12
 *     - Alt + ArrowLeft / ArrowRight（前进后退）
 *     - Ctrl/Cmd + +/-/=/0（缩放）
 *     - Ctrl/Cmd + F/G（页面查找）
 *     - Ctrl/Cmd + H/J/D/O/N/T/W（历史/下载/书签/打开/新建/标签/关窗）
 *     - Ctrl/Cmd + R/S/P/U（刷新/保存/打印/源码）
 *     - Ctrl/Cmd + Shift + I/J/C（开发者工具）
 * - wheel：Ctrl/Cmd + 滚轮缩放拦截（passive: false），普通滚动放行
 * - dragover / drop：全局阻止文件拖拽替换页面（防 file:// 顶替）
 * - mouse auxclick / mouseup：侧键（button 3/4 前进后退）阻止
 * - window.print：重写为空函数
 * - window.open：劫持转走 tauriApi.openUrl 并返回 null
 * - click 事件委托：a[target="_blank"] 及 http/https 外链拦截转走 tauriApi.openUrl
 *
 * 显式放行：Ctrl+K（搜索聚焦）、Escape（关闭菜单）、Ctrl+C/V/X/A/Z/Y（标准编辑）、Tab/Enter/Space
 */

let isInitialized = false;

/**
 * 劫持前捕获的原生 `window.open`（fallback 专用，绕过劫持直达浏览器）：
 * - `initBrowserLockdown` 在覆写前一次性捕获并同步到 `window.__ZSTORE_NATIVE_OPEN__`，
 *   `settings.openUrl` 经该全局键读取（避免 `settings → browserLockdown → services/api`
 *   循环导入），`PendingView` 经下方的 `resolveFallbackOpener()` 读取；
 * - Demo 的 `__ZSTORE_DEMO_NATIVE_OPEN__` 同为劫持前捕获，两键任一可用即视为原生可用。
 */
let cachedNativeOpen: typeof window.open | null = null;

/** 劫持标记：`resolveFallbackOpener` 据此判断当前 `window.open` 是否为劫持版。 */
const HIJACK_MARK = '__zstoreHijacked';

/** 读取劫持前捕获的原生 opener（未初始化时为 null）。 */
export function getNativeWindowOpen(): typeof window.open | null {
  return cachedNativeOpen;
}

/**
 * 解析兜底 opener：
 * - 当前 `window.open` 为劫持版时返回劫持前捕获的原生（`cachedNativeOpen` /
 *   `__ZSTORE_NATIVE_OPEN__` / `__ZSTORE_DEMO_NATIVE_OPEN__`），绕过“直接调用被拦截返回 null”；
 * - 非劫持（单测 mock / 未初始化）时返回当前 `window.open` 本体，单测可桩返回值；
 * - 无可用 opener 时返回 null，调用方抛错保留失败感知。
 */
export function resolveFallbackOpener(): typeof window.open | null {
  if (typeof window === 'undefined') return null;
  try {
    const cur = window.open as unknown as Record<string, unknown>;
    const isHijacked = Boolean(cur?.[HIJACK_MARK]);
    if (isHijacked) {
      if (cachedNativeOpen) return cachedNativeOpen;
      const w = window as unknown as Record<string, unknown>;
      const stored =
        w['__ZSTORE_NATIVE_OPEN__'] ?? w['__ZSTORE_DEMO_NATIVE_OPEN__'];
      if (typeof stored === 'function') {
        return (stored as typeof window.open).bind(window);
      }
      return null;
    }
    return window.open.bind(window);
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

export function initBrowserLockdown(): void {
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

  // 8. window.open 劫持转走 tauriApi.openUrl（fire-and-forget：window.open 同步无处抛错，
  // 生产需 await/检查的调用方请直调 tauriApi.openUrl，勿经 window.open；此处仅兜底吞错防未处理 rejection）。
  // 旗标跨 async 复位修复：置位后仅在兜底 promise 落定（finally）后复位，避免同步 finally
  // 立即复位导致重入拦截失效；原生 opener 已在覆写前捕获，供兜底绕过劫持直达浏览器。
  try {
    const cur = window.open as unknown as Record<string, unknown>;
    if (!cur?.[HIJACK_MARK] && typeof window.open === 'function' && !cachedNativeOpen) {
      cachedNativeOpen = window.open.bind(window);
      try {
        (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__ = cachedNativeOpen;
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
  let inWindowOpen = false;
  const hijackedOpen = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
    void target;
    void features;
    if (inWindowOpen) return null;
    if (url == null) return null;
    inWindowOpen = true;
    try {
      const urlStr = typeof url === 'string' ? url : url.toString();
      void Promise.resolve(tauriApi.openUrl(urlStr))
        .catch(() => {})
        .finally(() => {
          inWindowOpen = false;
        });
    } catch {
      inWindowOpen = false;
    }
    return null;
  };
  try {
    (hijackedOpen as unknown as Record<string, unknown>)[HIJACK_MARK] = true;
  } catch {
    /* 忽略 */
  }

  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: hijackedOpen,
    });
  } catch {
    window.open = hijackedOpen;
  }

  // 9. 全局外链点击事件委托：a[target="_blank"] 及 http/https 链接拦截转走 tauriApi.openUrl
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
          void Promise.resolve(tauriApi.openUrl(href.trim())).catch(() => {});
        }
      }
    },
    { capture: true }
  );
}
