/**
 * Multi-select device-platform filter (Decision B semantics).
 *
 * - Empty selection is VALID and means select-nothing (pages render
 *   filter-empty states for it).
 * - Unknown ids are ignored wherever a selection set is constructed
 *   or consumed.
 * - Single-select matching semantics mirror CategoriesView.matchPlatform:
 *   an app with missing/empty `platforms` counts as windows-only, and
 *   all comparisons are case-insensitive.
 */

export type PlatformId = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export const PLATFORM_IDS: readonly PlatformId[] = [
  'windows',
  'android',
  'macos',
  'linux',
  'ios',
] as const;

export const PLATFORM_META: Record<PlatformId, { label: string }> = {
  windows: { label: 'Windows' },
  android: { label: 'Android' },
  macos: { label: 'macOS' },
  linux: { label: 'Linux' },
  ios: { label: 'iOS' },
};

export interface PlatformFilterSelection {
  selectedPlatforms: ReadonlySet<PlatformId>;
  platformCounts: Readonly<Record<PlatformId, number>>;
  onTogglePlatform: (id: PlatformId) => void;
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

function isPlatformId(value: string): value is PlatformId {
  return KNOWN_PLATFORMS.has(value);
}

export function normalizePlatform(p: string): string {
  return p.toLowerCase();
}

interface PlatformApp {
  platforms?: string[];
}

/** Keep only known ids (normalized) from a selection set. */
function knownSelected(selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of selected) {
    const n = normalizePlatform(id);
    if (KNOWN_PLATFORMS.has(n)) out.add(n);
  }
  return out;
}

/**
 * True when the app targets at least one selected (known) platform.
 * Apps with missing/empty `platforms` count as windows-only.
 * An empty (or unknown-only) selection matches nothing.
 */
export function matchPlatformSet(app: PlatformApp, selected: ReadonlySet<string>): boolean {
  const wanted = knownSelected(selected);
  if (wanted.size === 0) return false;
  const actual = !app.platforms || app.platforms.length === 0 ? ['windows'] : app.platforms;
  return actual.some((p) => wanted.has(normalizePlatform(p)));
}

/**
 * Toggle one platform in a selection set. Empty selection is VALID and
 * means select-nothing. Unknown ids return a copy unchanged.
 */
export function togglePlatformSet(prev: ReadonlySet<PlatformId>, id: string): Set<PlatformId> {
  const n = normalizePlatform(id);
  const next = new Set<PlatformId>();
  for (const entry of prev) {
    const normalized = normalizePlatform(entry);
    if (isPlatformId(normalized)) next.add(normalized);
  }
  if (!isPlatformId(n)) return next;
  if (next.has(n)) {
    next.delete(n);
  } else {
    next.add(n);
  }
  return next;
}

/**
 * Parse a persisted selection (already-decoded string array) into a set of
 * known platform ids. Empty array / unknown-only / null / undefined ->
 * empty Set (NOT fallback-to-all), so `[]` round-trips to `[]`.
 *
 * NOTE: distinct from `parseSelectedPlatforms` in `src/App.tsx`, which takes
 * the raw localStorage string (string | null | undefined) and falls back to
 * the full set on missing/corrupt values. This array version never falls
 * back — null means empty.
 */
export function parseSelectedPlatformArray(input: readonly string[] | null | undefined): Set<PlatformId> {
  const out = new Set<PlatformId>();
  if (input === null || input === undefined) return out;
  for (const raw of input) {
    const n = normalizePlatform(raw);
    if (isPlatformId(n)) out.add(n);
  }
  return out;
}
