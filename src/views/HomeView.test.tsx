/**
 * Task 5 — HomeView derives AFTER the global platform filter.
 *
 * Contract: App.tsx passes `platformFilteredApps` under the SAME `apps` prop
 * name, so HomeView must treat the prop as already platform-filtered:
 * Hero/featured/remaining slices execute on the prop as-is, and when the
 * prop is empty HomeView shows a dedicated filter-empty state (NOT the
 * search `owner/repo` copy) with a `.filter-empty-reset` button.
 * No in-page platform filtering code is allowed in HomeView.tsx.
 *
 * SECTION A (baseline characterization): pins CURRENT derivation behavior on
 * unchanged code — slices run on the prop as-is and the hero falls back to
 * apps[0] when rustdesk is absent from the set. Stays GREEN before AND after.
 *
 * SECTION B (new filter-empty spec): FAILS on unchanged code (the current
 * empty state shows the search `owner/repo` copy with no reset button).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { HomeView } from './HomeView';
import type { AppSummary } from '../types';
import { PLATFORM_IDS, matchPlatformSet } from '../lib/platformFilter';

afterEach(() => {
  cleanup();
});

function makeApp(overrides: Partial<AppSummary> & { id: string; name: string }): AppSummary {
  return {
    owner: 'owner',
    repo: overrides.id,
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${overrides.name} desc`,
    stars: 1000,
    forks: 100,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: false,
    ...overrides,
  };
}

// Mandated fixture: rustdesk:windows, 仅iosApp:ios, 无platformsApp:undefined.
const RUSTDESK = makeApp({ id: 'rustdesk', name: 'RustDesk', platforms: ['windows'], stars: 90000 });
const IOS_APP = makeApp({ id: 'ios-only-app', name: '仅iosApp', platforms: ['ios'], stars: 5000 });
const NO_PLATFORMS_APP = makeApp({ id: 'no-platforms-app', name: '无platformsApp', stars: 3000 });
// platforms intentionally omitted (undefined) — counts as windows-only per filter semantics.

const BASE_FIXTURE: AppSummary[] = [RUSTDESK, IOS_APP, NO_PLATFORMS_APP];

// Extended fixture so hero + featured(4) + remaining(1) are ALL non-empty on full-select.
const EXTENDED_FIXTURE: AppSummary[] = [
  RUSTDESK,
  IOS_APP,
  NO_PLATFORMS_APP,
  makeApp({ id: 'android-app', name: 'AndroidApp', platforms: ['android'], stars: 2000 }),
  makeApp({ id: 'linux-app', name: 'LinuxApp', platforms: ['linux'], stars: 1500 }),
  makeApp({ id: 'macos-app', name: 'MacApp', platforms: ['macos'], stars: 1200 }),
];

/** Mirrors the App.tsx derivation exactly: apps filtered by the selection set. */
function filterApps(apps: AppSummary[], selected: string[]): AppSummary[] {
  return apps.filter((a) => matchPlatformSet(a, new Set(selected)));
}

function renderHomeView(
  apps: AppSummary[],
  extraProps?: Partial<React.ComponentProps<typeof HomeView>>,
) {
  return render(
    <HomeView
      apps={apps}
      installedIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      onNavigateTrends={() => {}}
      {...extraProps}
    />,
  );
}

describe('baseline: HomeView slices the incoming apps prop as-is', () => {
  it('prefers rustdesk as hero when present in the set', () => {
    const { container } = renderHomeView(BASE_FIXTURE);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('RustDesk');
  });

  it('hero falls back to the first app of the set when rustdesk is absent (never outside the set)', () => {
    // ios-only selection excludes rustdesk (windows) and 无platformsApp (windows-only fallback).
    const filtered = filterApps(BASE_FIXTURE, ['ios']);
    expect(filtered.map((a) => a.id)).toEqual(['ios-only-app']);
    const { container } = renderHomeView(filtered);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('仅iosApp');
    expect(heroTitle?.textContent).not.toContain('RustDesk');
  });

  it('featured/remaining slices execute on the prop as-is (hero excluded, order kept)', () => {
    const { container } = renderHomeView(BASE_FIXTURE);
    // hero (rustdesk) must not repeat in the grids below.
    const gridText = Array.from(container.querySelectorAll('.app-grid'))
      .map((g) => g.textContent ?? '')
      .join('\n');
    expect(gridText).toContain('仅iosApp');
    expect(gridText).toContain('无platformsApp');
    expect(gridText).not.toContain('RustDesk');
  });
});

describe('task5: filter-empty state with .filter-empty-reset', () => {
  it('ios-only selection → hero is the filtered first app, never rustdesk', () => {
    const filtered = filterApps(BASE_FIXTURE, ['ios']);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.some((a) => a.id === 'rustdesk')).toBe(false);
    const { container } = renderHomeView(filtered);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain(filtered[0].name);
    expect(screen.queryByText(/RustDesk/)).toBeNull();
  });

  it('full-select → hero, featured and remaining sections are ALL non-empty', () => {
    const filtered = filterApps(EXTENDED_FIXTURE, [...PLATFORM_IDS]);
    expect(filtered).toHaveLength(EXTENDED_FIXTURE.length);
    const { container } = renderHomeView(filtered);
    // hero
    expect(container.querySelector('.hero-banner')).toBeTruthy();
    // featured grid (经典精选开源软件) non-empty
    const grids = container.querySelectorAll('.app-grid');
    expect(grids.length).toBeGreaterThanOrEqual(2);
    grids.forEach((g) => {
      expect((g.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
    expect(container.textContent).toContain('经典精选开源软件');
    expect(container.textContent).toContain('全部精选开源收录');
  });

  it('empty prop → dedicated filter-empty state, NOT the search owner/repo copy', () => {
    const { container } = renderHomeView([]);
    // dedicated reset affordance for the global device-platform filter
    expect(container.querySelector('.filter-empty-reset')).toBeTruthy();
    // must NOT reuse the search empty-state guidance
    expect(container.textContent).not.toContain('owner/repo');
  });

  it('clicking .filter-empty-reset calls the reset handler', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderHomeView([], { onResetPlatformFilter });
    const btn = container.querySelector('.filter-empty-reset');
    expect(btn).toBeTruthy();
    fireEvent.click(btn as Element);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('reset button without a wired handler still broadcasts the platform reset intent', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    try {
      const { container } = renderHomeView([]);
      fireEvent.click(container.querySelector('.filter-empty-reset') as Element);
      const events = dispatchSpy.mock.calls
        .map((args) => args[0])
        .filter((e): e is CustomEvent => e instanceof CustomEvent);
      expect(events.some((e) => e.type === 'zstore:reset-platform-filter')).toBe(true);
    } finally {
      dispatchSpy.mockRestore();
    }
  });
});
