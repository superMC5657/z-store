/**
 * 现状：裸行直展回归（paint-sync lane）：
 * - 未就绪不再拦整榜，board repos 直接展裸行（排名+仓库名+星，与裸行同形）；
 * - enrich/SWR 到即原地升级富卡，全程无 trends-skeleton 空号。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { TrendsView } from './TrendsView';
import { trendingHtmlFixture, makeEnrichedApp } from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';
import { tauriApi } from '../services/api';
import * as clientModule from '../services/api/client';
import { clearTrendsCache } from '../services/trends/cache';
import { clearTrendEnrichCache, snapshotTrendEnrichCache } from '../services/trends/enrich';
import type { TrendRepo } from '../types';

describe('裸行直展：未就绪展裸行不展骨架', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
  });

  it('board 落定即展裸行有名，enrich 悬挂仍有名，全程无骨架', async () => {
    // 现状：board repos 落定即展裸行，enrich 悬挂不等齐，裸行即逃生。
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        platformResolvedOtherIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    // 裸行有名直展（排名+仓库名+星，与裸行同形），无富卡描述，全程无骨架空号。
    await screen.findByText('acme/atlas');
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    expect(screen.queryByText('acme/atlas enriched desc')).toBeNull();
    expect(screen.queryByTestId('trends-skeleton')).toBeNull();
    expect(container.querySelector('.trends-skeleton')).toBeNull();
    // 悬挂窗口内仍无骨架：裸行保持，骨架不出现。
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(3);
    expect(screen.queryByTestId('trends-skeleton')).toBeNull();
  });

  it('就绪展盘值免重搜：L2 具平台直展富卡，零 enrich/lite', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    // L2 盘：三仓具平台富信封 + 无确认集（具平台无需确认）。
    const repos = [
      { id: 'acme/atlas', owner: 'acme', repo: 'atlas', name: 'acme/atlas', stars: 12000, url: 'https://github.com/acme/atlas' },
      { id: 'acme/beacon', owner: 'acme', repo: 'beacon', name: 'acme/beacon', stars: 1500, url: 'https://github.com/acme/beacon' },
      { id: 'acme/comet', owner: 'acme', repo: 'comet', name: 'acme/comet', stars: 1200, url: 'https://github.com/acme/comet' },
    ] as unknown as TrendRepo[];
    const enrich = {
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: ['macos'] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: ['linux'] }),
    };
    const envelope = JSON.stringify({ v: 1, repos, enrich });
    const nowSec = Math.floor(Date.now() / 1000);
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: envelope, cached_at: nowSec - 60 };
      }
      return undefined;
    });
    // 网络兜底（L2 未命中才用，此处不应触达 trending，但保留 mock 防 unexpected url）。
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    const enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos');
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite');
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        platformResolvedOtherIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    // 现状：L2 盘值直展富卡，无裸行，全程无骨架空号。
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(screen.queryByTestId('trends-skeleton')).toBeNull();
    expect(container.querySelectorAll('.app-card').length).toBeGreaterThanOrEqual(3);
    // 免重搜：后台零后端请求（enrich 命中内存，lite 具平台免验）。
    await new Promise((r) => setTimeout(r, 80));
    expect(enrichSpy).not.toHaveBeenCalled();
    expect(liteSpy).not.toHaveBeenCalled();
    // 内存与盘一致：具平台已在内存（小写归一键）。
    expect(snapshotTrendEnrichCache()['acme/atlas']?.platforms).toEqual(['windows']);
  });
});
