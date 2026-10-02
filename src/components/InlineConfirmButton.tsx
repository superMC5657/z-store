import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

export interface InlineConfirmButtonProps {
  onConfirm: () => void | Promise<void>;
  confirmText: React.ReactNode;
  cancelTitle?: string;
  variant?: 'danger' | 'warning' | 'secondary' | 'primary';
  confirmVariant?: 'danger' | 'warning' | 'primary';
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
  timeoutMs?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const InlineConfirmButton: React.FC<InlineConfirmButtonProps> = ({
  onConfirm,
  confirmText,
  cancelTitle = '取消',
  variant = 'secondary',
  confirmVariant = 'danger',
  children,
  title,
  disabled = false,
  timeoutMs = 4000,
  className = '',
  style,
}) => {
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    if (!isConfirming || timeoutMs <= 0) return;
    const timer = setTimeout(() => {
      setIsConfirming(false);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [isConfirming, timeoutMs]);

  if (isConfirming) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <button
          type="button"
          className={`btn-fluent btn-${confirmVariant} ${className}`.trim()}
          style={style}
          onClick={async (e) => {
            e.stopPropagation();
            setIsConfirming(false);
            await onConfirm();
          }}
          disabled={disabled}
        >
          {confirmText}
        </button>
        <button
          type="button"
          className="btn-fluent btn-secondary btn-icon-only"
          // 与详情弹窗顶部操作行的大按钮档同高（30px），确认态展开时不跳动
          style={{ width: '30px', height: '30px', minHeight: '30px', maxHeight: '30px', padding: 0, boxSizing: 'border-box', flexShrink: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            setIsConfirming(false);
          }}
          title={cancelTitle}
          disabled={disabled}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`btn-fluent btn-${variant} ${className}`.trim()}
      onClick={(e) => {
        e.stopPropagation();
        setIsConfirming(true);
      }}
      disabled={disabled}
      title={title}
      style={style}
    >
      {children}
    </button>
  );
};
