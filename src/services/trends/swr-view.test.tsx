import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { TrendsView } from '../../views/TrendsView';
import { trendingHtmlFixture, makeEnrichedApp } from '../../views/test-utils/trendFixture';
import { makeApp } from '../../views/test-utils/filterFixture';
import { tauriApi } from '../api';
import { clearTrendsCache } from './cache';
import { clearTrendEnrichCache, hydrateTrendEnrichCache } from './enrich';

describe('SWR 组件直展：重挂首屏即见富 pending 卡，不闪裸行', () => {
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

  it('预 hydrate pending 后挂载直展 AppCard，无裸行占位', async () => {
    // 重启前 L2 富信封：三仓均为 pending（Other 待确认语义）
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
      'acme/beacon': makeEnrichedApp({ id: 'acme/beacon', platforms: [] }),
      'acme/comet': makeEnrichedApp({ id: 'acme/comet', platforms: [] }),
    });
    // 网络返回同榜三仓；enrich 通道故障（后台 revalidate 缺席，不覆盖直展）
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockRejectedValue(new Error('offline'));
    const { container } = render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
    // 首屏直展：pending 富卡描述出现，且无裸行占位闪烁
    await screen.findByText('acme/atlas enriched desc');
    await waitFor(() => {
      expect(container.querySelectorAll('.trend-uncataloged-row')).toHaveLength(0);
    });
    expect(container.querySelector('.app-card .app-desc')).toBeTruthy();
  });
});
