/**
 * Task 1 — device-platform global filter.
 *
 * SECTION A (baseline characterization): pins the CURRENT single-select
 * matchPlatform semantics copied verbatim from src/views/CategoriesView.tsx:56-62.
 * Self-contained: runs green on unchanged code with no new module required.
 */
// @ts-ignore - vitest is fetched transiently via npx (not a repo dep per task scope)
import { describe, expect, it } from 'vitest';

interface BaselineApp {
  platforms?: string[];
}

// Verbatim copy of CategoriesView.matchPlatform (single-select) for pinning.
function baselineMatchPlatform(app: BaselineApp, platform: string): boolean {
  if (platform === 'all') return true;
  if (!app.platforms || app.platforms.length === 0) {
    return platform === 'windows';
  }
  return app.platforms.some((p) => p.toLowerCase() === platform.toLowerCase());
}

describe('baseline: single-select matchPlatform (CategoriesView:56-62)', () => {
  it("matches everything when platform is 'all'", () => {
    expect(baselineMatchPlatform({ platforms: ['linux'] }, 'all')).toBe(true);
    expect(baselineMatchPlatform({}, 'all')).toBe(true);
  });

  it('treats missing/empty platforms as windows-only', () => {
    expect(baselineMatchPlatform({}, 'windows')).toBe(true);
    expect(baselineMatchPlatform({ platforms: [] }, 'windows')).toBe(true);
    expect(baselineMatchPlatform({}, 'linux')).toBe(false);
    expect(baselineMatchPlatform({ platforms: [] }, 'ios')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(baselineMatchPlatform({ platforms: ['Windows'] }, 'windows')).toBe(true);
    expect(baselineMatchPlatform({ platforms: ['macOS'] }, 'MACOS')).toBe(true);
  });

  it('rejects non-listed platforms', () => {
    expect(baselineMatchPlatform({ platforms: ['linux'] }, 'windows')).toBe(false);
  });
});

/**
 * SECTION B (new multi-select spec): exercises src/lib/platformFilter.ts.
 * Expected to FAIL (collection error) until the module is implemented.
 */
import {
  PLATFORM_IDS,
  matchPlatformSet,
  normalizePlatform,
  togglePlatformSet,
} from './platformFilter';

describe('platformFilter: multi-select set semantics', () => {
  it('exposes the five known platform ids', () => {
    expect(PLATFORM_IDS).toEqual(['windows', 'android', 'macos', 'linux', 'ios']);
  });

  it('normalizePlatform lowercases ids', () => {
    expect(normalizePlatform('Windows')).toBe('windows');
    expect(normalizePlatform('MACOS')).toBe('macos');
  });

  it('matches case-insensitively against the selected set', () => {
    expect(matchPlatformSet({ platforms: ['Windows'] }, new Set(['windows']))).toBe(true);
    expect(matchPlatformSet({ platforms: ['macOS'] }, new Set(['MacOS']))).toBe(true);
    expect(matchPlatformSet({ platforms: ['linux'] }, new Set(['windows']))).toBe(false);
  });

  it('empty/missing-platforms app matches windows only', () => {
    expect(matchPlatformSet({}, new Set(['windows']))).toBe(true);
    expect(matchPlatformSet({ platforms: [] }, new Set(['windows']))).toBe(true);
    expect(matchPlatformSet({}, new Set(['linux']))).toBe(false);
    expect(matchPlatformSet({ platforms: [] }, new Set(['linux', 'ios']))).toBe(false);
  });

  it('discards unknown ids at set-construction (matches known ids only)', () => {
    expect(matchPlatformSet({ platforms: ['windows'] }, new Set(['windows', 'amigaos']))).toBe(true);
    expect(matchPlatformSet({ platforms: ['amigaos'] }, new Set(['windows']))).toBe(false);
    expect(matchPlatformSet({ platforms: ['windows'] }, new Set(['amigaos']))).toBe(false);
  });

  it('full-select matches all apps', () => {
    const all = new Set(PLATFORM_IDS);
    expect(matchPlatformSet({ platforms: ['ios'] }, all)).toBe(true);
    expect(matchPlatformSet({}, all)).toBe(true);
    expect(matchPlatformSet({ platforms: ['android', 'linux'] }, all)).toBe(true);
  });

  it('toggle adds a missing id and reports changed=true', () => {
    const { next, changed } = togglePlatformSet(new Set(['windows']), 'linux');
    expect(changed).toBe(true);
    expect(next).toEqual(new Set(['windows', 'linux']));
  });

  it('toggle removes a present id and reports changed=true', () => {
    const { next, changed } = togglePlatformSet(new Set(['windows', 'linux']), 'linux');
    expect(changed).toBe(true);
    expect(next).toEqual(new Set(['windows']));
  });

  it('toggle-last-one keeps the set and reports changed=false', () => {
    const prev = new Set(['windows']);
    const { next, changed } = togglePlatformSet(prev, 'windows');
    expect(changed).toBe(false);
    expect(next).toBe(prev);
  });

  it('toggle with unknown id returns prev unchanged with changed=false', () => {
    const prev = new Set(['windows', 'linux']);
    const { next, changed } = togglePlatformSet(prev, 'amigaos');
    expect(changed).toBe(false);
    expect(next).toBe(prev);
  });
});
