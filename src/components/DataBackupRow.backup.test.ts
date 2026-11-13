import { describe, expect, it, vi } from 'vitest';
import {
  buildUserDataBackup,
  exportInstalledAppsBackup,
  exportUserDataBackup,
  exportDiagnosticLogs,
  BACKUP_EXCLUDED_KEYS,
} from './DataBackupRow';
import type { InstalledApp, UserDataBackup } from '../types';
import { tauriApi } from '../services/api';
import i18n from '../i18n';

// 备份 schema 必须覆盖除 github_token 之外的全部设置项，
// version 保持为 1，且导出 → JSON → 导入后字段无损往返。

// 与 getSettings() 返回形态一致：值全为字符串。
// 凭据键一并入样（`github_token` / `github_oauth_token`；
// `get_settings` 不回传凭据键，此处锁死导出排除保证）。
const FULL_SETTINGS: Record<string, string> = {
  theme: 'dark',
  language: 'zh-CN',
  ui_scale: '110',
  font_size: '16',
  portable_dir: 'D:\\apps',
  download_dir: 'D:\\dl',
  active_mirror: 'direct',
  github_token: 'gho_should-never-leak',
  github_oauth_token: 'gho_oauth-should-never-leak',
  launch_on_startup: 'true',
  update_frequency: 'daily',
  detail_cache_ttl_minutes: '60',
  catalog_source_url: 'https://example.com/catalog.json',
  watch_notify_frequency: 'startup',
};

const EXPECTED_SETTINGS = {
  theme: 'dark',
  language: 'zh-CN',
  ui_scale: '110',
  font_size: '16',
  portable_dir: 'D:\\apps',
  download_dir: 'D:\\dl',
  active_mirror: 'direct',
  launch_on_startup: true,
  update_frequency: 'daily',
  detail_cache_ttl_minutes: 60,
  catalog_source_url: 'https://example.com/catalog.json',
  watch_notify_frequency: 'startup',
};

describe('DataBackupRow backup schema', () => {
  it('导出覆盖全部设置项（12 个），version 保持为 1', () => {
    const backup = buildUserDataBackup(['a/b'], ['c/d'], FULL_SETTINGS);
    expect(backup.version).toBe(1);
    expect(backup.favorites).toEqual(['a/b']);
    expect(backup.watched).toEqual(['c/d']);
    expect(backup.settings).toEqual(EXPECTED_SETTINGS);
  });

  it('github_token 被排除且有文档说明（永不写入备份）', () => {
    expect(BACKUP_EXCLUDED_KEYS).toContain('github_token');
    const backup = buildUserDataBackup([], [], FULL_SETTINGS);
    expect('github_token' in backup.settings).toBe(false);
    expect(JSON.stringify(backup)).not.toContain('gho_should-never-leak');
  });

  it('OAuth 令牌 github_oauth_token 同样被排除（ADR-0020 备份排除保证）', () => {
    const backup = buildUserDataBackup([], [], FULL_SETTINGS);
    expect('github_oauth_token' in backup.settings).toBe(false);
    expect('github_oauth_user' in backup.settings).toBe(false);
    expect(JSON.stringify(backup)).not.toContain('gho_oauth-should-never-leak');
  });

  it('导出 → JSON → 导入往返无损', () => {
    const backup = buildUserDataBackup(['a/b'], ['c/d'], FULL_SETTINGS);
    const roundTripped = JSON.parse(JSON.stringify(backup)) as UserDataBackup;
    expect(roundTripped.version).toBe(1);
    expect(roundTripped.settings).toEqual(EXPECTED_SETTINGS);
    expect('github_token' in roundTripped.settings).toBe(false);
  });

  it('缺失的设置项导出为 undefined（不污染备份）', () => {
    const backup = buildUserDataBackup([], [], {});
    expect(backup.version).toBe(1);
    expect(backup.settings).toEqual({});
  });

  it('exportUserDataBackup writes via exportBackupFile and returns path in message', async () => {
    const getFavoritesSpy = vi.spyOn(tauriApi, 'getFavorites').mockResolvedValue(['a/b']);
    const getWatchedSpy = vi.spyOn(tauriApi, 'getWatchedApps').mockResolvedValue([]);
    const getSettingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({ theme: 'dark' });
    const listCustomSpy = vi.spyOn(tauriApi, 'listCustomApps').mockResolvedValue([]);
    const exportSpy = vi
      .spyOn(tauriApi, 'exportBackupFile')
      .mockImplementation(async (fileName) => `C:\\logs\\${fileName}`);

    try {
      const msg = await exportUserDataBackup(i18n.t.bind(i18n));
      expect(exportSpy).toHaveBeenCalledTimes(1);
      const [fileName, content] = exportSpy.mock.calls[0];
      expect(fileName).toMatch(/^z-store-backup-\d{8}-\d{6}\.json$/);
      expect(JSON.parse(content)).toMatchObject({ version: 1, favorites: ['a/b'] });
      expect(msg).toContain(`C:\\logs\\${fileName}`);
    } finally {
      getFavoritesSpy.mockRestore();
      getWatchedSpy.mockRestore();
      getSettingsSpy.mockRestore();
      listCustomSpy.mockRestore();
      exportSpy.mockRestore();
    }
  });

  it('export helpers return null quietly when user cancels save dialog', async () => {
    const sampleApp: InstalledApp = {
      app_id: 'owner/repo',
      app_name: 'Repo',
      version: '1.0.0',
      installed_at: 1700000000,
      install_path: 'C:\\Apps\\Repo',
      install_method: 'direct_zip',
      asset_name: 'repo.zip',
      asset_sha256: 'abc',
    };
    const getInstalledSpy = vi.spyOn(tauriApi, 'getInstalledApps').mockResolvedValue([sampleApp]);
    const getFavoritesSpy = vi.spyOn(tauriApi, 'getFavorites').mockResolvedValue(['owner/repo']);
    const getWatchedSpy = vi.spyOn(tauriApi, 'getWatchedApps').mockResolvedValue([]);
    const getSettingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    const listCustomSpy = vi.spyOn(tauriApi, 'listCustomApps').mockResolvedValue([]);
    const exportFileSpy = vi.spyOn(tauriApi, 'exportBackupFile').mockResolvedValue(null);
    const exportLogSpy = vi.spyOn(tauriApi, 'exportLogBundle').mockResolvedValue(null);

    try {
      const t = i18n.t.bind(i18n);
      expect(await exportInstalledAppsBackup(t)).toBeNull();
      expect(await exportUserDataBackup(t)).toBeNull();
      expect(await exportDiagnosticLogs(t)).toBeNull();
    } finally {
      getInstalledSpy.mockRestore();
      getFavoritesSpy.mockRestore();
      getWatchedSpy.mockRestore();
      getSettingsSpy.mockRestore();
      listCustomSpy.mockRestore();
      exportFileSpy.mockRestore();
      exportLogSpy.mockRestore();
    }
  });
});
