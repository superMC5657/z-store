import React, { useEffect, useRef } from 'react';

export interface InstallConfirmDialogProps {
  intro: string;
  appName: string;
  repoLine: string;
  source: string;
  sha256?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 深链安装确认弹窗（P0-1 显式用户授权门禁）：展示外部链接来源说明，
 * 应用名 / 仓库 / 来源 / SHA-256（若有）+ 取消 / 确认安装。
 * 文案保持既有硬编码风格。
 */
export const InstallConfirmDialog: React.FC<InstallConfirmDialogProps> = ({
  intro,
  appName,
  repoLine,
  source,
  sha256,
  onCancel,
  onConfirm,
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 置顶弹窗的焦点管理：打开即聚焦自身；Tab 限制在两个按钮内循环（简易焦点陷阱）；
  // Esc 仅关闭本层（关闭时详情弹窗仍在底下，保持无感返回）。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const buttons = Array.from(dialogRef.current.querySelectorAll('button:not([disabled])'));
    if (buttons.length === 0) return;
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop modal-confirm-above" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="detail-modal"
        style={{ maxWidth: '480px', width: '92%', padding: '24px 28px', outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="确认安装"
        tabIndex={-1}
      >
        <div className="modal-header" style={{ position: 'relative', padding: 0, marginBottom: '12px' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-xl)' }}>确认安装</h2>
        </div>
        <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
          {intro}
        </p>
        <div style={{ margin: '0 0 8px', lineHeight: 1.8 }}>
          <div>
            应用：{appName}
          </div>
          <div>
            仓库：{repoLine}
          </div>
          <div>
            来源：{source}
          </div>
          {sha256 && (
            <div className="text-mono" style={{ wordBreak: 'break-all' }}>
              SHA-256：{sha256}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ borderTop: 'none', background: 'transparent', padding: '16px 0 0 0', marginTop: '16px' }}>
          <button
            className="btn-fluent btn-secondary"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="btn-fluent btn-primary"
            onClick={onConfirm}
          >
            确认安装
          </button>
        </div>
      </div>
    </div>
  );
};
