/**
 * Task 3 — App-level platform filter state + localStorage persistence
 * (Decision B: [] = select-nothing).
 *
 * All coverage is behavioral: persistence round-trips through
 * loadSelectedPlatforms/parseSelectedPlatforms, and filtering semantics
 * through matchPlatformSet. No source-text assertions.
 */
// @ts-ignore - vitest is fetched transiently via npx (not a repo dep per task scope)
import { describe, expect, it, afterEach } from 'vitest';
import {
  PLATFORM_IDS,
  matchPlatformSet,
  parseSelectedPlatforms as parsePersistedSelection,
} from './lib/platformFilter';

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

  it('an empty selection matches no fixture app (empty-filter premise, not the full list)', () => {
    const empty = parsePersistedSelection([]);
    expect(empty.size).toBe(0);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, empty)).toBe(false);
    }
    expect(FIXTURE.filter((a) => matchPlatformSet(a, empty))).toEqual([]);
  });
});

// @ts-ignore - App.tsx ships without a vitest dep; resolved transiently via npx
import {
  PLATFORM_FILTER_STORAGE_KEY,
  loadSelectedPlatforms,
  parseSelectedPlatforms,
} from './App';

afterEach(() => {
  window.localStorage.clear();
});

describe('task3: platform-filter persistence (Decision B select-nothing)', () => {
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

  it('stored [] (valid empty array) restores [] — no full-set fallback', () => {
    expect(parseSelectedPlatforms(JSON.stringify([]))).toEqual(new Set<string>([]));
    // round-trip: persisting an empty selection reloads empty
    expect(parseSelectedPlatforms(JSON.stringify([...parseSelectedPlatforms('[]')]))).toEqual(
      new Set<string>([])
    );
  });

  it('corrupt "{bad" → full-set fallback (retained)', () => {
    expect(parseSelectedPlatforms('{bad')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('not-json-at-all{{{')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('"just-a-string"')).toEqual(new Set(PLATFORM_IDS));
  });

  it('unknown ids are whitelisted; unknown-only/empty stays empty (valid array, not corrupt)', () => {
    expect(parseSelectedPlatforms(JSON.stringify(['windows', 'amigaos']))).toEqual(
      new Set(['windows'])
    );
    expect(parseSelectedPlatforms(JSON.stringify(['amigaos']))).toEqual(new Set<string>([]));
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

  it('loadSelectedPlatforms honors a stored empty array (no full-set fallback on reload)', () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    expect(loadSelectedPlatforms()).toEqual(new Set<string>([]));
  });

  it('loadSelectedPlatforms restores a stored subset exactly', () => {
    window.localStorage.setItem(
      PLATFORM_FILTER_STORAGE_KEY,
      JSON.stringify(['windows', 'ios'])
    );
    expect(loadSelectedPlatforms()).toEqual(new Set(['windows', 'ios']));
  });

  it('loadSelectedPlatforms yields the full set when nothing is stored', () => {
    expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
  });

  it('filtering derivation: empty selection keeps nothing, full keeps all, partial keeps its subset', () => {
    const full = new Set<string>(PLATFORM_IDS);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, full))).toHaveLength(FIXTURE.length);
    const empty = parsePersistedSelection([]);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, empty))).toEqual([]);
    const iosOnly = parsePersistedSelection(['ios']);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, iosOnly))).toEqual([
      { platforms: ['ios'] },
    ]);
  });

  it('per-platform counts derive from the FULL app list via matchPlatformSet singletons', () => {
    const counts: Record<string, number> = {};
    for (const id of PLATFORM_IDS) {
      counts[id] = FIXTURE.filter((a) => matchPlatformSet(a, new Set([id]))).length;
    }
    // windows matches the explicit entry plus the two missing/empty ones (windows-only rule)
    expect(counts['windows']).toBe(3);
    expect(counts['ios']).toBe(1);
    expect(counts['android']).toBe(1);
    expect(counts['linux']).toBe(1);
    expect(counts['macos']).toBe(1);
  });

  it('reset restores the full device set (matches everything again)', () => {
    const reset = new Set<string>(PLATFORM_IDS);
    expect(reset.size).toBe(5);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, reset)).toBe(true);
    }
    // reset round-trips through storage back to the full set
    expect(parseSelectedPlatforms(JSON.stringify([...reset]))).toEqual(reset);
  });
});
