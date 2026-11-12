import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface InlineConfirmButtonProps {
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
  size?: 'md' | 'compact' | 'sm';
  style?: React.CSSProperties;
}

export const InlineConfirmButton: React.FC<InlineConfirmButtonProps> = ({
  onConfirm,
  confirmText,
  cancelTitle,
  variant = 'secondary',
  confirmVariant = 'danger',
  children,
  title,
  disabled = false,
  timeoutMs = 4000,
  className = '',
  size,
  style,
}) => {
  const { t } = useTranslation();
  const effectiveCancelTitle = cancelTitle ?? t('common.cancel');
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    if (!isConfirming || timeoutMs <= 0) return;
    const timer = setTimeout(() => {
      setIsConfirming(false);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [isConfirming, timeoutMs]);

  const sizeClass = size
    ? (size === 'md' ? '' : `btn-${size}`)
    : className.includes('btn-sm')
      ? 'btn-sm'
      : className.includes('btn-compact')
        ? 'btn-compact'
        : '';

  if (isConfirming) {
    const resolvedConfirmVariant =
      confirmVariant === 'danger' ? 'btn-danger-solid' : `btn-${confirmVariant}`;
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <button
          type="button"
          className={`btn-fluent ${resolvedConfirmVariant} ${sizeClass} ${className}`.trim()}
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
          className={`btn-fluent btn-secondary btn-icon-only ${sizeClass}`.trim()}
          onClick={(e) => {
            e.stopPropagation();
            setIsConfirming(false);
          }}
          title={effectiveCancelTitle}
          aria-label={effectiveCancelTitle}
          disabled={disabled}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`btn-fluent btn-${variant} ${sizeClass} ${className}`.trim()}
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
