import { useCallback, useEffect, useState } from 'react';
import { ToastMessage } from './types';

/** 通过 `zstore:toast` 事件向根组件投递一条 Toast，失败时静默忽略。 */
export function notifyToast(text: string, type: ToastMessage['type'] = 'info'): void {
  try {
    window.dispatchEvent(new CustomEvent('zstore:toast', { detail: { text, type } }));
  } catch {
    // 忽略派发异常，避免阻塞业务流程
  }
}

/** 应用级 Toast 状态管理与 `zstore:toast` 事件订阅 Hook。 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const showToast = useCallback((text: string, type: ToastMessage['type'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-2), { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);
  const handleDismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string; type?: ToastMessage['type'] } | undefined;
      if (detail?.text) {
        showToast(detail.text, detail.type || 'info');
      }
    };
    window.addEventListener('zstore:toast', handler);
    return () => {
      window.removeEventListener('zstore:toast', handler);
    };
  }, [showToast]);

  return { toasts, showToast, handleDismissToast };
}
