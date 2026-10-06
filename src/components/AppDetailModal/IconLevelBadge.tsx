import React from 'react';
import { RefreshCw } from 'lucide-react';

export const ICON_LEVEL_NAMES: Record<number, string> = {
  1: '收录官方',
  2: '品牌库',
  3: '仓库文件',
  4: '文档Logo',
  5: '首字母',
};

export interface IconLevelBadgeProps {
  isCataloged: boolean;
  isCyclingIcon: boolean;
  nextLevelTitle: string;
  onCycleIcon: (e: React.MouseEvent) => void;
}

export const IconLevelBadge: React.FC<IconLevelBadgeProps> = ({
  isCataloged,
  isCyclingIcon,
  nextLevelTitle,
  onCycleIcon,
}) => {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri || isCataloged) {
    return null;
  }

  return (
    <button
      type="button"
      className="modal-icon-cycle-btn"
      onClick={onCycleIcon}
      disabled={isCyclingIcon}
      title={nextLevelTitle}
      aria-label={nextLevelTitle}
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-card, #1e293b)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.2))',
        color: 'var(--text-secondary, #94a3b8)',
        cursor: isCyclingIcon ? 'not-allowed' : 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'all 0.15s ease',
        opacity: isCyclingIcon ? 0.6 : 1,
      }}
    >
      <RefreshCw
        size={11}
        className={isCyclingIcon ? 'icon-spin' : ''}
      />
    </button>
  );
};
