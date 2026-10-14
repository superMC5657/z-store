import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Check, Trash2 } from 'lucide-react';
import { tauriApi } from '../../../services/api';
import type { AppSettings, CacheUsageStats } from '../../../types';
import { formatBytes } from '../../../utils/appHelper';

export interface StorageSectionProps {
  downloadDir: string;
  portableDir: string;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  triggerChangeFeedback: (key: string, text: string) => void;
}

// 缓存占用文本：条目数与总大小（加载中/无数据一律占位）。
function formatCacheStats(stats: CacheUsageStats | null, loading: boolean): string {
  if (loading) return '--';
  if (!stats) return '--';
  const size =
    Number.isFinite(stats.total_bytes) && stats.total_bytes >= 0
      ? formatBytes(stats.total_bytes)
      : '--';
  return `${stats.total_entries} 项 · ${size}`;
}

// 缓存行展示：标签 + 占用文本 + 各自清理按钮（图标/通用图片两行共用）。
interface CacheRowProps {
  rowKey: string;
  highlightRow: string | null;
  title: string;
  statsText: string;
  noticeText: string | null;
  clearDisabled: boolean;
  clearLabel: string;
  onClear: () => void;
}

function CacheRow({
  rowKey,
  highlightRow,
  title,
  statsText,
  noticeText,
  clearDisabled,
  clearLabel,
  onClear,
}: CacheRowProps) {
  return (
    <div className={`settings-row ${highlightRow === rowKey ? 'row-highlight' : ''}`}>
      <div className="settings-row-info">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 510 }}>{title}</span>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
            {statsText}
          </span>
          {noticeText !== null && (
            <span className="setting-applied-badge">
              <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
              <span>{noticeText}</span>
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          className="btn-fluent btn-secondary"
          onClick={onClear}
          disabled={clearDisabled}
          style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <Trash2 size={13} strokeWidth={1.5} />
          <span>{clearLabel}</span>
        </button>
      </div>
    </div>
  );
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

      <CacheRow
        rowKey="icon_cache"
        highlightRow={highlightRow}
        title={t('settings.icon_cache', { defaultValue: '图标缓存' })}
        statsText={formatCacheStats(iconStats, statsLoading)}
        noticeText={activeNotice?.key === 'icon_cache' ? activeNotice.text : null}
        clearDisabled={clearingKey !== null || statsLoading}
        clearLabel={t('settings.clear_cache', { defaultValue: '清理' })}
        onClear={handleClearIcons}
      />

      <CacheRow
        rowKey="asset_cache"
        highlightRow={highlightRow}
        title={t('settings.asset_cache', { defaultValue: '通用图片缓存' })}
        statsText={formatCacheStats(assetStats, statsLoading)}
        noticeText={activeNotice?.key === 'asset_cache' ? activeNotice.text : null}
        clearDisabled={clearingKey !== null || statsLoading}
        clearLabel={t('settings.clear_cache', { defaultValue: '清理' })}
        onClear={handleClearAssets}
      />
    </div>
  );
};
