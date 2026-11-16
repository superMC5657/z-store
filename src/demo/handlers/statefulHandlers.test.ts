/**
 * 演示站有状态 handler 与后端同口径：
 * - 待收录：状态流转门禁、按 updated_at 倒序、Issue 预填链接 / payload 形态、许可名单；
 * - 更新规则：持久化、锁定清跳过版本、锁定后拒收跳过、全撤销即删除；
 * - 关注提醒：知道了 / 恢复往返，取消关注后不再返回。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getWatchSet, hydrate } from '../demoState';
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
  resetCustomAppsCache,
} from './customApps';
import { handleImportMatchedApps, handleScanAndMatchLocalApps } from './catalog';
import {
  handleGetInstalledApps,
  handleGetUpdateRules,
  handleSetAppFrozen,
  handleSetAppHidden,
  handleSetAppSkipVersion,
  resetUpdateRulesCache,
} from './installer';
import {
  handleDismissWatchNotification,
  handleGetDismissedWatchNotifications,
  handleGetWatchNotifications,
  handleRestoreWatchNotification,
  handleUnwatchApp,
  resetWatchNotificationsCache,
} from './social';

beforeEach(() => {
  window.localStorage.clear();
  hydrate();
  resetCustomAppsCache();
  resetUpdateRulesCache();
  resetWatchNotificationsCache();
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
    resetCustomAppsCache();
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
    resetUpdateRulesCache();
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
    expect(getWatchSet().has(first.app_id)).toBe(true);
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
