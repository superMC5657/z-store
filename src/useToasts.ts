import { useCallback, useEffect, useState } from 'react';
import { ToastMessage } from './types';

/**
 * 轻量应用内通知发送器：通过 `zstore:toast` CustomEvent 请求由 App 根组件统一展示 Toast，
 * 永远不抛异常、不阻塞主流程。
 */
export function notifyToast(text: string, type: ToastMessage['type'] = 'info'): void {
  try {
    window.dispatchEvent(new CustomEvent('zstore:toast', { detail: { text, type } }));
  } catch {
    // 忽略：通知失败不应影响业务流程
  }
}

/**
 * 应用级 Toast 通知通道：
 * Toast 状态、showToast、dismiss 及 `zstore:toast` 事件总线（供关注提醒 / 自更新 / OAuth / 导入导出共用）。
 */
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

  // 应用内通知总线：新功能经 `zstore:toast` 事件投递 Toast
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
