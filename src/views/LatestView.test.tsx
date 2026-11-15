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

/** 标题上的数量角标文本（总数取后端 total，而非已加载页长） */
function titleCount(): string | undefined {
  return document.querySelector('.section-title .count-badge')?.textContent ?? undefined;
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

    // Initial call should be 30 days (default: 7~30d)
    expect(mockGetLatestCatalogApps).toHaveBeenCalledWith({ minDays: 7, maxDays: 30 }, 1, 20, ['demo/app1']);

    // Header exists
    expect(screen.getByText('最新入库')).toBeDefined();

    // Time window options exist in 7 -> 30 -> 90 order, with no all-time tab
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent?.trim());
    expect(tabs).toEqual(['7 天', '30 天', '90 天']);

    // Default active is 30d
    const activeTab = screen.getByRole('tab', { selected: true });
    expect(activeTab.textContent?.trim()).toBe('30 天');

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
      fireEvent.click(screen.getByText('7 天'));
    });

    expect(mockGetLatestCatalogApps).toHaveBeenLastCalledWith({ minDays: 0, maxDays: 7 }, 1, 20, ['demo/app1', 'demo/app2']);

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
      expect(screen.getByText('暂无新收录应用')).toBeDefined();
    });

    // Default 30d empty state offers the wider 90d window as escape
    const widenBtn = screen.getByText('查看 90 天');
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

    expect(mockGetLatestCatalogApps).toHaveBeenLastCalledWith({ minDays: 30, maxDays: 90 }, 1, 20, ['demo/app1']);
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
      expect(screen.getByText('查看 90 天')).toBeDefined();
    });

    // Switch to 90d tab
    await act(async () => {
      fireEvent.click(screen.getByText('90 天'));
    });

    // Should show 90d specific upper-limit description
    await waitFor(() => {
      expect(
        screen.getByText('暂无新应用，可前往「分类」探索更多应用'),
      ).toBeDefined();
    });

    // Should render explore categories button and trigger navigation
    const exploreBtn = screen.getByText('浏览分类');
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

  it('displays total available count from backend total rather than first page item count', async () => {
    const pageItems = Array.from({ length: 20 }, (_, i) =>
      makeSummary(`demo/app${i + 1}`, `App ${i + 1}`, '2026-10-16'),
    );
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: pageItems,
      total: 42,
      has_more: true,
    });

    render(
      <LatestView
        apps={pageItems}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(titleCount()).toBe('42');
    });
  });

  it('updates available count when switching time windows without flashing page length', async () => {
    const pageItems = Array.from({ length: 20 }, (_, i) =>
      makeSummary(`demo/app${i + 1}`, `App ${i + 1}`, '2026-10-16'),
    );
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: pageItems,
      total: 35,
      has_more: true,
    });

    render(
      <LatestView
        apps={pageItems}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(titleCount()).toBe('35');
    });

    // Switch to 7d window with total 5
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [makeSummary('demo/app1', 'App 1', '2026-10-22')],
      total: 5,
      has_more: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByText('7 天'));
    });

    await waitFor(() => {
      expect(titleCount()).toBe('5');
    });
  });

  it('pre-filters by platform via allowedIds and reports window platform distribution', async () => {
    const androidApps = Array.from({ length: 4 }, (_, i) => ({
      ...makeSummary(`demo/and${i}`, `Android ${i}`, '2026-10-16'),
      platforms: ['android'],
    }));
    const windowsApps = Array.from({ length: 26 }, (_, i) =>
      makeSummary(`demo/win${i}`, `Windows ${i}`, '2026-10-16'),
    );
    const allApps = [...windowsApps, ...androidApps];
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: androidApps,
      total: 4,
      has_more: false,
      matched_ids: allApps.map((a) => a.id),
    });
    const onDisplayPlatformCounts = vi.fn();

    render(
      <LatestView
        apps={androidApps}
        allApps={allApps}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
        onDisplayPlatformCounts={onDisplayPlatformCounts}
      />,
    );

    expect(mockGetLatestCatalogApps).toHaveBeenCalledWith(
      { minDays: 7, maxDays: 30 },
      1,
      20,
      ['demo/and0', 'demo/and1', 'demo/and2', 'demo/and3'],
    );
    await waitFor(() => {
      expect(titleCount()).toBe('4');
    });
    expect(document.querySelectorAll('.app-grid .app-card')).toHaveLength(4);
    expect(onDisplayPlatformCounts).toHaveBeenLastCalledWith({
      windows: 26,
      macos: 0,
      linux: 0,
      ios: 0,
      android: 4,
      other: 0,
    });
  });

  it('shows the platform-filter empty state when the window has apps but none match the selected platform', async () => {
    const winApp = makeSummary('demo/win', 'Win App', '2026-10-16');
    const iosOld = { ...makeSummary('demo/ios', 'iOS Old', '2025-01-01'), platforms: ['ios'] };
    mockGetLatestCatalogApps.mockResolvedValueOnce({
      items: [],
      total: 0,
      has_more: false,
      matched_ids: [winApp.id],
    });

    render(
      <LatestView
        apps={[iosOld]}
        allApps={[winApp, iosOld]}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.filter-empty-reset')).toBeTruthy();
    });
    expect(document.querySelector('.app-grid')).toBeNull();
    expect(screen.queryByText('暂无新收录应用')).toBeNull();
    fireEvent.click(document.querySelector('.filter-empty-reset') as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('renders a load-more button when has_more and requests page 2 on click', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) =>
      makeSummary(`demo/p${i}`, `Page ${i}`, '2026-10-16'),
    );
    const page2 = [makeSummary('demo/p20', 'Page 20', '2026-10-16')];
    const apps = [...page1, ...page2];
    mockGetLatestCatalogApps
      .mockResolvedValueOnce({ items: page1, total: 21, has_more: true, matched_ids: apps.map((a) => a.id) })
      .mockResolvedValueOnce({ items: page2, total: 21, has_more: false, matched_ids: apps.map((a) => a.id) });

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

    const loadMore = await screen.findByRole('button', { name: '加载更多' });
    await act(async () => {
      fireEvent.click(loadMore);
    });
    expect(mockGetLatestCatalogApps).toHaveBeenLastCalledWith(
      { minDays: 7, maxDays: 30 },
      2,
      20,
      expect.any(Array),
    );
    await screen.findByText('Page 20');
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  });
});
