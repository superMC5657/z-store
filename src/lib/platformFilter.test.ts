/**
 * Task 1 — device-platform global filter.
 *
 * SECTION A (baseline characterization): pins the CURRENT single-select
 * matchPlatform semantics copied verbatim from src/views/CategoriesView.tsx:56-62.
 * Self-contained: runs green on unchanged code with no new module required.
 */
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
  parseSelectedPlatformArray,
  togglePlatformSet,
} from './platformFilter';
import type { PlatformId } from './platformFilter';

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

  it('toggle adds a missing id (returns the next Set)', () => {
    expect(togglePlatformSet(new Set<PlatformId>(['windows']), 'linux')).toEqual(
      new Set(['windows', 'linux'])
    );
  });

  it('toggle removes a present id (returns the next Set)', () => {
    expect(togglePlatformSet(new Set<PlatformId>(['windows', 'linux']), 'linux')).toEqual(
      new Set(['windows'])
    );
  });

  it('toggle-last-one allows the empty set (select-nothing is valid)', () => {
    expect(togglePlatformSet(new Set<PlatformId>(['windows']), 'windows')).toEqual(
      new Set<PlatformId>([])
    );
  });

  it('toggle chain can empty all 5 then re-add (empty matches nothing)', () => {
    let current: Set<PlatformId> = new Set(PLATFORM_IDS);
    for (const id of PLATFORM_IDS) {
      current = togglePlatformSet(current, id);
    }
    expect(current).toEqual(new Set<PlatformId>([]));
    // every app misses an empty selection -> pages show filter-empty states
    expect(matchPlatformSet({ platforms: ['windows'] }, current)).toBe(false);
    expect(matchPlatformSet({}, current)).toBe(false);
    // rechecking works
    expect(togglePlatformSet(current, 'linux')).toEqual(new Set(['linux']));
  });

  it('toggle with unknown id is a no-op returning an equal copy (no fallback-to-all)', () => {
    const prev = new Set<PlatformId>(['windows', 'linux']);
    const next = togglePlatformSet(prev, 'amigaos');
    expect(next).toEqual(prev);
    expect(next).not.toBe(prev);
  });

  it('parseSelectedPlatformArray([]) -> empty Set (no fallback-to-all)', () => {
    expect(parseSelectedPlatformArray([])).toEqual(new Set<PlatformId>([]));
  });

  it('parseSelectedPlatformArray(null/undefined) -> empty Set', () => {
    expect(parseSelectedPlatformArray(null)).toEqual(new Set<PlatformId>([]));
    expect(parseSelectedPlatformArray(undefined)).toEqual(new Set<PlatformId>([]));
  });

  it('parseSelectedPlatformArray(unknown-only) -> empty Set (valid, not corrupt)', () => {
    expect(parseSelectedPlatformArray(['amigaos'])).toEqual(new Set<PlatformId>([]));
    expect(parseSelectedPlatformArray(['amigaos', 'commodore64'])).toEqual(new Set<PlatformId>([]));
  });

  it('parseSelectedPlatformArray whitelists unknown ids and lowercases known ones', () => {
    expect(parseSelectedPlatformArray(['windows', 'amigaos'])).toEqual(new Set(['windows']));
    expect(parseSelectedPlatformArray(['WINDOWS', 'Ios'])).toEqual(new Set(['windows', 'ios']));
  });

  it('unknown-only selection matches nothing (empty-filter premise)', () => {
    const unknownOnly = parseSelectedPlatformArray(['amigaos']);
    expect(unknownOnly.size).toBe(0);
    expect(matchPlatformSet({ platforms: ['windows'] }, unknownOnly)).toBe(false);
    expect(matchPlatformSet({}, unknownOnly)).toBe(false);
  });
});
