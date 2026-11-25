/** 测试 App 级平台筛选状态、localStorage 持久化与跨视图计数一致性。 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSummary } from './types';
import {
  PLATFORM_FILTER_STORAGE_KEY,
  PLATFORM_IDS,
  loadSelectedPlatforms,
  matchPlatformSet,
  parseSelectedPlatformArray as parsePersistedSelection,
  parseSelectedPlatforms,
} from './lib/platformFilter';

interface BaselineApp {
  platforms?: string[];
}

const FIXTURE: BaselineApp[] = [
  { platforms: ['windows'] },
  { platforms: ['ios'] },
  { platforms: ['android', 'linux'] },
  {},
  { platforms: [] },
  { platforms: ['macOS'] },
];

describe('baseline: full platform selection is equivalent to unfiltered', () => {
  it('a full 6-platform set matches every fixture app', () => {
    const full = new Set<string>(PLATFORM_IDS);
    expect(full.size).toBe(6);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, full)).toBe(true);
    }
  });

  it('an empty selection matches no fixture app (empty-filter premise, not the full list)', () => {
    const empty = parsePersistedSelection([]);
    expect(empty.size).toBe(0);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, empty)).toBe(false);
    }
    expect(FIXTURE.filter((a) => matchPlatformSet(a, empty))).toEqual([]);
  });
});

afterEach(() => {
  window.localStorage.clear();
});

describe('task3: platform-filter persistence (Decision B select-nothing)', () => {
  it('uses the stable storage key zstore:platform-filter:v2', () => {
    expect(PLATFORM_FILTER_STORAGE_KEY).toBe('zstore:platform-filter:v2');
  });

  it('no key (null) → full 5-platform set', () => {
    expect(parseSelectedPlatforms(null)).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms(undefined)).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('')).toEqual(new Set(PLATFORM_IDS));
  });

  it('written ["windows","ios"] + reload → restored exactly', () => {
    const written = JSON.stringify(['windows', 'ios']);
    const reloaded = parseSelectedPlatforms(written);
    expect(reloaded).toEqual(new Set(['windows', 'ios']));
    // 验证经过回写序列化结构的持久化往返
    expect(parseSelectedPlatforms(JSON.stringify([...reloaded]))).toEqual(reloaded);
  });

  it('stored [] (valid empty array) restores [] — no full-set fallback', () => {
    expect(parseSelectedPlatforms(JSON.stringify([]))).toEqual(new Set<string>([]));
    // 持久化往返：持久化空选择后重新加载仍为空
    expect(parseSelectedPlatforms(JSON.stringify([...parseSelectedPlatforms('[]')]))).toEqual(
      new Set<string>([])
    );
  });

  it('corrupt "{bad" → full-set fallback (retained)', () => {
    expect(parseSelectedPlatforms('{bad')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('not-json-at-all{{{')).toEqual(new Set(PLATFORM_IDS));
    expect(parseSelectedPlatforms('"just-a-string"')).toEqual(new Set(PLATFORM_IDS));
  });

  it('unknown ids are whitelisted; unknown-only/empty stays empty (valid array, not corrupt)', () => {
    expect(parseSelectedPlatforms(JSON.stringify(['windows', 'amigaos']))).toEqual(
      new Set(['windows'])
    );
    expect(parseSelectedPlatforms(JSON.stringify(['amigaos']))).toEqual(new Set<string>([]));
    expect(parseSelectedPlatforms(JSON.stringify(['WINDOWS', 'Ios']))).toEqual(
      new Set(['windows', 'ios'])
    );
  });

  it('throwing storage → still renders (loader never throws, yields full set)', () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g['window'];
    g['window'] = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
    };
    try {
      expect(() => loadSelectedPlatforms()).not.toThrow();
      expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
    } finally {
      if (prevWindow === undefined) delete g['window'];
      else g['window'] = prevWindow;
    }
  });

  it('loadSelectedPlatforms honors a stored empty array (no full-set fallback on reload)', () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    expect(loadSelectedPlatforms()).toEqual(new Set<string>([]));
  });

  it('loadSelectedPlatforms restores a stored subset exactly', () => {
    window.localStorage.setItem(
      PLATFORM_FILTER_STORAGE_KEY,
      JSON.stringify(['windows', 'ios'])
    );
    expect(loadSelectedPlatforms()).toEqual(new Set(['windows', 'ios']));
  });

  it('loadSelectedPlatforms yields the full set when nothing is stored', () => {
    expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
  });

  it('v2 key absent while a foreign key exists → full set (only v2 is read)', () => {
    window.localStorage.setItem('zstore:platform-filter:v1', JSON.stringify(['windows', 'ios']));
    expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
  });

  it('v2 key present → read as-is, ignoring any foreign key', () => {
    window.localStorage.setItem('zstore:platform-filter:v1', JSON.stringify(['windows']));
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['ios']));
    expect(loadSelectedPlatforms()).toEqual(new Set(['ios']));
  });

  it('v2 corrupt payload falls back to full set', () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, '{bad');
    expect(loadSelectedPlatforms()).toEqual(new Set(PLATFORM_IDS));
  });

  it('filtering derivation: empty selection keeps nothing, full keeps all, partial keeps its subset', () => {
    const full = new Set<string>(PLATFORM_IDS);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, full))).toHaveLength(FIXTURE.length);
    const empty = parsePersistedSelection([]);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, empty))).toEqual([]);
    const iosOnly = parsePersistedSelection(['ios']);
    expect(FIXTURE.filter((a) => matchPlatformSet(a, iosOnly))).toEqual([
      { platforms: ['ios'] },
    ]);
  });

  it('per-platform counts derive from the FULL app list via matchPlatformSet singletons', () => {
    const counts: Record<string, number> = {};
    for (const id of PLATFORM_IDS) {
      counts[id] = FIXTURE.filter((a) => matchPlatformSet(a, new Set([id]))).length;
    }
    // windows 仅匹配显式声明项；缺失/为空的两项归入虚拟 other 桶
    expect(counts['windows']).toBe(1);
    expect(counts['ios']).toBe(1);
    expect(counts['android']).toBe(1);
    expect(counts['linux']).toBe(1);
    expect(counts['macos']).toBe(1);
    expect(counts['other']).toBe(2);
  });

  it('reset restores the full set incl. other (matches everything again)', () => {
    const reset = new Set<string>(PLATFORM_IDS);
    expect(reset.size).toBe(6);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, reset)).toBe(true);
    }
    // 重置后经存储往返恢复为全量集合
    expect(parseSelectedPlatforms(JSON.stringify([...reset]))).toEqual(reset);
  });
});

describe('global platform filter applies to Favorites/Installed/Updates', () => {
  interface CatalogApp {
    id: string;
    platforms?: string[];
  }
  interface InstalledRow {
    app_id: string;
  }
  interface UpdateRow {
    app_id: string;
  }

  const CATALOG: CatalogApp[] = [
    { id: 'owner/win-app', platforms: ['windows'] },
    { id: 'owner/ios-app', platforms: ['ios'] },
    { id: 'owner/lib', platforms: [] },
  ];
  const INSTALLED: InstalledRow[] = [
    { app_id: 'owner/win-app' },
    { app_id: 'owner/ios-app' },
    { app_id: 'owner/external-app' },
  ];
  const UPDATES: UpdateRow[] = [
    { app_id: 'owner/win-app' },
    { app_id: 'owner/ios-app' },
    { app_id: 'owner/external-app' },
  ];

  // 与 App.tsx 逻辑严格对齐：收藏页渲染 platformFilteredApps；
  // 「我的应用」的已装行与更新项通过 matchPlatformSet 将 ID 列表与全量收录库关联匹配，
  // 保持未收录条目依然可见。
  const iosOnly = new Set<string>(['ios']);
  const filterCatalog = (sel: ReadonlySet<string>) =>
    CATALOG.filter((a) => matchPlatformSet(a, sel));
  const filterInstalled = (sel: ReadonlySet<string>) =>
    INSTALLED.filter((inst) => {
      const c = CATALOG.find((a) => a.id.toLowerCase() === inst.app_id.toLowerCase());
      return !c || matchPlatformSet(c, sel);
    });
  const filterUpdates = (sel: ReadonlySet<string>) =>
    UPDATES.filter((u) => {
      const c = CATALOG.find((a) => a.id.toLowerCase() === u.app_id.toLowerCase());
      return !c || matchPlatformSet(c, sel);
    });
  const countOverFull = (id: string) =>
    CATALOG.filter((a) => matchPlatformSet(a, new Set([id]))).length;

  it('other bucket: libraries hide under OS-only selections, show under other/full', () => {
    const otherOnly = new Set<string>(['other']);
    expect(filterCatalog(iosOnly).map((a) => a.id)).toEqual(['owner/ios-app']);
    expect(filterCatalog(otherOnly).map((a) => a.id)).toEqual(['owner/lib']);
    expect(filterCatalog(new Set<string>(PLATFORM_IDS)).map((a) => a.id)).toEqual([
      'owner/win-app',
      'owner/ios-app',
      'owner/lib',
    ]);
    expect(countOverFull('other')).toBe(1);
  });

  it('installed: non-matching OS hidden, unknown-catalog rows kept', () => {
    expect(filterInstalled(iosOnly).map((r) => r.app_id)).toEqual([
      'owner/ios-app',
      'owner/external-app',
    ]);
  });

  it('updates: non-matching OS hidden, unknown-catalog rows kept', () => {
    expect(filterUpdates(iosOnly).map((r) => r.app_id)).toEqual([
      'owner/ios-app',
      'owner/external-app',
    ]);
  });

  it('platformCounts still derived from the FULL set (unchanged by the view filter)', () => {
    expect(countOverFull('windows')).toBe(1);
    expect(countOverFull('ios')).toBe(1);
    // 视图内的筛选绝不能缩减统计计数
    expect(filterCatalog(iosOnly)).toHaveLength(1);
    expect(countOverFull('windows')).toBe(1);
  });
});

// 真实 <App/> 跨视图一致性测试：数量与可见内容同源

function makeCatalogApp(id: string, name: string, platforms: string[], category: string): AppSummary {
  const [owner = 'o', repo = id] = id.split('/');
  return {
    id,
    name,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    description: `${name} desc`,
    stars: 100,
    forks: 1,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category,
    category_name: category,
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms,
  };
}

const APP_CATALOG: AppSummary[] = [
  makeCatalogApp('acme/win-tool', 'WinTool', ['windows'], 'dev'),
  makeCatalogApp('acme/droid-tool', 'DroidTool', ['android'], 'dev'),
  makeCatalogApp('acme/cross-kit', 'CrossKit', ['windows', 'android'], 'dev'),
  makeCatalogApp('acme/mac-player', 'MacPlayer', ['macos'], 'media'),
];

const FAVORITE_IDS = ['acme/win-tool', 'acme/droid-tool', 'acme/mac-player'];
const WATCHED_IDS = ['acme/cross-kit', 'acme/droid-tool'];
const INSTALLED_IDS = ['acme/win-tool', 'acme/cross-kit', 'acme/mac-player'];

function makePendingEntry(id: string, platforms: string[], status: string, archived = false) {
  return {
    id,
    item: {
      id,
      name: id,
      owner: 'draft',
      repo: id,
      icon: '',
      icon_bg: '',
      description: `${id} desc`,
      description_en: null,
      // 本地库条目同样并入目录与分类 feed；放到未参与断言的分类，避免干扰开发工具子页计数。
      category: 'office',
      category_name: 'office',
      aliases: [],
      default_version: 'v1.0.0',
      license: 'MIT',
      stars: 1,
      forks: 0,
      is_verified: false,
      homepage: null,
      install_dirs: [],
      search_subdirs: [],
      publishers: [],
      platforms,
      identifiers: {},
    },
    status,
    pr_url: status === 'submitted' ? 'https://github.com/o/r/pull/1' : null,
    created_at: 1,
    updated_at: 1,
    archived,
  };
}

const PENDING_ENTRIES = [
  makePendingEntry('draft-win', ['windows'], 'draft'),
  makePendingEntry('draft-droid', ['android'], 'draft'),
  makePendingEntry('ready-win', ['windows'], 'collected'),
  makePendingEntry('sent-mac', ['macos'], 'submitted'),
  makePendingEntry('old-win', ['windows'], 'draft', true),
];

/** 内存版分页 feed：与后端同口径（先按 allowedIds 过滤再分页，`matched_ids` 为过滤前全部 ID）。 */
function feedPage(rows: AppSummary[], allowedIds?: readonly string[]) {
  const allowed = allowedIds ? new Set(allowedIds.map((id) => id.toLowerCase())) : null;
  const items = allowed ? rows.filter((a) => allowed.has(a.id.toLowerCase())) : rows;
  return { items, total: items.length, has_more: false, matched_ids: rows.map((a) => a.id) };
}

vi.mock('./services/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/api/catalog')>();
  return {
    ...actual,
    getLatestCatalogApps: async (
      _win: unknown,
      _page?: number,
      _perPage?: number,
      allowedIds?: readonly string[],
    ) => feedPage(APP_CATALOG, allowedIds),
    getCategoryApps: async (
      category: string,
      _page?: number,
      _perPage?: number,
      allowedIds?: readonly string[],
    ) => feedPage(APP_CATALOG.filter((a) => a.category === category), allowedIds),
  };
});

vi.mock('./services/api', () => {
  const emptyLists = new Set([
    'getUpdateRules',
    'getRecentlyViewedApps',
    'checkForUpdates',
    'getCachedUpdates',
    'getSearchHistory',
    'getConfirmedIconsBatch',
    'getWatchNotifications',
    'getFavoriteEntries',
    'getCachedAppDetailsBatch',
  ]);
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSettings') return async () => ({ language: 'zh-CN' });
        if (prop === 'getOAuthUser' || prop === 'getCliDeepLink') return async () => null;
        if (prop === 'searchApps') {
          return async (q: string) => {
            const trimmed = q.trim().toLowerCase();
            if (!trimmed) return APP_CATALOG;
            return APP_CATALOG.filter((a) => a.id.toLowerCase().includes(trimmed));
          };
        }
        if (prop === 'getFavorites') return async () => [...FAVORITE_IDS];
        if (prop === 'getWatchedApps') {
          return async () => WATCHED_IDS.map((app_id) => ({ app_id, is_cataloged: true }));
        }
        if (prop === 'getInstalledApps') {
          return async () =>
            INSTALLED_IDS.map((app_id, i) => ({
              app_id,
              app_name: app_id.split('/')[1],
              version: 'v1.0.0',
              installed_at: 1000 + i,
              install_method: 'portable',
              install_path: `C:/apps/${app_id}`,
              asset_name: 'a.zip',
              asset_sha256: '',
            }));
        }
        if (prop === 'listCustomApps') return async () => PENDING_ENTRIES;
        if (prop === 'getLaunchpadFeed') {
          return async () => ({
            spotlight: [],
            items: [],
            discussions_repo: 'o/r',
            submit_issue_url: '',
            submit_web_url: '',
            is_stale: false,
          });
        }
        if (prop === 'getPlatformsLite') {
          return async (id: string) => ({ id, platforms: [], is_stale: false });
        }
        if (prop === 'recordSearchQuery') return async () => undefined;
        if (emptyLists.has(prop)) return async () => [];
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return {
    tauriApi,
    ONLINE_SEARCH_PER_PAGE: 20,
    DEFAULT_SETTINGS: {
      theme: 'dark',
      ui_scale: '100',
      font_size: '14',
      portable_dir: '',
      download_dir: '',
      active_mirror: '',
      launch_on_startup: false,
      update_frequency: 'manual',
      detail_cache_ttl_minutes: 30,
      catalog_source_url: '',
      watch_notify_frequency: 'daily',
    },
  };
});

const { App } = await import('./App');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function badgeText(el: Element | null | undefined): string | null {
  return el?.querySelector('.count-badge')?.textContent ?? null;
}

function navigate(viewId: string): void {
  const item = document.querySelector(`[data-view-id="${viewId}"]`) as HTMLElement | null;
  if (!item) throw new Error(`nav item ${viewId} missing`);
  fireEvent.click(item);
}

function viewRoot(viewClass: string): Element {
  const root = document.querySelector(`.${viewClass}`);
  if (!root) throw new Error(`.${viewClass} not rendered`);
  return root;
}

function cardNames(root: Element): string[] {
  return [...root.querySelectorAll('.app-grid .app-card .app-card-header')]
    .map((el) => el.textContent ?? '')
    .map((text) => APP_CATALOG.find((a) => text.includes(a.name))?.name ?? text)
    .sort();
}

/** 断言「最新」标题角标与可见卡片同源。 */
async function expectLatest(expected: string[]): Promise<void> {
  navigate('latest');
  await waitFor(() => {
    const root = viewRoot('latest-view');
    expect(badgeText(root.querySelector('.section-title'))).toBe(String(expected.length));
    expect(cardNames(root)).toEqual([...expected].sort());
  });
}

/** 进入「分类 / 开发工具」子页，断言标题角标与可见卡片同源。 */
async function expectDevCategory(expected: string[]): Promise<void> {
  navigate('categories');
  const devCard = await waitFor(() => {
    const card = [...document.querySelectorAll('.category-bento-card')].find((el) =>
      el.textContent?.includes('/dev'),
    );
    if (!card) throw new Error('dev category card missing');
    return card as HTMLElement;
  });
  fireEvent.click(devCard);
  await waitFor(() => {
    const root = viewRoot('categories-view');
    expect(badgeText(root.querySelector('.section-title'))).toBe(String(expected.length));
    expect(cardNames(root)).toEqual([...expected].sort());
  });
}

/** 收藏页两个签：签上角标 = 该签可见卡片数。 */
async function expectFavorites(local: string[], watched: string[]): Promise<void> {
  navigate('favorites');
  const tabs = () => [...viewRoot('favorites-view').querySelectorAll('.segmented-item')];
  await waitFor(() => {
    expect(badgeText(tabs()[0])).toBe(String(local.length));
    expect(cardNames(viewRoot('favorites-view'))).toEqual([...local].sort());
  });
  fireEvent.click(tabs()[1] as HTMLElement);
  await waitFor(() => {
    expect(badgeText(tabs()[1])).toBe(String(watched.length));
    expect(cardNames(viewRoot('favorites-view'))).toEqual([...watched].sort());
  });
}

/** 我的应用「全部」筛选签角标 = 可见行数。 */
async function expectInstalled(expectedCount: number): Promise<void> {
  navigate('installed');
  await waitFor(() => {
    const root = viewRoot('installed-view');
    const allTab = root.querySelector('.manage-filter-tab');
    expect(badgeText(allTab)).toBe(String(expectedCount));
    expect(root.querySelectorAll('.installed-list-row')).toHaveLength(expectedCount);
  });
}

describe('App cross-view counts match visible content', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('a residual top-bar search does not trim Latest / Categories / Favorites / Installed', async () => {
    render(<App />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'win-tool' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await screen.findByText('WinTool');

    await expectLatest(['WinTool', 'DroidTool', 'CrossKit', 'MacPlayer']);
    await expectDevCategory(['WinTool', 'DroidTool', 'CrossKit']);
    await expectFavorites(['WinTool', 'DroidTool', 'MacPlayer'], ['CrossKit', 'DroidTool']);
    await expectInstalled(3);
  });

  it('a single-platform sidebar selection keeps every view badge equal to its visible cards', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['windows']));
    render(<App />);

    await expectLatest(['WinTool', 'CrossKit']);
    await expectDevCategory(['WinTool', 'CrossKit']);

    navigate('pending');
    await waitFor(() => {
      expect(badgeText(screen.getByTestId('pending-tab-draft'))).toBe('1');
      expect(badgeText(screen.getByTestId('pending-tab-to_submit'))).toBe('1');
      expect(badgeText(screen.getByTestId('pending-tab-submitted'))).toBe('0');
      expect(badgeText(screen.getByTestId('pending-tab-archived'))).toBe('1');
      expect(document.querySelectorAll('.pending-list-item')).toHaveLength(1);
    });

    await expectInstalled(2);
    await expectFavorites(['WinTool'], ['CrossKit']);
  });

  it('an empty sidebar selection (0/6) shows the reset entry in every view', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    render(<App />);

    const expectReset = async (viewClass: string) => {
      await waitFor(() => {
        const root = viewRoot(viewClass);
        expect(root.querySelector('.filter-empty-reset')).not.toBeNull();
        expect(root.querySelectorAll('.app-grid .app-card')).toHaveLength(0);
      });
    };

    navigate('latest');
    await expectReset('latest-view');
    expect(badgeText(viewRoot('latest-view').querySelector('.section-title'))).toBe('0');

    navigate('categories');
    await expectReset('categories-view');
    expect(badgeText(viewRoot('categories-view').querySelector('.section-title'))).toBe('0');

    navigate('pending');
    await waitFor(() => {
      for (const id of ['draft', 'to_submit', 'submitted', 'archived']) {
        expect(badgeText(screen.getByTestId(`pending-tab-${id}`))).toBe('0');
      }
      expect(screen.getByTestId('pending-platform-reset')).toBeTruthy();
      expect(document.querySelectorAll('.pending-list-item')).toHaveLength(0);
    });

    navigate('installed');
    await expectReset('installed-view');

    navigate('favorites');
    await expectReset('favorites-view');
    const tabs = [...viewRoot('favorites-view').querySelectorAll('.segmented-item')];
    expect(badgeText(tabs[0])).toBe('0');
    expect(badgeText(tabs[1])).toBe('0');
    fireEvent.click(tabs[1] as HTMLElement);
    await expectReset('favorites-view');
  });

  it('switching to view-scoped pages never flashes full-catalog platform counts', async () => {
    render(<App />);

    // Wait for home catalog + local apps to settle (windows: win-tool, cross-kit, ready-win = 3)
    const winChip = () => document.querySelector('[data-platform-id="windows"]')!;
    const winCount = () => winChip().querySelector('.platform-chip-count')?.textContent ?? null;
    await waitFor(() => {
      expect(winCount()).toBe('3');
    });

    // Navigate to installed first (windows: win-tool, cross-kit = 2)
    navigate('installed');
    await waitFor(() => expect(winCount()).toBe('2'));

    // Observe every DOM mutation across view switches: must NEVER jump back to full-catalog '3'
    const seenCounts: Array<string | null> = [];
    const observer = new MutationObserver(() => {
      seenCounts.push(winCount());
    });
    observer.observe(winChip(), { childList: true, subtree: true, characterData: true });

    navigate('pending');
    await waitFor(() => expect(winCount()).toBe('1'));

    navigate('favorites');
    await waitFor(() => expect(winCount()).toBe('1'));

    navigate('launchpad');
    await waitFor(() => expect(winCount()).toBe('0'));

    observer.disconnect();
    expect(seenCounts).not.toContain('3');
    expect(seenCounts).not.toContain(null);
  });

  it('search view renders FilterEmptyState with reset when platforms are empty or filter out raw search hits (F-29)', async () => {
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([]));
    render(<App />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'win-tool' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // 平台全不选时：呈现带重置入口的 FilterEmptyState，而不是困在「未找到本地结果」
    const resetBtn = await waitFor(() => {
      const btn = document.querySelector('.search-empty-state .filter-empty-reset') as HTMLButtonElement | null;
      if (!btn) throw new Error('filter-empty-reset missing in search empty state');
      return btn;
    });
    fireEvent.click(resetBtn);
    await screen.findByText('WinTool');

    // 仅选 macos 时搜索 windows 专属应用：原始搜索有结果但被平台筛空，同样呈现 FilterEmptyState 重置入口
    cleanup();
    window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify(['macos']));
    render(<App />);
    const input2 = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: 'win-tool' } });
    fireEvent.keyDown(input2, { key: 'Enter', code: 'Enter' });

    const resetBtn2 = await waitFor(() => {
      const btn = document.querySelector('.search-empty-state .filter-empty-reset') as HTMLButtonElement | null;
      if (!btn) throw new Error('filter-empty-reset missing when raw hits filtered out');
      return btn;
    });
    fireEvent.click(resetBtn2);
    await screen.findByText('WinTool');
  });
});
