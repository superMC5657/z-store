import React from 'react';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import type { UpdateCheckProgressPayload } from '../../types';

/** 检查更新进行中的进度条：已检查数 / 总数、当前比对的应用与百分比。 */
export const CheckProgressBanner: React.FC<{ progress?: UpdateCheckProgressPayload | null }> = ({
  progress,
}) => {
  const { t } = useTranslation();
  const hasTotal = Boolean(progress && progress.total > 0);
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.checked / progress.total) * 100))
      : 0;

  return (
    <div className="manage-progress-banner" role="status" aria-live="polite">
      <div className="manage-progress-left">
        <span className="spinner-icon" aria-hidden="true" />
        <span>
          <strong>{t('installed.progress_title')}</strong>
          <span style={{ color: 'var(--text-secondary)' }}>
            {progress && hasTotal ? (
              <>
                {' '}
                {t('installed.progress_checked', {
                  checked: progress.checked,
                  total: progress.total,
                  current: progress.app_name
                    ? t('installed.progress_comparing', { name: progress.app_name })
                    : '',
                })}
              </>
            ) : (
              t('installed.progress_hint')
            )}
          </span>
        </span>
      </div>
      {hasTotal && <span className="manage-progress-meta">{pct}%</span>}
      <div className="manage-progress-track">
        <div className="manage-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};
