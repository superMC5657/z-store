/**
 * 趋势未收录行徽标锁定：
 * - 未收录 enrich 行安装态走真实已安装检查（归一 ID），禁止回退硬编码 false；
 * - 大小写变体 ID 下徽标与收录行一致（managed 绿）；
 * - managed 未加载（managedIds=null）时已安装命中行渲染中性占位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import type { AppSummary } from '../types';
import { TrendsView } from './TrendsView';
import { clearTrendsCache } from '../services/trends/cache';
import { clearTrendEnrichCache } from '../services/trends/enrich';
import { tauriApi } from '../services/api';
import { makeEnrichedApp, trendingHtmlFixture } from './test-utils/trendFixture';
import { makeApp } from './test-utils/filterFixture';

describe('TrendsView 未收录行徽标：真实安装检查（非硬编码 false）', () => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  type EnrichFn = (repos: { owner: string; repo: string }[]) => Promise<(AppSummary | null)[]>;
  let enrichSpy: MockInstance<EnrichFn>;
  let settingsSpy: MockInstance<() => Promise<Record<string, string>>>;
  let openUrlSpy: MockInstance<(url: string) => Promise<void>>;
  let trendSpy: MockInstance<(url: string) => Promise<string>>;
  let trendingHtml: string | Error = '';

  function renderBoard(opts: { installedIds?: Set<string>; managedIds?: Set<string> | null }) {
    return render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={opts.installedIds ?? new Set<string>()}
        installingIds={new Set<string>()}
        managedIds={opts.managedIds}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
      />,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
    trendingHtml = trendingHtmlFixture();
    settingsSpy = vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    openUrlSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    trendSpy = vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) {
        if (trendingHtml instanceof Error) throw trendingHtml;
        return trendingHtml;
      }
      throw new Error(`unexpected url: ${url}`);
    });
    enrichSpy = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) => {
        const id = `${r.owner}/${r.repo}`;
        // 回填值 id 用大写变体（镜像键仍为小写 owner/repo）：锁定徽标查询侧归一；
        // 描述保持小写键文案，便于定位行。
        if (id === 'acme/atlas') return makeEnrichedApp({ id: 'ACME/ATLAS', description: 'acme/atlas enriched desc' });
        if (id === 'acme/beacon') return makeEnrichedApp({ id: 'ACME/BEACON', description: 'acme/beacon enriched desc' });
        return makeEnrichedApp({ id });
      }),
    );
  });

  afterEach(() => {
    enrichSpy?.mockRestore();
    settingsSpy.mockRestore();
    openUrlSpy.mockRestore();
    trendSpy.mockRestore();
    cleanup();
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
  });

  it('已安装命中的未收录行展示 managed 徽标（大小写变体 ID 归一）', async () => {
    // 生产集合恒含归一小写条目；回填值 id 为大写变体，锁定查询侧归一判定。
    renderBoard({
      installedIds: new Set(['acme/atlas']),
      managedIds: new Set(['acme/atlas']),
    });
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card');
    expect(card).toBeTruthy();
    // 真实检查：managed 绿徽标，而非硬编码 false 的“获取”按钮。
    expect(card?.querySelector('[data-badge="managed"]')).toBeTruthy();
    expect(card?.querySelector('[data-badge="managed"]')?.textContent).toBe('安装');
  });

  it('managed 未加载时已安装命中行占位', async () => {
    renderBoard({
      installedIds: new Set(['acme/atlas']),
      managedIds: null,
    });
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card');
    expect(card).toBeTruthy();
    expect(card?.querySelector('[data-badge="unknown"]')).toBeTruthy();
  });

  it('未安装的未收录行保持 Get（data-badge=none）', async () => {
    renderBoard({
      installedIds: new Set<string>(),
      managedIds: new Set<string>(),
    });
    const descEl = await screen.findByText('acme/atlas enriched desc');
    const card = descEl.closest('.app-card');
    expect(card).toBeTruthy();
    expect(card?.querySelector('[data-badge="none"]')).toBeTruthy();
    expect(card?.querySelector('[data-badge="managed"]')).toBeNull();
  });
});
