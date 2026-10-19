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
import * as settings from './settings';
import * as social from './social';

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

type Captured = { cmd: string; args: Record<string, unknown> };

function stubFor(cmd: string): unknown {
  switch (cmd) {
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
    case 'request_app_icon_cycle':
      return { url: '', level: 1 };
    case 'get_license_allowlist':
      return { enabled: true, allowed: ['MIT'] };
    case 'get_custom_app_pr_url':
    case 'get_custom_apps_batch_pr_url':
      return 'https://example.com/pr';
    case 'get_custom_app_pr_payload':
      return '{}';
    case 'get_custom_apps_batch_pr_payload':
      return '[]';
    case 'collect_custom_app':
    case 'collect_local_app':
    case 'revert_collected_to_draft':
      return {
        id: 'o/r',
        item: { id: 'o/r' },
        status: 'collected',
        pr_url: null,
        created_at: 1,
        updated_at: 1,
        archived: false,
      };
    case 'clear_asset_cache':
    case 'clear_icon_cache':
    case 'get_catalog_count':
    case 'import_matched_apps':
      return 0;
    case 'delete_custom_app':
    case 'unwatch_app':
    case 'watch_app':
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
    case 'is_starred':
      return false;
    case 'oauth_device_poll':
      return { status: 'pending' };
    case 'select_folder':
    case 'get_cli_deep_link':
    case 'get_asset_cache_stats':
    case 'get_icon_cache_stats':
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
    await swallow(catalog.getPlatformsLite('o/r', true));
    await swallow(catalog.getReadmeVariants('o/r'));
    await swallow(catalog.fetchOrCacheAssetUrl('https://example.com/x.png', 'o/r'));
    await swallow(catalog.getCategoryApps('dev', 1, 20));
    await swallow(catalog.importMatchedApps([]));
    await swallow(catalog.recordSearchQuery('q'));
    await swallow(catalog.removeSearchQuery('q'));
    await swallow(catalog.recordAppView('o/r'));
    await swallow(catalog.searchForgeRepos('github', 'q', 'https://github.com'));
    await swallow(catalog.syncCatalog(true));
    await swallow(catalog.getOrFetchIcon('o/r', 'https://example.com/x.png'));
    await swallow(catalog.cycleAppIcon('o/r'));
    await swallow(catalog.restoreOrFetchIconCycle('o/r'));
    await swallow(catalog.listCustomApps(true));
    await swallow(catalog.saveCustomApp({ id: 'o/r' } as never));
    await swallow(catalog.deleteCustomApp('o/r'));
    await swallow(catalog.markCustomSubmitted('o/r', 'https://example.com/pr'));
    await swallow(catalog.collectCustomApp('o/r'));
    await swallow(catalog.collectLocalApp('o/r'));
    await swallow(catalog.revertCollectedApp('o/r'));
    await swallow(catalog.retireOnSync(['o/r']));
    await swallow(catalog.retireOnSync(undefined));
    await swallow(catalog.getCustomAppPrUrl('o/r'));
    await swallow(catalog.getCustomAppsBatchPrUrl(['o/r']));
    await swallow(catalog.getCustomAppPrPayload('o/r'));
    await swallow(catalog.getCustomAppsBatchPrPayload(['o/r']));
    await swallow(catalog.getLicenseAllowlist());
    // 无参调用亦覆盖（空 args 无 key 即通过）
    await swallow(catalog.getCatalogCount());
    await swallow(catalog.getSearchHistory());

    expectAllCamel();

    const byCmd = new Map(captured.map((c) => [c.cmd, c.args]));
    const retireCalls = captured.filter((c) => c.cmd === 'retire_on_sync').map((c) => c.args);
    const collectCalls = captured.filter((c) => c.cmd === 'collect_custom_app' || c.cmd === 'collect_local_app').map((c) => c.args);
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
    expect(byCmd.get('collect_custom_app')).toMatchObject({ id: 'o/r' });
    expect(byCmd.get('collect_local_app')).toMatchObject({ id: 'o/r' });
    expect(byCmd.get('revert_collected_to_draft')).toMatchObject({ id: 'o/r' });
    expect(collectCalls).toHaveLength(2);
    for (const args of collectCalls) {
      expect(args).toEqual({ id: 'o/r' });
    }
    expect(retireCalls).toContainEqual({ remoteIds: ['o/r'] });
    expect(retireCalls).toContainEqual({});
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
    await swallow(installer.removeUpdateRule('o/r'));
    await swallow(installer.selectFolder('/tmp', 't'));
    await swallow(social.toggleFavorite('o/r'));
    await swallow(social.getDeveloperProfile('dev'));
    await swallow(social.syncGithubStarred('user'));
    await swallow(social.setHostToken('h', 't'));
    await swallow(social.removeHostToken('h'));
    await swallow(social.refreshHostRateLimit('h'));
    await swallow(social.testHostConnection('h', 't'));
    await swallow(social.watchApp('o/r'));
    await swallow(social.unwatchApp('o/r'));
    await swallow(social.oauthDevicePoll('code'));
    await swallow(social.starApp('o/r'));
    await swallow(social.unstarApp('o/r'));
    await swallow(social.isStarred('o/r'));
    await swallow(settings.switchMirror('m'));
    await swallow(settings.testProxy('http://proxy'));
    await swallow(settings.fetchTrendsText('https://example.com/t'));
    await swallow(settings.saveSetting('k', 'v'));
    await swallow(settings.handleDeepLink('zstore://x'));
    await swallow(settings.importUserData('{}'));
    await swallow(settings.openUrl('https://example.com/'));

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
