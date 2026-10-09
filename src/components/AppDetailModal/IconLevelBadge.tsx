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
  /**
   * 轮换口径就绪：首轮 getAppIconCycle 落定（成功/失败均置 true）前不渲染，
   * 避免 loading 期按 category 兜底闪出按钮；缺省 true 保持独立渲染旧行为。
   */
  isCycleReady?: boolean;
}

export const IconLevelBadge: React.FC<IconLevelBadgeProps> = ({
  isCataloged,
  isCyclingIcon,
  nextLevelTitle,
  onCycleIcon,
  isCycleReady = true,
}) => {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  // 仅未收录保留切换入口：收录（isCataloged）彻底不渲染；
  // 口径未就绪（loading/兜底态）亦不渲染，防闪出。
  if (!isTauri || isCataloged || !isCycleReady) {
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
