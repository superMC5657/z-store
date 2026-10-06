import React from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check } from 'lucide-react';
import { DataBackupRow } from '../../../components/DataBackupRow';

export interface DataManagementSectionProps {
  installedCount: number;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  handleExportJson: () => void;
}

export const DataManagementSection: React.FC<DataManagementSectionProps> = ({
  installedCount,
  highlightRow,
  activeNotice,
  handleExportJson,
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-group">
      <div className="settings-group-title">
        <Download size={15} strokeWidth={1.5} />
        <span>{t('settings.data_management', { defaultValue: '数据管理与迁移' })}</span>
      </div>
      <div className={`settings-row ${highlightRow === 'export' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.export_apps')}</span>
            {activeNotice?.key === 'export' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn-fluent btn-secondary"
            onClick={handleExportJson}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
            disabled={installedCount === 0}
          >
            <Download size={13} strokeWidth={1.5} />
            <span>{t('settings.export_btn')}</span>
          </button>
        </div>
      </div>

      <DataBackupRow />
    </div>
  );
};
