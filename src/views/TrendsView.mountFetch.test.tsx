/** 测试趋势榜挂载即抓榜，不等待设置读取。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { TrendsView } from './TrendsView';
import { trendingHtmlFixture } from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';
import { tauriApi } from '../services/api';
import { clearTrendEnrichCache, clearTrendsCache } from '../services/trends';

describe('TrendsView 挂载抓榜', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  beforeEach(async () => {
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    vi.restoreAllMocks();
  });

  it('getSettings 永不返回时仍立即请求并展示榜单', async () => {
    const settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockImplementation(() => new Promise<never>(() => {}));
    const fetchSpy = vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(() => new Promise<never>(() => {}));

    render(
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

    await screen.findByText('acme/atlas');
    expect(fetchSpy).toHaveBeenCalled();
    expect(settingsSpy).not.toHaveBeenCalled();
  });
});
