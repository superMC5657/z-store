/**
 * 待收录页共享内联样式（PendingView 与 pending/ 子组件共用）：
 * 只含样式常量，不放布局语义——布局类名收在 components-pending.css。
 */
import type React from 'react';

export const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: 'var(--font-sm)',
  color: 'var(--text-secondary)',
  marginBottom: '8px',
  minWidth: 0,
};

export const hintStyle: React.CSSProperties = {
  fontSize: 'var(--font-xs)',
  color: 'var(--text-tertiary)',
  minWidth: 0,
  overflowWrap: 'anywhere',
};

export const errorStyle: React.CSSProperties = {
  fontSize: 'var(--font-xs)',
  color: 'var(--text-primary)',
  fontStyle: 'normal',
  borderLeft: '2px solid var(--text-primary)',
  paddingLeft: '6px',
};
