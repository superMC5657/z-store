import React from 'react';
import { ToastMessage } from '../types';

interface ToastContainerProps {
  toasts: ToastMessage[];
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span style={{ fontSize: '16px' }}>
            {toast.type === 'error'
              ? '❌'
              : toast.type === 'warning'
                ? '⚠️'
                : toast.type === 'success'
                  ? '✅'
                  : '💡'}
          </span>
          <span style={{ flex: 1 }}>{toast.text}</span>
        </div>
      ))}
    </div>
  );
};
