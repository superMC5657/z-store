/**
 * 趋势榜本地收录黄标（catalog / enriched / 裸行三分支）：
 * - catalog：matchCatalogApp 命中本地即 AppCard 黄标；
 * - enriched：enrich 命中经 annotate + customIds 显式补齐即黄标；
 * - 裸行：enrich 缺席占位小行命中本地即标题旁黄标；
 * - 蓝优先不动，首刷 null→就绪补标，大小写归一。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import type { AppSummary, TrendRepo } from '../types';
import { TrendsView } from './TrendsView';
import { clearTrendsCache } from '../services/trends/cache';
import { clearTrendEnrichCache } from '../services/trends/enrich';
import { tauriApi } from '../services/api';
import { makeEnrichedApp, makeTrendRepo } from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';

vi.mock('./TrendsView/useTrendBoard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useTrendBoard: vi.fn() as any,
}));

import { useTrendBoard } from './TrendsView/useTrendBoard';
const mockUseTrendBoard = vi.mocked(useTrendBoard);

function mockBoard(repos: TrendRepo[]): void {
  mockUseTrendBoard.mockReturnValue({
    board: 'weekly',
    setBoard: vi.fn(),
    activeBoard: 'weekly',
    trendResult: { repos, status: 'ok', stale: false },
    setTrendResult: vi.fn(),
    gainKey: 'week',
    isLoading: false,
    boardReady: true,
    errorKind: undefined,
    handleRetry: vi.fn(),
    handleRefresh: vi.fn(),
    isRefreshing: false,
    trendFetchOpts: {},
    refreshEnrichForceRef: { current: false },
  } as unknown as ReturnType<typeof useTrendBoard>);
}

function localRow(id: string, owner: string, repo: string): AppSummary {
  return {
    ...makeApp({ id, name: repo, owner, repo, platforms: ['windows'] }),
    source: 'local',
    status: 'collected',
    is_cataloged: true,
  } as AppSummary;
}

describe('TrendsView 本地收录黄标三分支', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn> | undefined;
  let iconsSpy: MockInstance<() => Promise<(string | null)[]>> | undefined;
  let subSpy: MockInstance<() => Promise<() => void>> | undefined;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
    mockUseTrendBoard.mockReset();
    iconsSpy = vi.spyOn(tauriApi, 'getConfirmedIconsBatch').mockResolvedValue([]);
    subSpy = vi.spyOn(tauriApi, 'onSearchIconUpgraded').mockResolvedValue(() => {});
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    enrichSpy = undefined;
    iconsSpy?.mockRestore();
    subSpy?.mockRestore();
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
  });

  it('catalog 分支：同仓命中本地即黄标，无关行无标', async () => {
    mockBoard([makeTrendRepo({ id: 'acme/atlas' }), makeTrendRepo({ id: 'other/void' })]);
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const localAtlas = localRow('acme/atlas', 'acme', 'atlas');
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        allApps={[localAtlas, makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('.verified-badge-local').length).toBeGreaterThan(0);
    });
    // catalog 卡带黄标；裸行 void 无黄标
    const catalogCards = Array.from(
      container.querySelectorAll('.app-card:not(.trend-uncataloged-row)'),
    );
    expect(catalogCards.length).toBe(1);
    expect(catalogCards[0]?.querySelector('.verified-badge-local')).toBeTruthy();
    const voidRow = container.querySelectorAll('.trend-uncataloged-row');
    expect(voidRow.length).toBe(1);
    expect(voidRow[0]?.querySelector('.verified-badge-local')).toBeNull();
  });

  it('enriched 分支：customIds 显式补齐即黄标（matchingBase 缺本地）', async () => {
    mockBoard([makeTrendRepo({ id: 'acme/atlas' }), makeTrendRepo({ id: 'other/void' })]);
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })),
    );
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        allApps={[makeApp({ id: 'other/app', name: 'Other' })]}
        customIds={new Set(['acme/atlas'])}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card');
    expect(card?.querySelector('.verified-badge-local')).toBeTruthy();
    const voidDesc = await screen.findByText('other/void enriched desc');
    expect(voidDesc.closest('.app-card')?.querySelector('.verified-badge-local')).toBeNull();
    expect(container.querySelectorAll('.trend-uncataloged-row').length).toBe(0);
  });

  it('裸行分支：enrich 缺席时命中本地也在标题旁黄标', async () => {
    mockBoard([makeTrendRepo({ id: 'acme/atlas' }), makeTrendRepo({ id: 'other/void' })]);
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        allApps={[makeApp({ id: 'other/app', name: 'Other' })]}
        customIds={new Set(['acme/atlas'])}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    await screen.findByText('acme/atlas');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row').length).toBe(2);
    });
    const rows = Array.from(container.querySelectorAll('.trend-uncataloged-row'));
    const atlasRow = rows.find((el) => el.textContent?.includes('acme/atlas'));
    expect(atlasRow?.querySelector('.verified-badge-local')).toBeTruthy();
    expect(atlasRow?.querySelector('.verified-badge-local')?.getAttribute('title')).toBeTruthy();
    const voidRow = rows.find((el) => el.textContent?.includes('other/void'));
    expect(voidRow?.querySelector('.verified-badge-local')).toBeNull();
  });

  it('蓝优先：已验证远端同仓不叠黄', async () => {
    mockBoard([makeTrendRepo({ id: 'o/verified' }), makeTrendRepo({ id: 'other/void' })]);
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const verified = makeApp({
      id: 'o/verified',
      name: 'Verified',
      owner: 'o',
      repo: 'verified',
      platforms: ['windows'],
      is_verified: true,
    });
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        allApps={[verified, makeApp({ id: 'other/app', name: 'Other' })]}
        customIds={new Set(['o/verified'])}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Verified');
    });
    expect(container.querySelectorAll('.verified-badge-local').length).toBe(0);
    expect(container.querySelectorAll('.verified-badge').length).toBeGreaterThan(0);
  });

  it('首刷补标：customIds 空即无标，就绪后引用变化即补黄', async () => {
    mockBoard([makeTrendRepo({ id: 'acme/atlas' })]);
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const baseProps = {
      apps: [makeApp({ id: 'other/app', name: 'Other' })],
      allApps: [makeApp({ id: 'other/app', name: 'Other' })],
      favoriteIds: new Set<string>(),
      installedIds: new Set<string>(),
      installingIds: new Set<string>(),
      onOpenDetail: () => {},
      onQuickInstall: () => {},
      onToggleFavorite: () => {},
      onResetPlatformFilter: () => {},
    };
    const { container, rerender } = render(<TrendsView {...baseProps} customIds={new Set<string>()} />);
    await screen.findByText('acme/atlas');
    expect(container.querySelectorAll('.verified-badge-local').length).toBe(0);
    rerender(<TrendsView {...baseProps} customIds={new Set(['acme/atlas'])} />);
    await waitFor(() => {
      expect(container.querySelectorAll('.verified-badge-local').length).toBe(1);
    });
  });
});
