import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LatestView } from './LatestView';
import type { AppSummary } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { mockGetLatestCatalogApps } = vi.hoisted(() => ({ mockGetLatestCatalogApps: vi.fn() }));
vi.mock('../services/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api/catalog')>();
  return {
    ...actual,
    getLatestCatalogApps: (...args: unknown[]) => mockGetLatestCatalogApps(...args),
  };
});

function makeSummary(id: string, name: string, addedAt?: string, stars: number = 100): AppSummary {
  const [owner, repo] = id.split('/');
  return {
    id,
    name,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: `Desc of ${name}`,
    stars,
    forks: 10,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    added_at: addedAt,
  };
}

describe('LatestView component', () => {
  const onOpenDetail = vi.fn();
  const onQuickInstall = vi.fn();
  const onToggleFavorite = vi.fn();
  const onResetPlatformFilter = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestCatalogApps.mockResolvedValue({
      items: [],
      total: 0,
      has_more: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title and 3 time window options with 30d default', async () => {
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app1', 'App One', '2026-10-16')],
      total: 1,
      has_more: false,
    });

    const apps = [makeSummary('demo/app1', 'App One', '2026-10-16')];

    render(
      <LatestView
        apps={apps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    // Initial call should be 30 days (default)
    expect(mockGetLatestCatalogApps).toHaveBeenCalledWith(30, 1, 20);

    // Header exists
    expect(screen.getByText('最新入库')).toBeDefined();

    // Time window options exist in 7 -> 30 -> 90 order, with no all-time tab
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent?.trim());
    expect(tabs).toEqual(['最近 7 天', '最近 30 天', '最近 90 天']);

    // Default active is 30d
    const activeTab = screen.getByRole('tab', { selected: true });
    expect(activeTab.textContent?.trim()).toBe('最近 30 天');

    await waitFor(() => {
      expect(screen.getByText('App One')).toBeDefined();
    });
  });

  it('switches time window when segmented option is clicked', async () => {
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app1', 'App One', '2026-10-16')],
      total: 1,
      has_more: false,
    });

    const apps = [
      makeSummary('demo/app1', 'App One', '2026-10-16'),
      makeSummary('demo/app2', 'App Two', '2026-10-22'),
    ];

    render(
      <LatestView
        apps={apps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('App One')).toBeDefined();
    });

    // Click 7d filter
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app2', 'App Two', '2026-10-22')],
      total: 1,
      has_more: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByText('最近 7 天'));
    });

    expect(mockGetLatestCatalogApps).toHaveBeenLastCalledWith(7, 1, 20);

    await waitFor(() => {
      expect(screen.getByText('App Two')).toBeDefined();
    });
  });

  it('shows empty state when no apps in selected time window', async () => {
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [],
      total: 0,
      has_more: false,
    });

    const apps = [makeSummary('demo/app1', 'App One', '2026-09-10')];

    render(
      <LatestView
        apps={apps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('当前时间范围内暂无新收录应用')).toBeDefined();
    });

    // Default 30d empty state offers the wider 90d window as escape
    const widenBtn = screen.getByText('切换至最近 90 天');
    expect(widenBtn).toBeDefined();
    expect(screen.queryByText('查看全部应用')).toBeNull();

    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app1', 'App One', '2026-09-10')],
      total: 1,
      has_more: false,
    });

    await act(async () => {
      fireEvent.click(widenBtn);
    });

    expect(mockGetLatestCatalogApps).toHaveBeenLastCalledWith(90, 1, 20);
  });

  it('renders 90d upper-limit guidance text and explore categories button when empty', async () => {
    mockGetLatestCatalogApps.mockResolvedValue({
      items: [],
      total: 0,
      has_more: false,
    });

    const onNavigateCategories = vi.fn();
    const apps = [makeSummary('demo/app1', 'App One', '2026-05-01')];

    render(
      <LatestView
        apps={apps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
        onNavigateCategories={onNavigateCategories}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('切换至最近 90 天')).toBeDefined();
    });

    // Switch to 90d tab
    await act(async () => {
      fireEvent.click(screen.getByText('最近 90 天'));
    });

    // Should show 90d specific upper-limit description
    await waitFor(() => {
      expect(
        screen.getByText('最近 90 天暂无新收录应用，可通过「分类浏览」探索全量精选应用'),
      ).toBeDefined();
    });

    // Should render explore categories button and trigger navigation
    const exploreBtn = screen.getByText('浏览全部分类');
    expect(exploreBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(exploreBtn);
    });
    expect(onNavigateCategories).toHaveBeenCalledTimes(1);
  });

  it('renders added_at badge on app cards', async () => {
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app1', 'App One', '2026-10-16')],
      total: 1,
      has_more: false,
    });

    const apps = [makeSummary('demo/app1', 'App One', '2026-10-16')];

    render(
      <LatestView
        apps={apps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('收录于 2026-10-16')).toBeDefined();
    });
  });
});
