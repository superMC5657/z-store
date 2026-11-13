/**
 * 精选页（ADR-0023）：货架按画像状态渲染、推荐理由、负反馈、兴趣选择卡、最近浏览富卡区块与筛选空态。
 * 后端整页结构经 `tauriApi.getFeaturedPage` 注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { FeaturedView } from './FeaturedView';
import { tauriApi } from '../services/api';
import type { AppSummary, FeaturedPage, ProfileState } from '../types';
import { matchPlatformSet, parseSelectedPlatformArray } from '../lib/platformFilter';
import { makeApp } from './test-utils/filterFixture';

const CATS = ['dev', 'media', 'office', 'games'];
const APPS: AppSummary[] = Array.from({ length: 16 }, (_, i) =>
  makeApp({
    id: `o${i}/app${i}`,
    name: `App${i}`,
    owner: `o${i}`,
    repo: `app${i}`,
    category: CATS[i % CATS.length],
    platforms: ['windows'],
    stars: 10000 - i * 100,
  }),
);
const pick = (i: number, reasons: FeaturedPage['hero'][number]['reasons'] = []) => ({ app: APPS[i], reasons });

function pageFor(state: ProfileState): FeaturedPage {
  const personalized = state === 'warm' || state === 'rich';
  const shelves: FeaturedPage['shelves'] = [];
  if (personalized) {
    shelves.push({
      kind: 'because_you',
      seed_id: APPS[15].id,
      seed_relation: 'installed',
      items: [pick(4, [{ kind: 'owner', owner: 'o4' }]), pick(8), pick(12)],
    });
  } else {
    shelves.push({
      kind: 'fresh',
      items: [pick(4, [{ kind: 'fresh', added_at: '2026-11-01' }]), pick(5), pick(6)],
    });
  }
  shelves.push({ kind: 'category_pick', category: 'media', items: [pick(9), pick(13), pick(1)] });
  if (state === 'rich') shelves.push({ kind: 'explore', items: [pick(7, [{ kind: 'explore', category: 'games' }]), pick(10), pick(11)] });
  return {
    profile_state: state,
    signal_count: personalized ? 7 : 0,
    top_categories: personalized ? ['dev', 'office'] : [],
    hero: [
      pick(0, personalized ? [{ kind: 'seed', seed_id: APPS[15].id, relation: 'starred' }, { kind: 'category', category: 'dev' }] : []),
      pick(2),
      pick(3),
    ],
    shelves,
  };
}

function renderView(extra?: Partial<React.ComponentProps<typeof FeaturedView>>, apps: AppSummary[] = APPS) {
  return render(
    <FeaturedView
      apps={apps}
      installedIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      onOpenCategory={() => {}}
      onNavigateLatest={() => {}}
      onOpenAffinitySettings={() => {}}
      {...extra}
    />,
  );
}

beforeEach(() => {
  vi.spyOn(tauriApi, 'getFeaturedPage').mockResolvedValue(pageFor('rich'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FeaturedView: profile states', () => {
  it('rich: status bar, hero with reasons, because-you, category and explore shelves', async () => {
    renderView();
    await screen.findByTestId('featured-hero');
    expect(screen.getByTestId('featured-status').textContent).toContain('7');
    expect(screen.getByTestId('featured-hero-reason').textContent).toContain('因为你 Star 了 App15');
    expect(screen.getByTestId('featured-shelf-because_you').textContent).toContain('因为你安装了 App15');
    expect(screen.getByTestId('featured-shelf-category_pick')).toBeTruthy();
    expect(screen.getByTestId('featured-shelf-explore')).toBeTruthy();
    expect(screen.queryByTestId('featured-shelf-fresh')).toBeNull();
    expect(screen.queryByTestId('interest-picker')).toBeNull();
  });

  it('warm: no explore shelf', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('warm'));
    renderView();
    await screen.findByTestId('featured-shelf-because_you');
    expect(screen.queryByTestId('featured-shelf-explore')).toBeNull();
  });

  it('off: editorial page with dismissible turn-on hint and no reasons on hero', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('off'));
    renderView();
    await screen.findByTestId('featured-shelf-fresh');
    expect(screen.getByTestId('featured-off-hint')).toBeTruthy();
    expect(screen.queryByTestId('featured-status')).toBeNull();
    expect(screen.queryByTestId('featured-hero-reason')).toBeNull();
    expect(screen.queryByTestId('featured-shelf-because_you')).toBeNull();
  });

  it('cold: interest picker takes the hero slot above the editorial shelves', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('cold'));
    renderView();
    await screen.findByTestId('interest-picker');
    expect(screen.getByTestId('featured-shelf-fresh')).toBeTruthy();
    expect(screen.queryByTestId('featured-hero')).toBeNull();
    expect(screen.queryByTestId('featured-hero-side')).toBeNull();
  });
});

describe('FeaturedView: interest picker', () => {
  it('saving with nothing selected shows an inline hint and sends nothing', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('cold'));
    const save = vi.spyOn(tauriApi, 'saveInterestSeeds').mockResolvedValue();
    renderView();
    fireEvent.click(await screen.findByTestId('interest-picker-save'));
    expect(screen.getByTestId('interest-picker-error')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('saving selected categories persists them and reloads the page', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('cold'));
    const save = vi.spyOn(tauriApi, 'saveInterestSeeds').mockResolvedValue();
    renderView();
    fireEvent.click(await screen.findByTestId('interest-chip-games'));
    fireEvent.click(screen.getByTestId('interest-chip-dev'));
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('warm'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('interest-picker-save'));
    });
    expect(save).toHaveBeenCalledWith(['dev', 'games']);
    await screen.findByTestId('featured-shelf-because_you');
    expect(screen.queryByTestId('interest-picker')).toBeNull();
  });

  // 跳过状态在会话内（模块级）保留，故放在本组最后，之后不再有依赖兴趣选择卡的用例。
  it('skipping the picker gives the hero slot back', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('cold'));
    renderView();
    await screen.findByTestId('interest-picker');
    fireEvent.click(screen.getByTestId('interest-picker-skip'));
    expect(screen.queryByTestId('interest-picker')).toBeNull();
    expect(screen.getByTestId('featured-hero').textContent).toContain('App0');
  });
});

describe('FeaturedView: dismiss feedback', () => {
  it('not interested removes the card in place and keeps the others in order', async () => {
    const dismiss = vi.spyOn(tauriApi, 'dismissFeatured').mockResolvedValue();
    const { container } = renderView();
    await screen.findByTestId('featured-shelf-because_you');
    fireEvent.click(screen.getByTestId(`feedback-menu-${APPS[4].id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`dismiss-app-${APPS[4].id}`));
    });
    expect(dismiss).toHaveBeenCalledWith(APPS[4].id, 'app');
    const shelf = screen.getByTestId('featured-shelf-because_you');
    expect(shelf.textContent).not.toContain('App4');
    const names = Array.from(shelf.querySelectorAll('.app-name')).map((n) => n.textContent);
    expect(names).toEqual(['App8', 'App12']);
    expect(container.textContent).toContain('App0');
  });

  it('less of this category sends the category key', async () => {
    const dismiss = vi.spyOn(tauriApi, 'dismissFeatured').mockResolvedValue();
    renderView();
    await screen.findByTestId('featured-shelf-because_you');
    fireEvent.click(screen.getByTestId(`feedback-menu-${APPS[8].id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`dismiss-category-${APPS[8].id}`));
    });
    expect(dismiss).toHaveBeenCalledWith(APPS[8].category, 'category');
  });

  it('dismissing the main hero leaves the side cards in place without promoting one', async () => {
    vi.spyOn(tauriApi, 'dismissFeatured').mockResolvedValue();
    renderView();
    await screen.findByTestId('featured-hero');
    await act(async () => {
      fireEvent.click(screen.getByTestId(`dismiss-app-${APPS[0].id}`));
    });
    expect(screen.queryByTestId('featured-hero')).toBeNull();
    const side = screen.getByTestId('featured-hero-side');
    const names = Array.from(side.querySelectorAll('.app-name')).map((n) => n.textContent);
    expect(names).toEqual(['App2', 'App3']);
  });

  it('hero and shelf cards offer feedback regardless of profile state', async () => {
    vi.mocked(tauriApi.getFeaturedPage).mockResolvedValue(pageFor('off'));
    renderView();
    await screen.findByTestId('featured-shelf-fresh');
    expect(screen.getByTestId(`dismiss-app-${APPS[0].id}`)).toBeTruthy();
    expect(screen.getByTestId(`feedback-menu-${APPS[2].id}`)).toBeTruthy();
    expect(screen.getByTestId(`feedback-menu-${APPS[4].id}`)).toBeTruthy();
  });

  it('a failed dismiss restores the card', async () => {
    vi.spyOn(tauriApi, 'dismissFeatured').mockRejectedValue(new Error('db'));
    renderView();
    await screen.findByTestId('featured-shelf-because_you');
    fireEvent.click(screen.getByTestId(`feedback-menu-${APPS[4].id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`dismiss-app-${APPS[4].id}`));
    });
    await waitFor(() => {
      expect(screen.getByTestId('featured-shelf-because_you').textContent).toContain('App4');
    });
  });
});

describe('FeaturedView: recent section and backend args', () => {
  it('does not render an infinite all-apps feed grid on FeaturedView', async () => {
    renderView();
    await screen.findByTestId('featured-hero');
    expect(screen.queryByTestId('home-feed-grid')).toBeNull();
    expect(screen.queryByTestId('feed-load-more')).toBeNull();
  });

  it('continue-browsing section renders recent apps as rich AppCards and clears cleanly', async () => {
    const onClearRecentViews = vi.fn();
    const staleRecent = { ...APPS[14], description: 'stale snapshot description' };
    const uncatalogedRecent = makeApp({
      id: 'ext/uncataloged',
      name: 'UncatalogedTool',
      owner: 'ext',
      repo: 'uncataloged',
      category: 'external',
      platforms: ['windows'],
    });
    const first = renderView({
      recentlyViewedApps: [staleRecent, uncatalogedRecent],
      onClearRecentViews,
    });
    await screen.findByTestId('featured-hero');
    const recentSection = screen.getByTestId('featured-recent');
    expect(recentSection.textContent).toContain('App14');
    // 已收录最近浏览应合并最新目录字段，未收录条目保留自身快照渲染
    expect(recentSection.textContent).toContain(APPS[14].description);
    expect(recentSection.textContent).not.toContain('stale snapshot description');
    expect(recentSection.textContent).toContain('UncatalogedTool');
    expect(recentSection.querySelectorAll('.app-card')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('featured-clear-recent'));
    expect(onClearRecentViews).toHaveBeenCalledTimes(1);
    first.unmount();
    renderView();
    await screen.findByTestId('featured-hero');
    expect(screen.queryByTestId('featured-recent')).toBeNull();
  });

  it('passes the platform-filtered ids and the day seed to the backend', async () => {
    renderView(undefined, APPS.slice(0, 5));
    await screen.findByTestId('featured-hero');
    const [seed, ids] = vi.mocked(tauriApi.getFeaturedPage).mock.calls[0];
    expect(String(seed)).toMatch(/^\d{8}$/);
    expect(ids).toEqual(APPS.slice(0, 5).map((a) => a.id));
  });
});

describe('FeaturedView: platform filter empty state', () => {
  it('empty selection renders the filter-empty state with a working reset', () => {
    const sel = parseSelectedPlatformArray([]);
    const filtered = APPS.filter((a) => matchPlatformSet(a, sel));
    expect(filtered).toEqual([]);
    const onReset = vi.fn();
    const { container } = renderView({ onResetPlatformFilter: onReset }, filtered);
    const btn = container.querySelector('.filter-empty-reset') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onReset).toHaveBeenCalled();
    expect(tauriApi.getFeaturedPage).not.toHaveBeenCalled();
  });
});
