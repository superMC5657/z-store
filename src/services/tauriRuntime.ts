/**
 * 真实 Tauri 桌面运行时判定：`__TAURI_INTERNALS__.invoke` 可用且非官网 Demo mock
 * （`__ZSTORE_DEMO_MOCK__`）。jsdom 单测与 Demo 预览返回 `false`，远端图片保持原链直出。
 */
export function isRealTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    __ZSTORE_DEMO_MOCK__?: unknown;
  };
  return typeof w.__TAURI_INTERNALS__?.invoke === 'function' && !w.__ZSTORE_DEMO_MOCK__;
}
