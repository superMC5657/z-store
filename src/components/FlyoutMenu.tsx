import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface FlyoutMenuProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  align?: 'right' | 'left';
}

export const FlyoutMenu: React.FC<FlyoutMenuProps> = ({
  isOpen,
  onClose,
  children,
  width = 210,
  align = 'right',
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom');

  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const parent = menuRef.current.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    const spaceBelow = window.innerHeight - parentRect.bottom;
    const spaceAbove = parentRect.top;

    // A flyout menu is approximately 180px high
    // If not enough room below (< 210px) and more room above, pop upwards!
    if (spaceBelow < 210 && spaceAbove > spaceBelow) {
      setPlacement('top');
    } else {
      setPlacement('bottom');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        const parent = menuRef.current.parentElement;
        if (!parent || !parent.contains(target)) {
          onClose();
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      className="flyout-menu"
      style={{
        position: 'absolute',
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        ...(placement === 'bottom'
          ? { top: 'calc(100% + 6px)' }
          : { bottom: 'calc(100% + 6px)' }),
        width: `${width}px`,
        zIndex: 1000,
        boxShadow:
          'var(--shadow-modal, 0 16px 40px rgba(0, 0, 0, 0.65)), 0 0 0 1px var(--border-highlight, rgba(255, 255, 255, 0.12))',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
};
