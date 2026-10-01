import React, { useRef, useState } from 'react';
import { Upload, Download, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { notifyToast } from '../utils/notify';
import { UserDataBackup, UserDataBackupSettings } from '../types';

const pad2 = (n: number) => String(n).padStart(2, '0');

// P1-8: 出于安全考虑，github_token（PAT 凭据）永不写入备份文件；
// 导入侧白名单（src-tauri/src/oauth/backup.rs）同样拒绝该键。
export const BACKUP_EXCLUDED_KEYS = ['github_token'] as const;

const toOptionalNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return undefined;
};

const toOptionalBool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
};

// P1-8: 纯函数导出组装（version 保持为 1，便于单测覆盖导出 → JSON → 导入往返）。
const buildBackupSettings = (
  settings: Record<string, unknown>,
): UserDataBackupSettings => ({
  theme: settings.theme as string | undefined,
  language: settings.language as string | undefined,
  ui_scale: settings.ui_scale as string | undefined,
  font_size: settings.font_size as string | undefined,
  portable_dir: settings.portable_dir as string | undefined,
  download_dir: settings.download_dir as string | undefined,
  active_mirror: settings.active_mirror as string | undefined,
  launch_on_startup: toOptionalBool(settings.launch_on_startup),
  update_frequency: settings.update_frequency as string | undefined,
  detail_cache_ttl_minutes: toOptionalNumber(settings.detail_cache_ttl_minutes),
  catalog_source_url: settings.catalog_source_url as string | undefined,
  watch_notify_frequency: settings.watch_notify_frequency as string | undefined,
});

export const buildUserDataBackup = (
  favorites: string[],
  watched: string[],
  settings: Record<string, unknown>,
): UserDataBackup => ({
  version: 1,
  favorites,
  watched,
  settings: buildBackupSettings(settings),
});

export const DataBackupRow: React.FC = () => {
  const { t } = useTranslation();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const showFeedback = (text: string, error: boolean) => {
    setFeedback(text);
    setIsError(error);
    setTimeout(() => setFeedback(null), 5000);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const [favorites, watched, settings] = await Promise.all([
        api.getFavorites().catch(() => [] as string[]),
        api.getWatchedApps().catch(() => [] as string[]),
        api.getSettings().catch(() => ({} as Record<string, string>)),
      ]);
      const backup: UserDataBackup = buildUserDataBackup(favorites, watched, settings);
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `z-store-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const msg = t('backup.export_success', { fav: favorites.length, watch: watched.length });
      showFeedback(msg, false);
      notifyToast(msg, 'success');
    } catch (e) {
      const msg = t('backup.export_failed', { error: String(e) });
      showFeedback(msg, true);
      notifyToast(msg, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setIsImporting(true);
    try {
      const text = await file.text();
      const counts = await api.importUserData(text);
      const settingsStatus = counts.settings_applied ? t('backup.settings_applied') : t('backup.settings_unchanged');
      const msg = t('backup.import_success', {
        fav: counts.favorites_added,
        watch: counts.watched_added,
        settings: settingsStatus,
        skipped: counts.installed_skipped,
      });
      showFeedback(msg, false);
      notifyToast(msg, 'success');
      window.dispatchEvent(new CustomEvent('zstore:data-imported'));
    } catch (e) {
      const msg = t('backup.import_failed', { error: String(e) });
      showFeedback(msg, true);
      notifyToast(msg, 'error');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span style={{ fontWeight: 510 }}>{t('backup.title')}</span>
        {feedback ? (
          <span
            style={{
              fontSize: '12px',
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
          style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isExporting ? <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" /> : <Upload size={13} strokeWidth={1.5} />}
          <span>{isExporting ? t('backup.exporting') : t('backup.export')}</span>
        </button>
        <button
          className="btn-fluent btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isImporting ? <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" /> : <Download size={13} strokeWidth={1.5} />}
          <span>{isImporting ? t('backup.importing') : t('backup.import')}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
          }}
        />
      </div>
    </div>
  );
};
