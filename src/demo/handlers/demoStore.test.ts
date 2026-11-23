/** 通过 handler 外部接口验证 `DemoStore`：本地库 overlay、任意卡片解析、隐藏规则与重置隔离。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoStore, resetDemoStore, visibleCatalogSummaries } from '../demoState';
import { findSummary, summaries } from '../fixtures';
import { DEMO_TREND_SNAPSHOT } from '../trendSnapshot';
import {
  handleGetAppDetails,
  handleGetCategoryApps,
  handleGetHomeFeed,
  handleGetLatestCatalogApps,
  handleGetReadmeVariants,
  handleGetRepoCardsBatch,
  handleGetSearchListCache,
  handleGetSimilarApps,
  handleSaveSearchListCache,
  handleSearchApps,
} from './catalog';
import { handleClearFeedFeedback, handleDismissFeatured, handleGetFeaturedPage } from './featured';
import { handleGetInstalledApps, handleInstallApp, handleSetAppHidden } from './installer';
import { handleToggleLaunchpadUpvote, handleGetLaunchpadFeed } from './launchpad';
import { handleGetFavoriteEntries, handleGetFavorites, handleToggleFavorite } from './social';

const LOCAL_ID = 'tw93/pake';
const LAUNCHPAD_ID = 'acme/hyper-term';
const TREND = DEMO_TREND_SNAPSHOT.daily.find((t) => !findSummary(`${t.owner}/${t.repo}`))!;
const TREND_ID = `${TREND.owner}/${TREND.repo}`.toLowerCase();

beforeEach(() => {
  resetDemoStore();
});

function featuredIds(): string[] {
  const page = handleGetFeaturedPage({ visitSeed: 1 });
  return [...page.hero, ...page.shelves.flatMap((s) => s.items)].map((p) => p.app.id.toLowerCase());
}

describe('DemoStore catalog overlay', () => {
  it('merges active Local Library entries stamped as local and searchable', () => {
    expect(findSummary(LOCAL_ID)).toBeUndefined();
    const hit = handleSearchApps({ query: 'pake' }).find((s) => s.id === LOCAL_ID);
    expect(hit).toMatchObject({ source: 'local', is_cataloged: true, is_verified: false });
    const localIds = visibleCatalogSummaries()
      .filter((s) => s.source === 'local')
      .map((s) => s.id);
    // 4 条本地库：2 已收录 + 2 已提交；草稿与归档行不入目录
    expect(localIds.sort()).toEqual(['ente-io/ente', 'lencx/noi', 'tagstudiodev/tagstudio', 'tw93/pake']);
  });
});

describe('DemoStore resolves non-catalog cards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['Local Library', LOCAL_ID],
    ['Launchpad', LAUNCHPAD_ID],
    ['Launchpad (codeberg)', 'codeberg:pixel-forge/palette'],
    ['external trend', TREND_ID],
    ['arbitrary coordinate', 'someone/somewhere'],
  ])('%s detail, readme and install succeed', async (_label, id) => {
    const detail = handleGetAppDetails({ id });
    expect(detail.id.toLowerCase()).toBe(id);
    expect(detail.releases.length).toBeGreaterThan(0);
    expect(handleGetReadmeVariants({ appId: id }).variants.length).toBe(2);

    const pending = handleInstallApp({ appId: id });
    await vi.runAllTimersAsync();
    const installed = await pending;
    expect(installed.app_id.toLowerCase()).toBe(id);
    expect(handleGetInstalledApps().some((i) => i.app_id.toLowerCase() === id)).toBe(true);
  });

  it('repo cards hydrate known cards and keep unknown coordinates DB-only null', () => {
    const [local, launchpad, trend, unknown] = handleGetRepoCardsBatch({
      ids: [LOCAL_ID, LAUNCHPAD_ID, TREND_ID, 'someone/somewhere'],
    });
    expect(local?.summary.source).toBe('local');
    expect(launchpad?.summary.id).toBe(LAUNCHPAD_ID);
    expect(trend?.summary.id).toBe(TREND_ID);
    expect(unknown).toBeNull();
  });

  it('still rejects ids that are not coordinates', () => {
    expect(() => handleGetAppDetails({ id: 'not a repo' })).toThrow('unknown app');
  });
});

describe('UpdateRule.is_hidden filters every catalog list', () => {
  it('hides the app from search, category, latest, home feed, featured and similar', () => {
    const target = summaries.find((s) => s.added_at && featuredIds().includes(s.id.toLowerCase()))!;
    expect(target).toBeDefined();
    const id = target.id;
    const inSearch = () => handleSearchApps({ query: target.name }).some((s) => s.id === id);
    const inCategory = () =>
      handleGetCategoryApps({ category: target.category, perPage: 50, page: 1 }).matched_ids.includes(id);
    const inLatest = () => handleGetLatestCatalogApps({ perPage: 50 }).matched_ids.includes(id);
    const inHome = () => handleGetHomeFeed({ limit: 100, seed: 1 }).items.some((s) => s.id === id);
    const inFeatured = () => featuredIds().includes(id.toLowerCase());
    expect([inSearch(), inCategory(), inLatest(), inFeatured()]).toEqual([true, true, true, true]);
    const homeBefore = handleGetHomeFeed({ limit: 100, seed: 1 }).total;

    handleSetAppHidden({ appId: id, isHidden: true });

    expect([inSearch(), inCategory(), inLatest(), inHome(), inFeatured()]).toEqual([false, false, false, false, false]);
    expect(handleGetHomeFeed({ limit: 100, seed: 1 }).total).toBe(homeBefore - 1);
    const similar = handleGetSimilarApps({ appId: summaries.find((s) => s.category === target.category && s.id !== id)!.id, limit: 8 });
    expect(similar.items.some((i) => i.app.id === id)).toBe(false);
  });
});

describe('favorites keep uncataloged entries', () => {
  it('returns uncataloged favorites newest first with is_cataloged=false', () => {
    handleToggleFavorite({ appId: TREND_ID });
    expect(handleGetFavorites()[0]).toBe(TREND_ID);
    const entry = handleGetFavoriteEntries().find((e) => e.app_id === TREND_ID);
    expect(entry?.is_cataloged).toBe(false);

    handleToggleFavorite({ appId: LOCAL_ID });
    expect(handleGetFavoriteEntries().find((e) => e.app_id === LOCAL_ID)?.is_cataloged).toBe(true);
  });
});

describe('resetDemoStore isolates every slice', () => {
  it('drops persisted and session state in one call', () => {
    handleToggleFavorite({ appId: TREND_ID });
    handleSetAppHidden({ appId: 'rustdesk/rustdesk', isHidden: true });
    handleDismissFeatured({ target: 'dev', scope: 'category' });
    handleSaveSearchListCache({ cacheKey: 'k', normQuery: 'q', payloadJson: '[]' });
    const lp = handleGetLaunchpadFeed({}).spotlight[0];
    handleToggleLaunchpadUpvote({ discussionNumber: lp.discussion_number, currentlyUpvoted: false });
    demoStore().iconLevel.set('x/y', 3);

    resetDemoStore();

    expect(handleGetFavorites()).not.toContain(TREND_ID);
    expect(demoStore().updateRules.some((r) => r.app_id === 'rustdesk/rustdesk')).toBe(false);
    expect(handleClearFeedFeedback()).toBe(0);
    expect(handleGetSearchListCache({ cacheKey: 'k' })).toBeNull();
    expect(handleGetLaunchpadFeed({}).spotlight[0].viewer_has_upvoted).toBe(false);
    expect(demoStore().iconLevel.size).toBe(0);
  });
});
