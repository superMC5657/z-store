import React from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Check } from 'lucide-react';
import { tauriApi } from '../../../services/api';
import type { AppSettings } from '../../../types';

export interface StorageSectionProps {
  downloadDir: string;
  portableDir: string;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  triggerChangeFeedback: (key: string, text: string) => void;
}

export const StorageSection: React.FC<StorageSectionProps> = ({
  downloadDir,
  portableDir,
  highlightRow,
  activeNotice,
  onUpdateSetting,
  triggerChangeFeedback,
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-group">
      <div className="settings-group-title">
        <FolderOpen size={15} strokeWidth={1.5} />
        <span>{t('settings.storage_paths', { defaultValue: '存储与安装' })}</span>
      </div>
      <div className={`settings-row ${highlightRow === 'download_dir' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.download_dir')}</span>
            {activeNotice?.key === 'download_dir' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <div className="settings-input-group">
          <input
            type="text"
            className={`settings-input ${highlightRow === 'download_dir' ? 'input-highlight' : ''}`}
            value={downloadDir || '~/Downloads'}
            onChange={(e) => onUpdateSetting('download_dir', e.target.value)}
            placeholder="~/Downloads"
          />
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={async () => {
              try {
                const picked = await tauriApi.selectFolder(downloadDir, t('settings.select_download_dir'));
                if (picked) {
                  onUpdateSetting('download_dir', picked);
                  triggerChangeFeedback('download_dir', t('settings.download_dir'));
                }
              } catch {
                /* 用户取消了文件夹选择器 */
              }
            }}
          >
            <FolderOpen size={13} strokeWidth={1.5} />
            <span>{t('settings.browse')}</span>
          </button>
        </div>
      </div>

      <div className={`settings-row ${highlightRow === 'portable_dir' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.portable_dir')}</span>
            {activeNotice?.key === 'portable_dir' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <div className="settings-input-group">
          <input
            type="text"
            className={`settings-input ${highlightRow === 'portable_dir' ? 'input-highlight' : ''}`}
            value={portableDir || '%LOCALAPPDATA%\\Programs\\z-store-apps'}
            onChange={(e) => onUpdateSetting('portable_dir', e.target.value)}
            placeholder="%LOCALAPPDATA%\Programs\z-store-apps"
          />
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={async () => {
              try {
                const picked = await tauriApi.selectFolder(portableDir, t('settings.select_portable_dir'));
                if (picked) {
                  onUpdateSetting('portable_dir', picked);
                  triggerChangeFeedback('portable_dir', t('settings.portable_dir'));
                }
              } catch {
                /* 用户取消了文件夹选择器 */
              }
            }}
          >
            <FolderOpen size={13} strokeWidth={1.5} />
            <span>{t('settings.browse')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
