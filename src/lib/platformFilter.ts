/**
 * Multi-select device-platform filter.
 *
 * Single-select matching semantics mirror CategoriesView.matchPlatform:
 * an app with missing/empty `platforms` counts as windows-only, and all
 * comparisons are case-insensitive. Unknown ids are ignored wherever a
 * selection set is constructed or consumed.
 */

export const PLATFORM_IDS = ['windows', 'android', 'macos', 'linux', 'ios'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

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
 */
export function matchPlatformSet(app: PlatformApp, selected: ReadonlySet<string>): boolean {
  const wanted = knownSelected(selected);
  if (wanted.size === 0) return false;
  const actual = !app.platforms || app.platforms.length === 0 ? ['windows'] : app.platforms;
  return actual.some((p) => wanted.has(normalizePlatform(p)));
}

export interface ToggleResult {
  next: Set<string>;
  changed: boolean;
}

/**
 * Toggle one platform in a selection set. Refuses to empty the set and
 * rejects unknown ids: both cases return `prev` unchanged with
 * `changed: false`.
 */
export function togglePlatformSet(prev: Set<string>, id: string): ToggleResult {
  const n = normalizePlatform(id);
  if (!KNOWN_PLATFORMS.has(n)) return { next: prev, changed: false };
  const next = new Set<string>();
  for (const entry of prev) next.add(normalizePlatform(entry));
  if (next.has(n)) {
    if (next.size === 1) return { next: prev, changed: false };
    next.delete(n);
  } else {
    next.add(n);
  }
  return { next, changed: true };
}
