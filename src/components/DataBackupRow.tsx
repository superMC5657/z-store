import React, { useRef, useState } from 'react';
import { Upload, Download, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { notifyToast } from '../utils/notify';
import { UserDataBackup } from '../types';

const pad2 = (n: number) => String(n).padStart(2, '0');

export const DataBackupRow: React.FC = () => {
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
      const backup: UserDataBackup = {
        version: 1,
        favorites,
        watched,
        settings: {
          theme: settings.theme,
          language: settings.language,
          detail_cache_ttl_minutes: settings.detail_cache_ttl_minutes ? Number(settings.detail_cache_ttl_minutes) : undefined,
          watch_notify_frequency: settings.watch_notify_frequency,
        },
      };
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
      const msg = `已导出备份（收藏 ${favorites.length} · 关注 ${watched.length}）`;
      showFeedback(msg, false);
      notifyToast(msg, 'success');
    } catch (e) {
      const msg = `导出备份失败: ${String(e)}`;
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
      const msg =
        `导入完成：收藏 +${counts.favorites_added} · 关注 +${counts.watched_added}` +
        ` · 设置${counts.settings_applied ? '已应用' : '未变更'}` +
        `（已安装 ${counts.installed_skipped} 个不受影响）`;
      showFeedback(msg, false);
      notifyToast(msg, 'success');
      window.dispatchEvent(new CustomEvent('zstore:data-imported'));
    } catch (e) {
      const msg = `导入备份失败: ${String(e)}`;
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
        <span style={{ fontWeight: 600 }}>用户数据备份</span>
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
            {isError ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
            <span>{feedback}</span>
          </span>
        ) : (
          <span className="settings-row-desc">备份或恢复收藏、关注及偏好设置</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className="btn-fluent btn-secondary"
          onClick={handleExport}
          disabled={isExporting}
          style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isExporting ? <RotateCcw size={12} className="icon-spin" /> : <Upload size={12} />}
          <span>{isExporting ? '正在导出...' : '导出'}</span>
        </button>
        <button
          className="btn-fluent btn-primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isImporting ? <RotateCcw size={12} className="icon-spin" /> : <Download size={12} />}
          <span>{isImporting ? '正在导入...' : '导入'}</span>
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
