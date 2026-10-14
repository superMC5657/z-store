import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Check, Trash2 } from 'lucide-react';
import { tauriApi } from '../../../services/api';
import type { AppSettings, CacheUsageStats } from '../../../types';

export interface StorageSectionProps {
  downloadDir: string;
  portableDir: string;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  triggerChangeFeedback: (key: string, text: string) => void;
}

// 字节数格式化为可读大小。
function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 缓存占用文本：条目数与总大小。
function formatCacheStats(stats: CacheUsageStats | null, loading: boolean): string {
  if (loading) return '--';
  if (!stats) return '--';
  return `${stats.total_entries} 项 · ${formatCacheBytes(stats.total_bytes)}`;
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
  const [iconStats, setIconStats] = useState<CacheUsageStats | null>(null);
  const [assetStats, setAssetStats] = useState<CacheUsageStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [clearingKey, setClearingKey] = useState<string | null>(null);

  // 加载图标与通用图片缓存占用。
  const refreshCacheStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [icons, assets] = await Promise.all([
        tauriApi.getIconCacheStats(),
        tauriApi.getAssetCacheStats(),
      ]);
      setIconStats(icons);
      setAssetStats(assets);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCacheStats();
  }, [refreshCacheStats]);

  // 清空图标缓存并刷新占用。
  const handleClearIcons = async () => {
    setClearingKey('icons');
    try {
      await tauriApi.clearIconCache();
      await refreshCacheStats();
      triggerChangeFeedback('icon_cache', t('settings.cache_cleared', { defaultValue: '缓存已清空' }));
    } finally {
      setClearingKey(null);
    }
  };

  // 清空通用图片缓存并刷新占用。
  const handleClearAssets = async () => {
    setClearingKey('assets');
    try {
      await tauriApi.clearAssetCache();
      await refreshCacheStats();
      triggerChangeFeedback('asset_cache', t('settings.cache_cleared', { defaultValue: '缓存已清空' }));
    } finally {
      setClearingKey(null);
    }
  };

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

      <div className={`settings-row ${highlightRow === 'icon_cache' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.icon_cache', { defaultValue: '图标缓存' })}</span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
              {formatCacheStats(iconStats, statsLoading)}
            </span>
            {activeNotice?.key === 'icon_cache' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={handleClearIcons}
            disabled={clearingKey !== null || statsLoading}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Trash2 size={13} strokeWidth={1.5} />
            <span>{t('settings.clear_cache', { defaultValue: '清理' })}</span>
          </button>
        </div>
      </div>

      <div className={`settings-row ${highlightRow === 'asset_cache' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.asset_cache', { defaultValue: '通用图片缓存' })}</span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
              {formatCacheStats(assetStats, statsLoading)}
            </span>
            {activeNotice?.key === 'asset_cache' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={handleClearAssets}
            disabled={clearingKey !== null || statsLoading}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Trash2 size={13} strokeWidth={1.5} />
            <span>{t('settings.clear_cache', { defaultValue: '清理' })}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
