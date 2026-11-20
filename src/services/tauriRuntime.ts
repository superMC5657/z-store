/** 判断当前是否为真实 Tauri 桌面运行时（排除 jsdom 与 Demo mock）。 */
export function isRealTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    __ZSTORE_DEMO_MOCK__?: unknown;
  };
  return typeof w.__TAURI_INTERNALS__?.invoke === 'function' && !w.__ZSTORE_DEMO_MOCK__;
}
