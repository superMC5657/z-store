import React from 'react';
import { useTranslation } from 'react-i18next';
import { ModalShell } from '../components/ModalShell';

interface InstallConfirmDialogProps {
  intro: string;
  appName: string;
  repoLine: string;
  source: string;
  sha256?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 深链安装确认弹窗（显式用户授权门禁）：展示外部链接来源说明，
 * 应用名 / 仓库 / 来源 / SHA-256（若有）+ 取消 / 确认安装。
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
  const { t } = useTranslation();

  // 置顶于详情弹窗之上：Esc 只取消本层，详情弹窗仍留在底下。
  return (
    <ModalShell
      layer="confirm"
      onClose={onCancel}
      ariaLabel={t('install_confirm.title')}
      panelStyle={{ maxWidth: '480px', width: '92%', padding: '24px 28px', outline: 'none' }}
    >
      <div className="modal-header" style={{ position: 'relative', padding: 0, marginBottom: '12px' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--font-xl)' }}>{t('install_confirm.title')}</h2>
      </div>
      <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
        {intro}
      </p>
      <div style={{ margin: '0 0 8px', lineHeight: 1.8 }}>
        <div>
          {t('install_confirm.app_label')}{appName}
        </div>
        <div>
          {t('install_confirm.repo_label')}{repoLine}
        </div>
        <div>
          {t('install_confirm.source_label')}{source}
        </div>
        {sha256 && (
          <div className="text-mono" style={{ wordBreak: 'break-all' }}>
            {t('install_confirm.sha256_label')}{sha256}
          </div>
        )}
      </div>
      <div className="modal-footer" style={{ borderTop: 'none', background: 'transparent', padding: '16px 0 0 0', marginTop: '16px' }}>
        <button
          className="btn-fluent btn-secondary"
          onClick={onCancel}
        >
          {t('install_confirm.cancel')}
        </button>
        <button
          className="btn-fluent btn-primary"
          onClick={onConfirm}
        >
          {t('install_confirm.confirm')}
        </button>
      </div>
    </ModalShell>
  );
};
