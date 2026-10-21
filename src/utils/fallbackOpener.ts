/**
 * 兜底 opener 解析（Spec §5 最小集：劫持前缓存 + 兜底判 null，无生产加锁）：
 * - 有 `__ZSTORE_NATIVE_OPEN__` / `__ZSTORE_DEMO_NATIVE_OPEN__`（劫持前捕获）时优先
 *   返回它，绕过“劫持版直接调用必返回 null”；
 * - 无缓存键时（未初始化/单测桩）返回当前 `window.open` 本体，单测可桩返回值；
 * - 两者皆无时返回 null，调用方抛错保留失败感知（并发 edge 由单测锁定，不在生产加锁）。
 *
 * 叶子模块（不导入 `services/`）：`utils/browserLockdown` 与 `services/api/settings` 共用此
 * 唯一实现，避免 `settings → browserLockdown → services/api` 循环。
 */
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
