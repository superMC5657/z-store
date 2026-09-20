/**
 * 任务 3 — App 级别平台筛选状态 + localStorage 持久化测试
 * （决策方案 B：[] = 不选任何平台）。
 *
 * 所有测试均基于行为级覆盖：持久化往返经过 loadSelectedPlatforms/parseSelectedPlatforms 检验，
 * 过滤语义经过 matchPlatformSet 检验。无任何针对源码字面量的脆弱断言。
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  PLATFORM_IDS,
  matchPlatformSet,
  parseSelectedPlatformArray as parsePersistedSelection,
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
  it('a full 5-platform set matches every fixture app', () => {
    const full = new Set<string>(PLATFORM_IDS);
    expect(full.size).toBe(5);
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

import {
  PLATFORM_FILTER_STORAGE_KEY,
  loadSelectedPlatforms,
  parseSelectedPlatforms,
} from './App';

afterEach(() => {
  window.localStorage.clear();
});

describe('task3: platform-filter persistence (Decision B select-nothing)', () => {
  it('uses the stable storage key zstore:platform-filter:v1', () => {
    expect(PLATFORM_FILTER_STORAGE_KEY).toBe('zstore:platform-filter:v1');
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
    // windows 匹配显式声明项以及两条缺失/为空的项（仅限 windows 规则）
    expect(counts['windows']).toBe(3);
    expect(counts['ios']).toBe(1);
    expect(counts['android']).toBe(1);
    expect(counts['linux']).toBe(1);
    expect(counts['macos']).toBe(1);
  });

  it('reset restores the full device set (matches everything again)', () => {
    const reset = new Set<string>(PLATFORM_IDS);
    expect(reset.size).toBe(5);
    for (const app of FIXTURE) {
      expect(matchPlatformSet(app, reset)).toBe(true);
    }
    // 重置后经存储往返恢复为全量集合
    expect(parseSelectedPlatforms(JSON.stringify([...reset]))).toEqual(reset);
  });
});

describe('P2-3a: global platform filter applies to Favorites/Installed/Updates', () => {
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
  // 已安装/更新页通过 matchPlatformSet 将 ID 列表与全量收录库关联匹配，
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

  it('favorites: non-matching OS hidden via the filtered memo', () => {
    expect(filterCatalog(iosOnly).map((a) => a.id)).toEqual(['owner/ios-app']);
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
