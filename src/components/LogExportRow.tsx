import React, { useState } from 'react';
import { ScrollText, FolderOpen, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../services/api';
import { notifyToast } from '../utils/notify';

/**
 * 诊断日志行（设置 → 数据管理与备份）：导出脱敏日志包 / 打开日志文件夹。
 * 后端命令 `zlog_export_bundle` / `zlog_get_dir`（导出前脱敏，禁 token/code/邮箱出包）。
 */
export const LogExportRow: React.FC = () => {
  const { t } = useTranslation();
  const [isExporting, setIsExporting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const showFeedback = (text: string, error: boolean) => {
    setFeedback(text);
    setIsError(error);
    setTimeout(() => setFeedback(null), 5000);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const path = await tauriApi.exportLogBundle();
      const msg = t('zlog.export_success', { path });
      showFeedback(msg, false);
      notifyToast(msg, 'success');
    } catch (e) {
      const msg = t('zlog.export_failed', { error: String(e) });
      showFeedback(msg, true);
      notifyToast(msg, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      const dir = await tauriApi.getLogDir();
      await tauriApi.openFolder(dir);
    } catch (e) {
      const msg = t('zlog.open_failed', { error: String(e) });
      showFeedback(msg, true);
      notifyToast(msg, 'error');
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span style={{ fontWeight: 510 }}>{t('zlog.title')}</span>
        {feedback ? (
          <span
            style={{
              fontSize: 'var(--font-sm)',
              color: isError ? 'var(--status-error)' : 'var(--status-success)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            {isError ? <AlertTriangle size={13} strokeWidth={1.5} /> : <CheckCircle2 size={13} strokeWidth={1.5} />}
            <span>{feedback}</span>
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className="btn-fluent btn-secondary"
          onClick={handleExport}
          disabled={isExporting}
          style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isExporting ? <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" /> : <ScrollText size={13} strokeWidth={1.5} />}
          <span>{isExporting ? t('zlog.exporting') : t('zlog.export')}</span>
        </button>
        <button
          className="btn-fluent btn-secondary"
          onClick={handleOpenFolder}
          style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <FolderOpen size={13} strokeWidth={1.5} />
          <span>{t('zlog.open_folder')}</span>
        </button>
      </div>
    </div>
  );
};
