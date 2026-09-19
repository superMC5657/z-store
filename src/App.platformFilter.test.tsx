/**
 * Task 3 — App-level platform filter state + localStorage persistence.
 *
 * SECTION A (BASELINE characterization): pins CURRENT behavior on unchanged
 * code — a full 5-platform selection is equivalent to "unfiltered", and the
 * three discovery views receive their data through the same `apps` prop name.
 * Must stay GREEN before AND after the Task 3 implementation.
 */
// @ts-ignore - vitest is fetched transiently via npx (not a repo dep per task scope)
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLATFORM_IDS, matchPlatformSet } from './lib/platformFilter';

interface BaselineApp {
  platforms?: string[];
}

const FIXTURE: BaselineApp[] = [
  { platforms: ['windows'] },
  { platforms: ['ios'] },
  { platforms: ['android', 'linux'] },
  {},
  { platforms: [] },
  { platforms: ['macOS'] },
];

describe('baseline: full platform selection is equivalent to unfiltered', () => {
  it('a full 5-platform set matches every fixture app', () => {
    const full = new Set<string>(PLATFORM_IDS);
    expect(full.size).toBe(5);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, full)).toBe(true);
    }
  });

  it('Home/Trends/Categories receive data via the same `apps` prop name', () => {
    const src = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf-8');
    for (const view of ['HomeView', 'TrendsView', 'CategoriesView']) {
      const openTag = new RegExp(`<${view}[\\s>]`);
      expect(src, `${view} rendered in App.tsx`).toMatch(openTag);
      const withAppsProp = new RegExp(`<${view}[^]*?apps=\\{`);
      expect(src, `${view} receives an apps={...} prop`).toMatch(withAppsProp);
    }
  });
});

/**
 * SECTION B (Task 3 implementation): localStorage persistence tri-state.
 * Written FAILING-FIRST: assertion run against the pre-Task-3 App.tsx fails
 * (no PLATFORM_FILTER_STORAGE_KEY / parseSelectedPlatforms export), then
 * passes after the implementation. Covers the mandated tri-state matrix:
 * no key → full 5; written ["windows","ios"] + reload → restored;
 * "{bad" corrupt → full fallback; throwing storage → still renders (full set).
 */
// @ts-ignore - App.tsx ships without a vitest dep; resolved transiently via npx
import {
  PLATFORM_FILTER_STORAGE_KEY,
  loadSelectedPlatforms,
  parseSelectedPlatforms,
} from './App';

describe('task3: platform-filter persistence tri-state', () => {
  it('uses the stable storage key zstore:platform-filter:v1', () => {
    expect(PLATFORM_FILTER_STORAGE_KEY).toBe('zstore:platform-filter:v1');
  });

  it('no key (null) → full 5-platform set', () => {
    expect(parseSelectedPlatforms(null)).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms(undefined)).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('')).toEqual(new Set(PLATFORM_IDS));
  });

  it('written ["windows","ios"] + reload → restored exactly', () => {
    const written = JSON.stringify(['windows', 'ios']);
    const reloaded = parseSelectedPlatforms(written);
    expect(reloaded).toEqual(new Set(['windows', 'ios']));
    // round-trip through the write-back serialization shape
    expect(parseSelectedPlatforms(JSON.stringify([...reloaded]))).toEqual(reloaded);
  });

  it('corrupt "{bad" → full-set fallback', () => {
    expect(parseSelectedPlatforms('{bad')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('not-json-at-all{{{')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('"just-a-string"')).toEqual(new Set(PLATFORM_IDS));
  });

  it('unknown ids are whitelisted; unknown-only/empty → full fallback', () => {
    expect(parseSelectedPlatforms(JSON.stringify(['windows', 'amigaos']))).toEqual(
      new Set(['windows'])
    );
    expect(parseSelectedPlatforms(JSON.stringify(['amigaos']))).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms(JSON.stringify([]))).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms(JSON.stringify(['WINDOWS', 'Ios']))).toEqual(
      new Set(['windows', 'ios'])
    );
  });

  it('throwing storage → still renders (loader never throws, yields full set)', () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g['window'];
    g['window'] = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
    };
    try {
      expect(() => loadSelectedPlatforms()).not.toThrow();
      expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
    } finally {
      if (prevWindow === undefined) delete g['window'];
      else g['window'] = prevWindow;
    }
  });

  it('App wires platformFilteredApps into Home/Trends/Categories via the same apps prop', () => {
    const src = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf-8');
    expect(src).toMatch(/togglePlatformSet/);
    expect(src).toMatch(/platformFilteredApps/);
    expect(src).toMatch(/localStorage\.setItem\(PLATFORM_FILTER_STORAGE_KEY/);
    // separation: filter preference stays out of api.getSettings()/UserDataBackup
    expect(src).toMatch(/NOT wired into api\.getSettings\(\)\/UserDataBackup/);
    for (const view of ['HomeView', 'TrendsView', 'CategoriesView']) {
      const wired = new RegExp(`<${view}[^]*?apps=\\{platformFilteredApps\\}`);
      expect(src, `${view} receives apps={platformFilteredApps}`).toMatch(wired);
    }
  });

  it('task7: Sidebar platformCounts derive from FULL apps per PLATFORM_IDS via matchPlatformSet (same source as hall counts)', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf-8');
    // full-apps basis (NOT platformFilteredApps): each badge answers
    // "how many apps target this device" with the same matcher the hall uses.
    expect(appSrc).toMatch(/for \(const id of PLATFORM_IDS\)/);
    expect(appSrc).toMatch(/counts\[id\] = apps\.filter\(\(a\) => matchPlatformSet\(a, new Set\(\[id\]\)\)\)\.length/);
    // passed through to Sidebar, never recomputed there.
    expect(appSrc).toMatch(/platformCounts=\{platformCounts\}/);
    const sidebarSrc = fs.readFileSync(path.join(__dirname, 'components', 'Sidebar.tsx'), 'utf-8');
    expect(sidebarSrc).not.toMatch(/matchPlatformSet/);
    expect(sidebarSrc).not.toMatch(/from '.*platformFilter'/);
    // Home + Trends + Categories reset buttons all route to the same full-set restore.
    for (const view of ['HomeView', 'TrendsView', 'CategoriesView']) {
      const reset = new RegExp(`<${view}[^]*?onResetPlatformFilter=\\{\\(\\) => setSelectedPlatforms\\(new Set<string>\\(PLATFORM_IDS\\)\\)\\}`);
      expect(appSrc, `${view} wires onResetPlatformFilter to the full-set restore`).toMatch(reset);
    }
  });
});
