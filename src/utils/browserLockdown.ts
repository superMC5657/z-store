import { tauriApi } from '../services/api';
import { resolveFallbackOpener } from './fallbackOpener';

export { resolveFallbackOpener };

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
 * 劫持版 `window.open` 同步返回 null，直接调用必被拦截，所以必须在覆写前一次性捕获
 * 原生 opener 并同步到 `window.__ZSTORE_NATIVE_OPEN__`，兜底经该全局键绕过劫持直达
 * 浏览器；非劫持（未初始化/单测桩）时用当前 `window.open` 本体即可。
 * - `initBrowserLockdown` 在覆写前捕获并同步到全局键；`settings.openUrl` 与 `PendingView`
 *   的兜底均经 `utils/fallbackOpener` 的 `resolveFallbackOpener()` 读取（本文件再导出），
 *   该叶子模块不导入 `services/`，避免 `settings → browserLockdown → services/api` 循环；
 * - Demo 的 `__ZSTORE_DEMO_NATIVE_OPEN__` 同为劫持前捕获，两键任一可用即视为原生可用。
 */
let cachedNativeOpen: typeof window.open | null = null;

/** 读取劫持前捕获的原生 opener（未初始化时为 null）。 */
export function getNativeWindowOpen(): typeof window.open | null {
  return cachedNativeOpen;
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

  // 8. window.open 劫持转走 tauriApi.openUrl（Spec §5 最小集：劫持前缓存原生 open +
  // 兜底同步返回 null；window.open 同步无处抛错，生产需 await/检查的调用方请直调
  // tauriApi.openUrl，勿经 window.open；此处仅兜底吞错防未处理 rejection；并发连调
  // 均透传 tauriApi，不在生产加锁，去重/幂等由调用方负责，行为由单测锁定）。
  // 原生 opener 已在覆写前捕获（见顶部 cachedNativeOpen 注释），供兜底绕过劫持直达浏览器。
  try {
    if (!cachedNativeOpen && typeof window.open === 'function') {
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
  const hijackedOpen = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
    void target;
    void features;
    if (url == null) return null;
    const urlStr = typeof url === 'string' ? url : url.toString();
    void Promise.resolve(tauriApi.openUrl(urlStr)).catch(() => {});
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
