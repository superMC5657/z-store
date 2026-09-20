import { useCallback, useEffect, useState } from 'react';
import { ToastMessage } from './types';
import { zlogError, zlogInfo, zlogWarn } from './lib/z-log';

/**
 * App-level toast channel (FR-6.2 / FR-4.4 / FR-7 / FR-6.3 shared).
 * Pure move of the toast state + showToast + dismiss + `zstore:toast`
 * event bus previously inline in App.tsx. No behavior change.
 */
export function useToasts() {
  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const showToast = useCallback((text: string, type: ToastMessage['type'] = 'info') => {
    if (type === 'error') {
      zlogError(`[toast] ${text}`);
    } else if (type === 'warning') {
      zlogWarn(`[toast] ${text}`);
    } else {
      zlogInfo(`[toast] ${text}`);
    }
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
