/**
 * 演示种子自洽性：种子引用的应用都在 catalog.json 里、版本从目录派生，
 * 更新规则在「我的应用」里都看得到效果，待收录各组满足后端对应档位的校验。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoUpdates, findSummary, summaries } from './fixtures';
import { getInstalledApps, hydrate, LS, lsGet } from './demoState';
import {
  buildSeedCustomApps,
  buildSeedUpdateRules,
  buildSeedWatchNotifications,
  previousVersion,
  SEED_CATALOG_REFS,
  SEED_WATCHED,
} from './seed';
import { handleGetLicenseAllowlist } from './handlers/customApps';
import type { DraftEntryWire } from '../services/custom';

const NOW = 1_800_000_000;

beforeEach(() => {
  window.localStorage.clear();
  hydrate();
});

describe('demo seed ↔ catalog.json', () => {
  it('every referenced app id exists in the catalog', () => {
    const missing = SEED_CATALOG_REFS.filter((id) => !findSummary(id));
    expect(missing).toEqual([]);
  });

  it('installed apps are Windows installs of Windows-capable catalog apps', () => {
    const installed = getInstalledApps();
    expect(installed.length).toBeGreaterThan(10);
    for (const app of installed) {
      expect(findSummary(app.app_id)?.platforms ?? []).toContain('windows');
      expect(['msi', 'setup_exe', 'portable_zip', 'system_import']).toContain(app.install_method);
    }
  });

  it('first visit persists the seeds; an emptied list stays empty', () => {
    expect((lsGet<unknown[]>(LS.installed, [])).length).toBe(getInstalledApps().length);
    window.localStorage.setItem(LS.installed, '[]');
    hydrate();
    expect(getInstalledApps()).toEqual([]);
  });
});

describe('demo updates honour the seeded rules', () => {
  it('frozen and skipped-latest apps produce no update; hidden apps still do', () => {
    const rules = buildSeedUpdateRules(NOW);
    const installedIds = new Set(getInstalledApps().map((a) => a.app_id.toLowerCase()));
    for (const r of rules) expect(installedIds.has(r.app_id)).toBe(true);

    const updates = new Set(buildDemoUpdates(getInstalledApps(), rules).map((u) => u.app_id.toLowerCase()));
    expect(updates.has('microsoft/vscode')).toBe(false); // frozen
    expect(updates.has('obsproject/obs-studio')).toBe(false); // skipped == catalog latest
    expect(updates.has('alacritty/alacritty')).toBe(true); // hidden, still listed
    for (const id of ['microsoft/powertoys', 'localsend/localsend', 'qbittorrent/qbittorrent', 'laurent22/joplin']) {
      expect(updates.has(id)).toBe(true);
    }
    expect(buildDemoUpdates(getInstalledApps(), []).some((u) => u.app_id === 'obsproject/obs-studio')).toBe(true);
  });

  it('previousVersion steps back the last non-zero numeric run', () => {
    expect(previousVersion('release-5.3.0')).toBe('release-5.2.0');
    expect(previousVersion('v1.18.2')).toBe('v1.18.1');
    expect(previousVersion('v0.102.3101')).toBe('v0.102.3100');
    expect(previousVersion('v0.0.0')).toBe('v0.0.0');
  });
});

describe('demo watch notifications', () => {
  it('only reference watched apps, at the catalog latest version', () => {
    const { pending, dismissed } = buildSeedWatchNotifications(NOW);
    const watched = new Set(SEED_WATCHED);
    expect(pending.length).toBeGreaterThan(0);
    expect(dismissed.length).toBeGreaterThan(0);
    for (const n of [...pending, ...dismissed]) {
      expect(watched.has(n.app_id)).toBe(true);
      expect(n.version).toBe(findSummary(n.app_id)?.latest_version);
    }
  });
});

describe('demo custom apps', () => {
  const categories = new Set(summaries.map((s) => s.category));
  const allowed = new Set(handleGetLicenseAllowlist().allowed.map((l) => l.toUpperCase()));
  const entries = buildSeedCustomApps(NOW);
  const strict = (e: DraftEntryWire): boolean => e.status !== 'draft';

  it('covers draft / collected / submitted / archived', () => {
    expect(new Set(entries.map((e) => e.status))).toEqual(new Set(['draft', 'collected', 'submitted']));
    expect(entries.some((e) => e.archived)).toBe(true);
  });

  it('collected and submitted rows pass the submit-grade checks', () => {
    for (const e of entries.filter(strict)) {
      expect(e.item.homepage ?? '').toMatch(/^https?:\/\//);
      expect(allowed.has(e.item.license.toUpperCase())).toBe(true);
      expect(categories.has(e.item.category)).toBe(true);
      expect(e.id).toBe(`${e.item.owner}/${e.item.repo}`.toLowerCase());
      expect(e.item.is_verified).toBe(false);
    }
  });

  it('category names match the catalog', () => {
    for (const e of entries) {
      const sample = summaries.find((s) => s.category === e.item.category);
      expect(e.item.category_name).toBe(sample?.category_name);
    }
  });

  it('submitted rows link into the catalog repo issues', () => {
    for (const e of entries.filter((x) => x.status === 'submitted')) {
      expect(e.pr_url).toMatch(/^https:\/\/github\.com\/superMC5657\/z-store-catalog\/issues\?/);
    }
    for (const e of entries.filter((x) => x.status !== 'submitted')) expect(e.pr_url).toBeNull();
  });
});
