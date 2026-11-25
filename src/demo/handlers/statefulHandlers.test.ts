/** 测试演示站待收录、更新规则与关注提醒有状态 handler 的门禁与持久化。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { demoStore, hydrateDemoStore, resetDemoStore } from '../demoState';
import {
  handleCollectLocalApp,
  handleGetCustomAppPrPayload,
  handleGetCustomAppPrUrl,
  handleGetLicenseAllowlist,
  handleListCustomApps,
  handleMarkCustomSubmitted,
  handleRevertCollectedApp,
  handleWithdrawSubmitted,
  parseLicenseGate,
} from './customApps';
import {
  handleGetAppIconCycle,
  handleImportMatchedApps,
  handleScanAndMatchLocalApps,
} from './catalog';
import {
  handleGetSettings,
  handleImportUserData,
  handleSaveSetting,
  handleSwitchMirror,
} from './settings';
import {
  handleGetInstalledApps,
  handleGetUpdateRules,
  handleSetAppFrozen,
  handleSetAppHidden,
  handleSetAppSkipVersion,
} from './installer';
import {
  handleDismissWatchNotification,
  handleGetDismissedWatchNotifications,
  handleGetWatchNotifications,
  handleRestoreWatchNotification,
  handleUnwatchApp,
} from './social';

beforeEach(() => {
  resetDemoStore();
});

describe('custom apps mock', () => {
  const byStatus = (status: string) =>
    handleListCustomApps({}).find((e) => e.status === status && !e.archived)!;

  it('lists newest-updated first and hides archived rows by default', () => {
    const rows = handleListCustomApps({});
    expect(rows.every((r) => !r.archived)).toBe(true);
    expect(rows.map((r) => r.updated_at)).toEqual([...rows.map((r) => r.updated_at)].sort((a, b) => b - a));
    expect(handleListCustomApps({ includeArchived: true }).length).toBe(rows.length + 1);

    const draft = byStatus('draft');
    handleCollectLocalApp({ id: draft.id });
    expect(handleListCustomApps({})[0].id).toBe(draft.id);
  });

  it('rejects the same transitions the backend rejects', () => {
    const draft = byStatus('draft');
    const submitted = byStatus('submitted');
    const archived = handleListCustomApps({ includeArchived: true }).find((e) => e.archived)!;
    expect(() => handleMarkCustomSubmitted({ id: draft.id, prUrl: 'https://x.test/1' })).toThrow('须先收录');
    expect(() => handleRevertCollectedApp({ id: draft.id })).toThrow('仅已收录行');
    expect(() => handleWithdrawSubmitted({ id: draft.id })).toThrow('仅已提交行');
    expect(() => handleCollectLocalApp({ id: submitted.id })).toThrow('已提交行');
    expect(() => handleCollectLocalApp({ id: archived.id })).toThrow('归档');
    expect(() => handleGetCustomAppPrUrl({ id: draft.id })).toThrow('须先收录');
  });

  it('collected → submitted → withdrawn round-trip', () => {
    const collected = byStatus('collected');
    expect(() => handleMarkCustomSubmitted({ id: collected.id, prUrl: 'http://x.test' })).toThrow('https');
    const sub = handleMarkCustomSubmitted({ id: collected.id, prUrl: 'https://github.com/o/r/issues/9' });
    expect(sub.status).toBe('submitted');
    expect(sub.pr_url).toBe('https://github.com/o/r/issues/9');
    const back = handleWithdrawSubmitted({ id: collected.id });
    expect(back.status).toBe('collected');
    expect(back.pr_url).toBeNull();
    hydrateDemoStore();
    expect(handleListCustomApps({}).find((e) => e.id === collected.id)?.status).toBe('collected');
  });

  it('builds the prefilled catalog Issue url and normalized payload', () => {
    const collected = byStatus('collected');
    const url = handleGetCustomAppPrUrl({ id: collected.id });
    expect(url.startsWith('https://github.com/superMC5657/z-store-catalog/issues/new?title=')).toBe(true);
    expect(decodeURIComponent(url)).toContain(`[收录申请] ${collected.id}`);

    const payload = JSON.parse(handleGetCustomAppPrPayload({ id: collected.id })) as Record<string, unknown>;
    expect(payload.id).toBe(collected.id);
    expect(payload.is_verified).toBe(true);
    expect(payload).not.toHaveProperty('install_dirs');
    expect(payload).not.toHaveProperty('publishers');
    expect(Object.keys(payload).slice(0, 4)).toEqual(['id', 'name', 'owner', 'repo']);
  });

  it('reads the license allowlist from the backend config', () => {
    const gate = handleGetLicenseAllowlist();
    expect(gate.enabled).toBe(true);
    expect(gate.allowed).toContain('MIT');
    expect(gate.allowed.length).toBeGreaterThan(10);
    expect(parseLicenseGate('[license_gate]\nenabled = false\nallowed = ["MIT", "ISC"]\n[other]\nallowed = ["X"]'))
      .toEqual({ enabled: false, allowed: ['MIT', 'ISC'] });
  });
});

describe('update rules mock', () => {
  const rule = (id: string) => handleGetUpdateRules().find((r) => r.app_id === id);

  it('persists changes and sorts newest first', () => {
    handleSetAppHidden({ appId: 'rustdesk/rustdesk', isHidden: true });
    hydrateDemoStore();
    expect(handleGetUpdateRules()[0].app_id).toBe('rustdesk/rustdesk');
    expect(rule('rustdesk/rustdesk')?.is_hidden).toBe(true);
  });

  it('freezing clears the skipped version and blocks new skips', () => {
    expect(rule('obsproject/obs-studio')?.skipped_version).not.toBeNull();
    handleSetAppFrozen({ appId: 'obsproject/obs-studio', isFrozen: true });
    expect(rule('obsproject/obs-studio')?.skipped_version).toBeNull();
    handleSetAppSkipVersion({ appId: 'obsproject/obs-studio', version: '99.0.0' });
    expect(rule('obsproject/obs-studio')?.skipped_version).toBeNull();
  });

  it('drops a rule once every field is cleared', () => {
    handleSetAppHidden({ appId: 'alacritty/alacritty', isHidden: false });
    expect(rule('alacritty/alacritty')).toBeUndefined();
  });
});

describe('watch notifications mock', () => {
  it('dismiss and restore move one notification between the lists', () => {
    const [first] = handleGetWatchNotifications();
    expect(first).toBeDefined();
    expect(handleDismissWatchNotification({ appId: first.app_id })).toBe(true);
    expect(handleGetWatchNotifications().some((n) => n.app_id === first.app_id)).toBe(false);
    expect(handleGetDismissedWatchNotifications()[0].app_id).toBe(first.app_id);

    expect(handleRestoreWatchNotification({ appId: first.app_id })).toBe(true);
    expect(handleGetWatchNotifications()[0]).toEqual(first);
    expect(handleDismissWatchNotification({ appId: 'nobody/nothing' })).toBe(false);
  });

  it('unwatching an app hides its notifications', () => {
    const [first] = handleGetWatchNotifications();
    expect(demoStore().watched.has(first.app_id)).toBe(true);
    handleUnwatchApp({ appId: first.app_id });
    expect(handleGetWatchNotifications().some((n) => n.app_id === first.app_id)).toBe(false);
  });
});

describe('local app scan mock', () => {
  it('offers only unmanaged apps across tiers and imports them into my apps', () => {
    const installedIds = new Set(handleGetInstalledApps().map((i) => i.app_id.toLowerCase()));
    const scanned = handleScanAndMatchLocalApps();
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.some((m) => installedIds.has(m.catalog_id.toLowerCase()))).toBe(false);
    expect(new Set(scanned.map((m) => m.confidence_tier))).toEqual(new Set(['high', 'medium', 'low']));
    expect(scanned.every((m) => (m.match_reasons ?? []).length > 0)).toBe(true);

    const high = scanned.filter((m) => m.confidence_tier === 'high');
    const requests = high.map((m) => ({
      app_id: m.catalog_id,
      app_name: m.name,
      version: m.local_version,
      install_path: m.resolved_executable_path,
    }));
    expect(handleImportMatchedApps({ apps: requests })).toBe(high.length);
    // 重复导入不新增
    expect(handleImportMatchedApps({ apps: requests })).toBe(0);

    const after = handleGetInstalledApps();
    for (const m of high) {
      const row = after.find((i) => i.app_id === m.catalog_id);
      expect(row?.install_method).toBe('system_import');
    }
    const rescanned = handleScanAndMatchLocalApps().map((m) => m.catalog_id);
    expect(rescanned.some((id) => high.some((m) => m.catalog_id === id))).toBe(false);
  });
});

describe('settings & icon cycle demo parity (F-23)', () => {
  it('handleImportUserData returns numeric settings_applied matching Rust usize', () => {
    const res = handleImportUserData();
    expect(typeof res.settings_applied).toBe('number');
    expect(res).toEqual({
      favorites_added: 0,
      watched_added: 0,
      settings_applied: 0,
    });
  });

  it('handleSaveSetting and handleSwitchMirror persist across hydrate and merge into handleGetSettings', () => {
    handleSaveSetting({ key: 'portable_dir', value: 'D:\\Apps' });
    handleSaveSetting({ key: 'update_frequency', value: 'manual' });
    handleSwitchMirror({ mirrorId: 'direct' });

    hydrateDemoStore();

    const settings = handleGetSettings({
      ui_scale: '110',
      font_size: '16',
      theme: 'dark',
      language: 'en-US',
    });
    expect(settings).toMatchObject({
      portable_dir: 'D:\\Apps',
      update_frequency: 'manual',
      active_mirror: 'direct',
      ui_scale: '110',
      font_size: '16',
      theme: 'dark',
      language: 'en-US',
    });
  });

  it('handleGetAppIconCycle starts at level 1 and wraps cleanly within 1..=total_levels', () => {
    const restored = handleGetAppIconCycle(
      { appId: 'rustdesk/rustdesk' },
      'restore_or_fetch_icon_cycle',
    );
    expect(restored).not.toBeNull();
    expect(restored!.level).toBe(1);
    expect(restored!.total_levels).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 4; i += 1) {
      const cycled = handleGetAppIconCycle({ appId: 'rustdesk/rustdesk' }, 'cycle_app_icon');
      expect(cycled).not.toBeNull();
      expect(cycled!.total_levels).toBeDefined();
      expect(cycled!.level).toBeGreaterThanOrEqual(1);
      expect(cycled!.level).toBeLessThanOrEqual(cycled!.total_levels!);
    }
  });
});
