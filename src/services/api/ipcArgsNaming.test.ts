/**
 * IPC 请求参数命名收敛（camelCase）卡点：
 * - 全部 services/api 包装器经 `client.tauriInvoke` 透传，后端桥接后生效；
 * - 请求 key 一律 camelCase（`/^[a-z][a-zA-Z0-9]*$/`），读侧响应 snake 保持不动；
 * - iconStore 禁直调 invoke（经 `catalog.getOrFetchIcon`，见下）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from './client';
import * as catalog from './catalog';
import * as installer from './installer';
import * as launchpad from './launchpad';
import * as settings from './settings';
import * as social from './social';

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

type Captured = { cmd: string; args: Record<string, unknown> };

function stubFor(cmd: string): unknown {
  switch (cmd) {
    case 'get_launchpad_feed':
      return { spotlight: [], items: [], is_stale: false };
    case 'get_home_feed':
    case 'get_category_apps':
      return { items: [], total: 0, has_more: false };
    case 'search_apps_online':
      return { rows: [], sid: 'sid' };
    case 'get_platforms_lite':
      return { id: 'x', platforms: [] };
    case 'get_readme_variants':
      return { variants: [] };
    case 'fetch_or_cache_asset_url':
      return 'https://example.com/x.png';
    case 'get_or_fetch_icon':
      return 'data:,';
    case 'cycle_app_icon':
      return { url: '', level: 1 };
    case 'get_license_allowlist':
      return { enabled: true, allowed: ['MIT'] };
    case 'get_custom_app_pr_url':
      return 'https://example.com/pr';
    case 'get_custom_app_pr_payload':
      return '{}';
    case 'export_backup_file':
      return '/tmp/logs/backup.json';
    case 'collect_local_app':
    case 'revert_collected_to_draft':
    case 'withdraw_submitted':
      return {
        id: 'o/r',
        item: { id: 'o/r' },
        status: 'collected',
        pr_url: null,
        created_at: 1,
        updated_at: 1,
        archived: false,
      };
    case 'import_matched_apps':
      return 0;
    case 'delete_custom_app':
    case 'unwatch_app':
    case 'watch_app':
    case 'dismiss_watch_notification':
    case 'restore_watch_notification':
    case 'unstar_app':
    case 'toggle_favorite':
    case 'uninstall_app':
    case 'unmanage_app':
    case 'launch_app':
    case 'show_file_in_folder':
    case 'open_folder':
    case 'switch_mirror':
    case 'save_setting':
      return true;
    case 'fetch_starred_status':
      return false;
    case 'oauth_device_poll':
      return { status: 'pending' };
    case 'select_folder':
    case 'get_cli_deep_link':
    case 'get_oauth_user':
    case 'restore_or_fetch_icon_cycle':
      return null;
    default:
      return undefined;
  }
}

describe('ipc args naming (camelCase)', () => {
  const captured: Captured[] = [];

  beforeEach(() => {
    captured.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd: string, args = {}) => {
      captured.push({ cmd, args: { ...(args as Record<string, unknown>) } });
      return stubFor(cmd) as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('分类/最新入库 allowedIds 原样透传（含空数组），省略时不带键；matched_ids 透出', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd: string, args = {}) => {
      captured.push({ cmd, args: { ...(args as Record<string, unknown>) } });
      return { items: [], total: 0, has_more: false, matched_ids: ['a/b'] } as never;
    });
    const cat = await catalog.getCategoryApps('dev', 1, 20, ['a/b', 'c/d']);
    await catalog.getCategoryApps('dev', 1, 20, []);
    await catalog.getCategoryApps('dev', 1, 20);
    const latest = await catalog.getLatestCatalogApps(7, 1, 20, []);
    await catalog.getLatestCatalogApps(7, 1, 20);

    expect(captured.map((c) => c.args.allowedIds)).toEqual([
      ['a/b', 'c/d'],
      [],
      undefined,
      [],
      undefined,
    ]);
    expect('allowedIds' in captured[2].args).toBe(false);
    expect('allowedIds' in captured[4].args).toBe(false);
    expect(cat.matched_ids).toEqual(['a/b']);
    expect(latest.matched_ids).toEqual(['a/b']);
  });

  function expectAllCamel() {
    expect(captured.length).toBeGreaterThan(0);
    for (const { cmd, args } of captured) {
      for (const key of Object.keys(args ?? {})) {
        expect(key, `${cmd} arg "${key}"`).toMatch(CAMEL);
        expect(key.includes('_'), `${cmd} arg "${key}"`).toBe(false);
      }
    }
  }

  it('catalog 包装器一律 camelCase', async () => {
    const swallow = async (p: Promise<unknown>): Promise<void> => {
      try {
        await p;
      } catch {
        // 参数已捕获，业务回退/抛错不影响命名断言
      }
    };
    await swallow(catalog.searchApps('q', 10, 0));
    await swallow(catalog.getHomeFeed(20, 0, 1, 'balanced'));
    await swallow(catalog.searchAppsOnline('q', 'sid-1', 1, 20, true));
    await swallow(catalog.enrichTrendRepos([{ owner: 'o', repo: 'r' }], true));
    await swallow(catalog.getAppDetails('o/r', true));
    await swallow(catalog.getCachedAppDetailsBatch(['o/r']));
    await swallow(catalog.getConfirmedIconsBatch(['o/r']));
    await swallow(catalog.getRepoCardsBatch(['o/r']));
    await swallow(catalog.getSearchListCache('q|1|20'));
    await swallow(catalog.saveSearchListCache('q|1|20', 'q', '{}', true));
    await swallow(catalog.getPlatformsLite('o/r', true));
    await swallow(catalog.getReadmeVariants('o/r'));
    await swallow(catalog.fetchOrCacheAssetUrl('https://example.com/x.png', 'o/r'));
    await swallow(catalog.getCategoryApps('dev', 1, 20));
    await swallow(catalog.getLatestCatalogApps(30, 1, 20));
    await swallow(catalog.getLatestCatalogApps({ minDays: 7, maxDays: 30 }, 1, 20));
    await swallow(catalog.getCategoryApps('dev', 1, 20, ['o/r']));
    await swallow(catalog.getLatestCatalogApps(30, 1, 20, []));
    await swallow(catalog.importMatchedApps([]));
    await swallow(catalog.recordSearchQuery('q'));
    await swallow(catalog.removeSearchQuery('q'));
    await swallow(catalog.recordAppView('o/r'));
    await swallow(catalog.dismissFeatured('dev', 'category', 'o/r'));
    await swallow(catalog.syncCatalog(true));
    await swallow(catalog.consumeStartupCatalogSynced());
    await swallow(catalog.getOrFetchIcon('o/r', 'https://example.com/x.png'));
    await swallow(catalog.cycleAppIcon('o/r'));
    await swallow(catalog.restoreOrFetchIconCycle('o/r'));
    await swallow(catalog.listCustomApps(true));
    await swallow(catalog.saveCustomApp({ id: 'o/r' } as never));
    await swallow(catalog.deleteCustomApp('o/r'));
    await swallow(catalog.markCustomSubmitted('o/r', 'https://example.com/pr'));
    await swallow(catalog.collectLocalApp('o/r'));
    await swallow(catalog.revertCollectedApp('o/r'));
    await swallow(catalog.withdrawSubmitted('o/r'));
    await swallow(catalog.getCustomAppPrUrl('o/r'));
    await swallow(catalog.getCustomAppPrPayload('o/r'));
    await swallow(catalog.getLicenseAllowlist());
    // 无参调用亦覆盖（空 args 无 key 即通过）
    await swallow(catalog.getSearchHistory());

    expectAllCamel();

    const byCmd = new Map(captured.map((c) => [c.cmd, c.args]));
    const collectCalls = captured.filter((c) => c.cmd === 'collect_local_app').map((c) => c.args);
    expect(byCmd.get('search_apps_online')).toMatchObject({
      searchId: 'sid-1',
      perPage: 20,
      forceRefresh: true,
    });
    expect(byCmd.get('enrich_trend_repos')).toMatchObject({ forceRefresh: true });
    expect(byCmd.get('get_platforms_lite')).toMatchObject({ forceRefresh: true });
    expect(byCmd.get('get_category_apps')).toMatchObject({ perPage: 20 });
    expect(byCmd.get('list_custom_apps')).toMatchObject({ includeArchived: true });
    expect(byCmd.get('mark_submitted')).toMatchObject({ prUrl: 'https://example.com/pr' });
    expect(byCmd.get('collect_local_app')).toMatchObject({ id: 'o/r' });
    expect(byCmd.get('revert_collected_to_draft')).toMatchObject({ id: 'o/r' });
    expect(byCmd.get('withdraw_submitted')).toMatchObject({ id: 'o/r' });
    expect(collectCalls).toHaveLength(1);
    for (const args of collectCalls) {
      expect(args).toEqual({ id: 'o/r' });
    }
  });

  it('installer/social/settings 包装器一律 camelCase', async () => {
    const swallow = async (p: Promise<unknown>): Promise<void> => {
      try {
        await p;
      } catch {
        // 同上
      }
    };
    await swallow(installer.installApp('o/r', 'a.zip', '/tmp'));
    await swallow(installer.downloadAsset('o/r', 'a.zip'));
    await swallow(installer.showFileInFolder('/tmp'));
    await swallow(installer.openFolder('/tmp'));
    await swallow(installer.uninstallApp('o/r'));
    await swallow(installer.unmanageApp('o/r'));
    await swallow(installer.launchApp('o/r'));
    await swallow(installer.checkForUpdates(true));
    await swallow(installer.setAppSkipVersion('o/r', 'v1'));
    await swallow(installer.setAppFrozen('o/r', true));
    await swallow(installer.setAppHidden('o/r', true));
    await swallow(installer.selectFolder('/tmp', 't'));
    await swallow(social.toggleFavorite('o/r'));
    await swallow(social.getDeveloperProfile('dev'));
    await swallow(social.listGithubStarred('user', 2, 20, true));
    await swallow(social.getStarredFeedCache('user'));
    await swallow(social.saveStarredFeedCache('user', 'user', '{}'));
    await swallow(social.watchApp('o/r'));
    await swallow(social.unwatchApp('o/r'));
    await swallow(social.getWatchNotifications());
    await swallow(social.checkWatchedUpdates(true));
    await swallow(social.dismissWatchNotification('o/r'));
    await swallow(social.getDismissedWatchNotifications());
    await swallow(social.restoreWatchNotification('o/r'));
    await swallow(social.oauthDevicePoll('code'));
    await swallow(social.starApp('o/r'));
    await swallow(social.unstarApp('o/r'));
    await swallow(social.fetchStarredStatus('o/r'));
    await swallow(settings.switchMirror('m'));
    await swallow(settings.testProxy('http://proxy'));
    await swallow(settings.fetchTrendsText('https://example.com/t'));
    await swallow(settings.saveSetting('k', 'v'));
    await swallow(settings.handleDeepLink('zstore://x'));
    await swallow(settings.importUserData('{}'));
    await swallow(settings.exportBackupFile('backup.json', '{}'));
    await swallow(settings.openUrl('https://example.com/'));

    expectAllCamel();
  });

  it('开源广场 5 个包装器请求键全部 camelCase，可选游标缺省时不带键', async () => {
    const swallow = async (p: Promise<unknown>): Promise<void> => {
      try {
        await p;
      } catch {
        // 参数已捕获，回包形状不影响命名断言
      }
    };
    await launchpad.getLaunchpadFeed(true);
    await launchpad.syncLaunchpadDiscussions(true);
    await swallow(launchpad.getLaunchpadDiscussion('o/r', 7));
    await swallow(launchpad.getLaunchpadDiscussion('o/r', 7, 'Y3Vy', true));
    await swallow(
      launchpad.addLaunchpadComment({
        discussionRepo: 'o/r',
        discussionNumber: 7,
        discussionId: 'D_1',
        body: 'hi',
        replyToId: 'DC_1',
      }),
    );
    await swallow(
      launchpad.toggleLaunchpadUpvote({
        discussionRepo: 'o/r',
        discussionNumber: 7,
        subjectId: 'D_1',
        currentlyUpvoted: false,
      }),
    );
    await swallow(
      launchpad.toggleLaunchpadCommentUpvote({
        discussionRepo: 'o/r',
        discussionNumber: 7,
        commentId: 'DC_1',
        currentlyUpvoted: true,
      }),
    );
    await swallow(
      launchpad.toggleLaunchpadReaction({
        discussionRepo: 'o/r',
        discussionNumber: 7,
        subjectId: 'DC_1',
        content: 'THUMBS_UP',
        currentlyReacted: false,
      }),
    );

    expect(captured.map((c) => c.cmd)).toEqual([
      'get_launchpad_feed',
      'sync_launchpad_discussions',
      'get_launchpad_discussion',
      'get_launchpad_discussion',
      'add_launchpad_comment',
      'toggle_launchpad_upvote',
      'toggle_launchpad_comment_upvote',
      'toggle_launchpad_reaction',
    ]);
    expect(captured[0].args).toEqual({ forceRefresh: true });
    expect(captured[1].args).toEqual({ forceRefresh: true });
    expect(captured[2].args).toEqual({ discussionRepo: 'o/r', discussionNumber: 7, forceRefresh: false });
    expect(captured[3].args).toMatchObject({ cursor: 'Y3Vy', forceRefresh: true });
    expect(captured[4].args).toMatchObject({ discussionId: 'D_1', body: 'hi', replyToId: 'DC_1' });
    expect(captured[5].args).toMatchObject({ subjectId: 'D_1', currentlyUpvoted: false });
    expect(captured[6].args).toEqual({ discussionRepo: 'o/r', discussionNumber: 7, commentId: 'DC_1', currentlyUpvoted: true });
    expect(captured[7].args).toEqual({
      discussionRepo: 'o/r',
      discussionNumber: 7,
      subjectId: 'DC_1',
      content: 'THUMBS_UP',
      currentlyReacted: false,
    });
    expectAllCamel();
  });

  it('iconStore 预热经 catalog.getOrFetchIcon（无字面量 cmd 直调）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = fs.readFileSync(path.resolve(here, '../iconStore.ts'), 'utf8');
    expect(text).toContain('getOrFetchIcon');
    expect(text).not.toMatch(/tauriInvoke\s*<\s*string\s*>\s*\(\s*['"]get_or_fetch_icon['"]/);
  });
});
