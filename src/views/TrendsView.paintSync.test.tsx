/**
 * 裸行直展（paint-sync lane）：
 * - 未就绪不拦整榜，board repos 直接展裸行（仓库名+星）；
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
import { clearTrendEnrichCache, clearTrendsCache, snapshotTrendEnrichCache } from '../services/trends';

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
    // 裸行直展（仓库名+星），无富卡描述，全程无骨架空号。
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

  it('就绪展盘值免重搜：L2 排行索引 + repo_card_cache 具平台卡片直展富卡，零 enrich/lite', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    // L2：三仓 v2 排行索引；单仓富卡由 repo_card_cache 批量水合（具平台无需确认）。
    const index = JSON.stringify({
      v: 2,
      items: [
        { id: 'acme/atlas', stars: 12000 },
        { id: 'acme/beacon', stars: 1500 },
        { id: 'acme/comet', stars: 1200 },
      ],
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const cards: Record<string, ReturnType<typeof makeEnrichedApp>> = {
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: ['macos'] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: ['linux'] }),
    };
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === 'get_trend_board_cache') {
        return { payload_json: index, cached_at: nowSec - 60 };
      }
      if (cmd === 'get_repo_cards_batch') {
        return ((args as { ids: string[] }).ids ?? []).map((id) =>
          cards[id] ? { summary: cards[id], confirmed_other: false, updated_at: nowSec - 60 } : null,
        );
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
