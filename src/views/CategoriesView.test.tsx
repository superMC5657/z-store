/**
 * Task 4 — CategoriesView convergence to the global device-platform filter.
 *
 * SECTION A (baseline characterization): pins category one-dimension behavior
 * that SURVIVES convergence — passes on unchanged AND converged code:
 *   hall renders category cards; clicking a card lists that category's apps;
 *   back button returns to the hall.
 *
 * SECTION B (new convergence spec): requires the converged contract — FAILS
 * on unchanged code (capsule bar + dual filtering present), passes after:
 *   no platform capsule bar; hall counts come from the incoming (pre-filtered)
 *   `apps` prop only; empty state uses multi-select Join copy + a
 *   `.filter-empty-reset` button wired to the required `onResetPlatformFilter`
 *   prop (restores the full device set via App and returns to the hall).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { CategoriesView } from './CategoriesView';
import type { AppSummary } from '../types';
import { matchPlatformSet, parseSelectedPlatformArray } from '../lib/platformFilter';

afterEach(() => {
  cleanup();
});

function makeApp(id: string, category: string, platforms?: string[]): AppSummary {
  return {
    id,
    name: id,
    owner: 'owner',
    repo: id,
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${id} desc`,
    stars: 1,
    forks: 0,
    license: 'MIT',
    latest_version: '1.0.0',
    category,
    category_name: category,
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: platforms ?? [],
  };
}

// Intersection fixture: dev spans windows+ios, media is ios-only.
const DEV_WIN = makeApp('a-dev-win', 'dev', ['windows']);
const DEV_IOS = makeApp('a-dev-ios', 'dev', ['ios']);
const MEDIA_IOS = makeApp('a-media-ios', 'media', ['ios']);

function renderCategories(
  apps: AppSummary[],
  extraProps?: Partial<React.ComponentProps<typeof CategoriesView>>,
) {
  return render(
    <CategoriesView
      apps={apps}
      installedIds={new Set<string>()}
      installingIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      watchedIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      onToggleWatch={() => {}}
      onResetPlatformFilter={() => {}}
      {...extraProps}
    />,
  );
}

/** Click a hall card by its visible category name. */
function openCategory(container: HTMLElement, name: string) {
  const card = within(container as HTMLElement)
    .getAllByText(name)
    .map((el) => el.closest('.app-card'))
    .find((el): el is HTMLElement => el !== null);
  expect(card).toBeTruthy();
  fireEvent.click(card as HTMLElement);
}

describe('baseline: category one-dimension behavior (survives convergence)', () => {
  it('renders the category hall', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
    expect(within(container as HTMLElement).getByText('影音视听')).toBeTruthy();
  });

  it('clicking a category lists only that category, back button returns to hall', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    openCategory(container, '开发工具');
    expect(screen.getByText('a-dev-win')).toBeTruthy();
    expect(screen.getByText('a-dev-ios')).toBeTruthy();
    expect(screen.queryByText('a-media-ios')).toBeNull();
    fireEvent.click(screen.getByText('返回分类大厅'));
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
  });
});

describe('CategoriesView: converged to global filter (no local platform state)', () => {
  it('renders no platform capsule bar', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    expect(within(container as HTMLElement).queryByText('支持设备:')).toBeNull();
    expect(screen.queryByText('全部设备')).toBeNull();
  });

  it('hall card counts come from the incoming pre-filtered prop only', () => {
    // Caller pre-filtered globally to ios: dev=1 (DEV_IOS), media=1.
    const { container } = renderCategories([DEV_IOS, MEDIA_IOS]);
    const cards = Array.from(container.querySelectorAll('.app-card'));
    const devCard = cards.find((c) => c.textContent?.includes('开发工具'));
    const mediaCard = cards.find((c) => c.textContent?.includes('影音视听'));
    const graphicsCard = cards.find((c) => c.textContent?.includes('图形设计'));
    expect(devCard?.textContent).toContain('1 款可用');
    expect(mediaCard?.textContent).toContain('1 款可用');
    // A category absent from the prop reports no availability (never filters itself).
    expect(graphicsCard?.textContent).toContain('暂无此端应用');
  });

  it('lists whatever the prop contains without second-pass platform filtering', () => {
    const { container } = renderCategories([DEV_IOS]);
    openCategory(container, '开发工具');
    expect(screen.getByText('a-dev-ios')).toBeTruthy();
  });

  it('empty category shows multi-select Join copy + .filter-empty-reset wired to onResetPlatformFilter', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
    // Multi-select Join copy: names the device combination, never the search empty copy.
    expect(screen.getByText(/设备组合/)).toBeTruthy();
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('reset restores the full device set and returns to the hall', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
    // Reset also returns to the hall (all categories visible again).
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
  });
});

describe('CategoriesView: Decision B select-nothing (empty/unknown-only match nothing)', () => {
  it('empty selection pre-filters everything out (no fallback-to-all)', () => {
    const sel = parseSelectedPlatformArray([]);
    expect(sel.size).toBe(0);
    expect([DEV_WIN, DEV_IOS, MEDIA_IOS].filter((a) => matchPlatformSet(a, sel))).toEqual([]);
  });

  it('unknown-only selection behaves like empty (never falls back to all)', () => {
    const sel = parseSelectedPlatformArray(['amigaos']);
    expect(sel.size).toBe(0);
    expect([DEV_WIN, DEV_IOS, MEDIA_IOS].filter((a) => matchPlatformSet(a, sel))).toEqual([]);
  });

  it('empty prop renders the filter-empty copy + reset wired to onResetPlatformFilter', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([], { onResetPlatformFilter });
    openCategory(container, '开发工具');
    expect(screen.getByText(/设备组合/)).toBeTruthy();
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });
});
