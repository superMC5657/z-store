import React, { useRef, useState } from 'react';
import { Upload, Download, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../services/api';
import { notifyToast } from '../utils/notify';
import { UserDataBackup, UserDataBackupSettings } from '../types';
import { useTransientFeedback } from './useTransientFeedback';

const pad2 = (n: number) => String(n).padStart(2, '0');

// 出于安全考虑，github_token（PAT 凭据）永不写入备份文件；
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

// 纯函数导出组装（version 保持为 1，便于单测覆盖导出 → JSON → 导入往返）。
// showCustom 开关随备份往返（默认开；缺席即默认开，不污染旧备份）。
const buildBackupSettings = (
  settings: Record<string, unknown>,
): UserDataBackupSettings => {
  const base: UserDataBackupSettings = {
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
  };
  // showCustom/show_custom 仅在输入含键时透传（旧备份无键即默认开，不破坏既有单测）。
  const showRaw =
    (settings as Record<string, unknown>).showCustom ??
    (settings as Record<string, unknown>).show_custom;
  if (showRaw !== undefined) {
    const normalized =
      typeof showRaw === 'boolean'
        ? String(showRaw)
        : typeof showRaw === 'number'
          ? String(showRaw)
          : String(showRaw).trim();
    if (normalized !== '') {
      (base as Record<string, unknown>).showCustom = normalized;
    }
  }
  return base;
};

/** 备份中的草稿 payload（CustomAppEntry 最小子集；恢复经 saveCustomApp 逐条 upsert）。 */
interface BackupCustomAppItem {
  id: string;
  item: Record<string, unknown>;
}

type UserDataBackupWithCustom = UserDataBackup & {
  custom_apps?: BackupCustomAppItem[];
};

/** 备份含草稿：customApps 缺席/空即不写键（旧调用零变化，旧单测透传）。 */
export const buildUserDataBackup = (
  favorites: string[],
  watched: string[],
  settings: Record<string, unknown>,
  customApps?: BackupCustomAppItem[],
): UserDataBackupWithCustom => {
  const backup: UserDataBackupWithCustom = {
    version: 1,
    favorites,
    watched,
    settings: buildBackupSettings(settings),
  };
  if (customApps && customApps.length > 0) {
    backup.custom_apps = customApps;
  }
  return backup;
};

/**
 * 备份 JSON 中的草稿提取（纯函数，可单测）：仅收合法条目
 * （id 非空 + item 为对象），非法行直接丢弃。
 */
function parseBackupCustomApps(json: string): BackupCustomAppItem[] {
  try {
    const raw = JSON.parse(json) as { custom_apps?: unknown };
    if (!Array.isArray(raw.custom_apps)) return [];
    const out: BackupCustomAppItem[] = [];
    for (const v of raw.custom_apps) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const item = rec.item;
      if (!id || !item || typeof item !== 'object') continue;
      out.push({ id, item: item as Record<string, unknown> });
    }
    return out;
  } catch {
    return [];
  }
}

export const DataBackupRow: React.FC = () => {
  const { t } = useTranslation();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const { text: feedback, isError, show: showFeedback } = useTransientFeedback();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const [favorites, watchedEntries, settings, customEntries] = await Promise.all([
        tauriApi.getFavorites().catch(() => [] as string[]),
        tauriApi.getWatchedApps().catch(() => [] as { app_id: string }[]),
        tauriApi.getSettings().catch(() => ({} as Record<string, string>)),
        tauriApi.listCustomApps(false).catch(() => [] as { id: string; item: unknown }[]),
      ]);
      // 备份含草稿：未归档 custom_apps 随备份走（id + item 最小子集，恢复经 saveCustomApp）。
      const customApps: BackupCustomAppItem[] = Array.isArray(customEntries)
        ? customEntries
            .filter((e) => e && typeof e.id === 'string' && e.id.trim() && e.item)
            .map((e) => ({ id: e.id, item: e.item as unknown as Record<string, unknown> }))
        : [];
      // 关注备份只取 id（收录标记不进备份文件，恢复后以后端记录为准）。
      const watched: string[] = (Array.isArray(watchedEntries) ? watchedEntries : [])
        .map((w) => w?.app_id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
      const backup: UserDataBackupWithCustom = buildUserDataBackup(
        favorites,
        watched,
        settings,
        customApps,
      );
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
      const counts = await tauriApi.importUserData(text);
      // 备份含草稿恢复：custom_apps 经 saveCustomApp 逐条 upsert（best-effort，不阻塞主导入）。
      const customs = parseBackupCustomApps(text);
      let customRestored = 0;
      for (const c of customs) {
        try {
          await tauriApi.saveCustomApp(c.item as never);
          customRestored += 1;
        } catch {
          // 单条脏写跳过（后端校验拒绝），继续恢复其余
        }
      }
      if (customs.length > 0) {
        window.dispatchEvent(new CustomEvent('zstore:custom-apps-changed'));
      }
      const settingsStatus = counts.settings_applied ? t('backup.settings_applied') : t('backup.settings_unchanged');
      const baseMsg = t('backup.import_success', {
        fav: counts.favorites_added,
        watch: counts.watched_added,
        settings: settingsStatus,
      });
      const msg =
        customs.length > 0
          ? `${baseMsg}（草稿 ${customRestored}/${customs.length}）`
          : baseMsg;
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
          {isExporting ? <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" /> : <Upload size={13} strokeWidth={1.5} />}
          <span>{isExporting ? t('backup.exporting') : t('backup.export')}</span>
        </button>
        <button
          className="btn-fluent btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          style={{ fontSize: 'var(--font-sm)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
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
