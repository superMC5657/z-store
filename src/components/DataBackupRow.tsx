import React, { useRef, useState } from 'react';
import {
  FileJson,
  FileOutput,
  FileInput,
  FileArchive,
  FolderOpen,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { tauriApi } from '../services/api';
import { InstalledApp, UserDataBackup, UserDataBackupSettings } from '../types';
import { useTransientFeedback } from './useTransientFeedback';

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatLocalStamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

// 出于安全考虑，github_token（PAT 凭据）永不写入备份文件；
// 导入侧白名单（src-tauri/src/userdata/mod.rs `IMPORT_SETTINGS_ALLOWLIST`）同样拒绝该键。
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

// 纯函数导出组装（version 为 1，保证导出 → JSON → 导入无损往返）。
// `showCustom`/`show_custom` 按存在性透传，缺席时保持默认开启。
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

/** 备份含草稿：customApps 缺席或为空时不写入该键。 */
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

/** 从备份 JSON 中提取合法草稿条目（id 非空且 item 为对象）。 */
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

export async function exportInstalledAppsBackup(t: TFunction): Promise<string | null> {
  const apps: InstalledApp[] = await tauriApi.getInstalledApps().catch(() => [] as InstalledApp[]);
  if (apps.length === 0) {
    return null;
  }
  const now = new Date();
  const payload = {
    app: 'ZStore',
    exported_at: now.toISOString(),
    installed_count: apps.length,
    apps,
  };
  const fileName = `zstore-installed-backup-${formatLocalStamp(now)}.json`;
  const path = await tauriApi.exportBackupFile(fileName, JSON.stringify(payload, null, 2));
  if (!path) return null;
  return t('backup.apps_export_success', { path });
}

export async function exportUserDataBackup(t: TFunction): Promise<string | null> {
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
  const fileName = `z-store-backup-${formatLocalStamp(new Date())}.json`;
  const path = await tauriApi.exportBackupFile(fileName, JSON.stringify(backup, null, 2));
  if (!path) return null;
  return t('backup.export_success', { fav: favorites.length, watch: watched.length, path });
}

async function importUserDataBackup(file: File, t: TFunction): Promise<string> {
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
      ? `${baseMsg}${t('backup.custom_suffix', { restored: customRestored, total: customs.length })}`
      : baseMsg;
  window.dispatchEvent(new CustomEvent('zstore:data-imported'));
  return msg;
}

export async function exportDiagnosticLogs(t: TFunction): Promise<string | null> {
  const path = await tauriApi.exportLogBundle();
  if (!path) return null;
  return t('zlog.export_success', { path });
}

async function openDiagnosticLogFolder(): Promise<void> {
  const dir = await tauriApi.getLogDir();
  await tauriApi.openFolder(dir);
}

type BusyAction = 'apps_export' | 'backup_export' | 'backup_import' | 'log_export';
type FailI18nKey = 'backup.export_failed' | 'backup.import_failed' | 'zlog.export_failed';

interface DataBackupRowProps {
  installedCount?: number;
}

/** 导出与备份操作行：承载应用列表导出、用户数据导入导出及诊断日志入口。 */
export const DataBackupRow: React.FC<DataBackupRowProps> = ({ installedCount = 0 }) => {
  const { t } = useTranslation();
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const { text: feedback, isError, show: showFeedback } = useTransientFeedback();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const runAction = async (
    key: BusyAction,
    task: () => Promise<string | null>,
    failKey: FailI18nKey,
    cleanup?: () => void,
  ) => {
    if (busyAction !== null) return;
    setBusyAction(key);
    try {
      const msg = await task();
      if (msg) {
        showFeedback(msg, false);
      }
    } catch (e) {
      showFeedback(t(failKey, { error: String(e) }), true);
    } finally {
      setBusyAction(null);
      cleanup?.();
    }
  };

  const handleOpenLogDir = async () => {
    try {
      await openDiagnosticLogFolder();
    } catch (e) {
      showFeedback(t('zlog.open_failed', { error: String(e) }), true);
    }
  };

  return (
    <div
      className="settings-row"
      data-testid="data-export-unified-row"
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}
    >
      <div className="settings-row-info">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 510 }}>{t('settings.export_and_backup_title')}</span>
          {feedback && (
            <span
              style={{
                fontSize: 'var(--font-sm)',
                color: isError ? 'var(--status-danger)' : 'var(--status-success)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {isError ? (
                <AlertTriangle size={13} strokeWidth={1.5} />
              ) : (
                <CheckCircle2 size={13} strokeWidth={1.5} />
              )}
              <span>{feedback}</span>
            </span>
          )}
        </div>
        <div className="settings-row-desc" style={{ marginTop: '2px' }}>
          {t('settings.export_and_backup_desc')}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <button
          type="button"
          className="btn-fluent btn-secondary btn-compact"
          onClick={() => void runAction('apps_export', () => exportInstalledAppsBackup(t), 'backup.export_failed')}
          disabled={installedCount === 0 || busyAction !== null}
        >
          {busyAction === 'apps_export' ? (
            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
          ) : (
            <FileJson size={13} strokeWidth={1.5} />
          )}
          <span>{t('settings.export_apps')}</span>
        </button>

        <button
          type="button"
          className="btn-fluent btn-secondary btn-compact"
          onClick={() => void runAction('backup_export', () => exportUserDataBackup(t), 'backup.export_failed')}
          disabled={busyAction !== null}
        >
          {busyAction === 'backup_export' ? (
            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
          ) : (
            <FileOutput size={13} strokeWidth={1.5} />
          )}
          <span>
            {busyAction === 'backup_export' ? t('backup.exporting') : t('settings.export_user_data')}
          </span>
        </button>

        <button
          type="button"
          className="btn-fluent btn-secondary btn-compact"
          onClick={() => fileInputRef.current?.click()}
          disabled={busyAction !== null}
        >
          {busyAction === 'backup_import' ? (
            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
          ) : (
            <FileInput size={13} strokeWidth={1.5} />
          )}
          <span>
            {busyAction === 'backup_import' ? t('backup.importing') : t('settings.import_user_data')}
          </span>
        </button>

        <button
          type="button"
          className="btn-fluent btn-secondary btn-compact"
          onClick={() => void runAction('log_export', () => exportDiagnosticLogs(t), 'zlog.export_failed')}
          disabled={busyAction !== null}
        >
          {busyAction === 'log_export' ? (
            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
          ) : (
            <FileArchive size={13} strokeWidth={1.5} />
          )}
          <span>{busyAction === 'log_export' ? t('zlog.exporting') : t('zlog.export')}</span>
        </button>

        <button
          type="button"
          className="btn-fluent btn-secondary btn-compact"
          onClick={() => void handleOpenLogDir()}
          disabled={busyAction !== null}
        >
          <FolderOpen size={13} strokeWidth={1.5} />
          <span>{t('zlog.open_folder')}</span>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              void runAction(
                'backup_import',
                () => importUserDataBackup(f, t),
                'backup.import_failed',
                () => {
                  if (fileInputRef.current) fileInputRef.current.value = '';
                },
              );
            }
          }}
        />
      </div>
    </div>
  );
};
