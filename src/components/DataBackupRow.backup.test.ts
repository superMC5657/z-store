import { describe, expect, it } from 'vitest';
import { buildUserDataBackup, BACKUP_EXCLUDED_KEYS } from './DataBackupRow';
import type { UserDataBackup } from '../types';

// P1-8（TDD 红灯测试）：备份 schema 必须覆盖除 github_token 之外的全部设置项，
// version 保持为 1，且导出 → JSON → 导入后字段无损往返。

// 与 getSettings() 返回形态一致：值全为字符串。
const FULL_SETTINGS: Record<string, string> = {
  theme: 'dark',
  language: 'zh-CN',
  ui_scale: '110',
  font_size: '16',
  portable_dir: 'D:\\apps',
  download_dir: 'D:\\dl',
  active_mirror: 'direct',
  github_token: 'gho_should-never-leak',
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

describe('DataBackupRow backup schema (P1-8)', () => {
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
});
