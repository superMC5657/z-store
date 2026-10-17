/**
 * 收藏占位行图标热替口径测试（`favoriteIds ∖ apps` 合成行与搜索/最近同一套规则）。
 *
 * - `pickFavoritePersistIconUrl`：remote 优先 / url 非 data: 兜底 / data: 永不进盘 /
 *   非远端置空走首字母（`AppIcon` 同规则）。
 * - `needsFavoriteIconWarm`：空/非远端需查轮换，合法远端仅文件预热。
 */
import { describe, expect, it } from 'vitest';
import type { AppSummary } from '../types';
import { PLATFORM_IDS } from '../lib/platformFilter';
import { normalizeId, normalizeIdLowerSet } from '../services/normalizeId';
import {
  buildRecordCatalogedMap,
  favoriteSummaryFromCached,
  favoriteSummaryFromDetail,
  isFavoritePlaceholderRow,
  makeFavoritePlaceholderSummary,
  markFavoriteRowByRecord,
  markFavoriteUncatalogedRow,
  needsFavoriteIconWarm,
  parseFavoriteOwnerRepo,
  pickFavoritePersistIconUrl,
} from './favoritesUncataloged';
import { selectFavoritesViewApps } from './selectors';

describe('pickFavoritePersistIconUrl', () => {
  it('remote_url 优先于 url', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://cdn.example.com/a.png',
        level: 2,
        remote_url: 'https://cdn.example.com/b.svg',
      }),
    ).toBe('https://cdn.example.com/b.svg');
  });

  it('remote 为空时 url（非 data:）兜底', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://cdn.simpleicons.org/foo',
        level: 2,
        remote_url: '',
      }),
    ).toBe('https://cdn.simpleicons.org/foo');
  });

  it('url 为 data: 即时态时永不进盘（remote 为空即置空）', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'data:image/png;base64,AAA',
        level: 2,
        remote_url: '',
      }),
    ).toBe('');
  });

  it('https 远端落盘展示', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://avatars.githubusercontent.com/u/123?v=4',
        level: 2,
        remote_url: 'https://avatars.githubusercontent.com/u/123?v=4',
      }),
    ).toBe('https://avatars.githubusercontent.com/u/123?v=4');
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://avatars.githubusercontent.com/u/123?v=4',
        level: 2,
      }),
    ).toBe('https://avatars.githubusercontent.com/u/123?v=4');
  });

  it('非远端（纯标识/相对路径）置空走首字母', () => {
    expect(pickFavoritePersistIconUrl({ url: 'not-a-url', level: 5 })).toBe('');
    expect(pickFavoritePersistIconUrl({ url: '', level: 5, remote_url: '' })).toBe('');
  });

  it('null/undefined 输入置空', () => {
    expect(pickFavoritePersistIconUrl(null)).toBe('');
    expect(pickFavoritePersistIconUrl(undefined)).toBe('');
  });

  it('remote_url 单轨：无 remote_url 时 url 非 data: 兜底', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://cdn.example.com/tree.png',
        level: 3,
      }),
    ).toBe('https://cdn.example.com/tree.png');
  });
});

describe('needsFavoriteIconWarm', () => {
  it('空图标需查轮换', () => {
    expect(needsFavoriteIconWarm('')).toBe(true);
    expect(needsFavoriteIconWarm('   ')).toBe(true);
    expect(needsFavoriteIconWarm(undefined)).toBe(true);
    expect(needsFavoriteIconWarm(null)).toBe(true);
  });

  it('远端仅文件预热，非远端需查轮换', () => {
    expect(needsFavoriteIconWarm('https://avatars.githubusercontent.com/u/1?v=4')).toBe(false);
    expect(needsFavoriteIconWarm('not-a-url')).toBe(true);
  });

  it('合法远端仅文件预热（不需查轮换）', () => {
    expect(needsFavoriteIconWarm('https://cdn.simpleicons.org/foo')).toBe(false);
    expect(needsFavoriteIconWarm('https://cdn.example.com/a.svg')).toBe(false);
  });
});

/**
 * 未收录 join 语义锁定：行不消失（exact 合并去重 + heuristic 占位合成）与计数保留
 * （调用方全集计数，本模块不参与计数）。
 */
function row(id: string, platforms: string[] = []): AppSummary {
  return { id, platforms } as AppSummary;
}

/** join 内部 `findMissingIds` 同语义（`normalizeId` 去重保序）。 */
function missingViaUnifiedMouth(
  favoriteIds: Iterable<string>,
  catalogLower: ReadonlySet<string>,
  extraLower?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of favoriteIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) continue;
    const key = normalizeId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (catalogLower.has(key)) continue;
    if (extraLower?.has(key)) continue;
    missing.push(id);
  }
  return missing;
}

describe('uncataloged join keeps rows and full-set counts', () => {
  it('union∖catalog 精确差集经统一口，大小写归一、保序、保留原值', () => {
    const missing = missingViaUnifiedMouth(
      ['RustDesk/RustDesk', 'unknown/app', 'UNKNOWN/APP', '  ', 'videolan/vlc'],
      new Set(['rustdesk/rustdesk', 'videolan/vlc']),
    );
    expect(missing).toEqual(['unknown/app']);
  });

  it('已有占位行不再重复合成（统一口）', () => {
    const missing = missingViaUnifiedMouth(
      ['unknown/app'],
      new Set<string>(),
      new Set(['unknown/app']),
    );
    expect(missing).toEqual([]);
  });

  it('selectFavoritesViewApps: 占位段并入且与收录段去重（行不消失）', () => {
    const base = [row('owner/app-a', ['windows'])];
    const extras = [row('owner/app-x'), row('owner/app-a', ['windows'])];
    const merged = selectFavoritesViewApps(
      base,
      extras,
      new Set(PLATFORM_IDS),
      new Set<string>(),
    );
    expect(merged.map((a: AppSummary) => a.id).sort()).toEqual(['owner/app-a', 'owner/app-x']);
  });

  it('selectFavoritesViewApps: 无占位段时原数组透传', () => {
    const base = [row('owner/app-a', ['windows'])];
    expect(selectFavoritesViewApps(base, [], new Set(PLATFORM_IDS), new Set<string>())).toBe(base);
  });

  it('占位合成行恒为 external + platforms []（loading 恒可见，不参与计数）', () => {
    const placeholder = makeFavoritePlaceholderSummary('Unknown/App');
    expect(placeholder.owner).toBe('Unknown');
    expect(placeholder.repo).toBe('App');
    expect(placeholder.category).toBe('external');
    expect(placeholder.platforms).toEqual([]);
    expect(placeholder.is_cataloged).toBe(false);
  });

  it('详情派生行保留实分类、空分类兜底 external', () => {
    const detail = {
      id: 'o/r',
      name: 'r',
      owner: 'o',
      repo: 'r',
      icon: '',
      icon_bg: '',
      description: '',
      stars: 0,
      forks: 0,
      license: '',
      latest_version: 'v1',
      changelog: '',
      is_verified: false,
      readme_markdown: '',
      releases: [],
      category: 'system',
      category_name: '开发工具',
    };
    const kept = favoriteSummaryFromDetail(detail as never);
    expect(kept.category).toBe('system');
    const fallback = favoriteSummaryFromDetail({ ...detail, category: '', category_name: '' } as never);
    expect(fallback.category).toBe('external');
    expect(fallback.is_cataloged).toBe(false);
  });

  it('normalizeIdLowerSet 与 join 键口径一致（去空/小写/去重）', () => {
    expect([...normalizeIdLowerSet(['A/B', 'a/b', '', '  ', null])]).toEqual(['a/b']);
  });

  it('parseFavoriteOwnerRepo 启发式推导展示用 owner/repo', () => {
    expect(parseFavoriteOwnerRepo('https://github.com/RustDesk/RustDesk')).toEqual({
      owner: 'RustDesk',
      repo: 'RustDesk',
    });
    expect(parseFavoriteOwnerRepo('gh:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });
});

describe('favoriteSummaryFromCached (batch cache join marking)', () => {
  it('Some 命中保留富卡字段并补 is_cataloged=false', () => {
    const hit = {
      id: 'o/rich',
      name: 'Rich',
      description: 'rich desc',
      stars: 42,
      category: 'dev',
      category_name: '开发工具',
    } as AppSummary;
    const row = favoriteSummaryFromCached(hit);
    expect(row.name).toBe('Rich');
    expect(row.description).toBe('rich desc');
    expect(row.stars).toBe(42);
    expect(row.category).toBe('dev');
    expect(row.is_cataloged).toBe(false);
  });

  it('空分类兜底 external，实分类保留（与 favoriteSummaryFromDetail 同口径）', () => {
    const fallback = favoriteSummaryFromCached({ id: 'o/x', category: '', category_name: '' } as AppSummary);
    expect(fallback.category).toBe('external');
    expect(fallback.is_cataloged).toBe(false);
    const kept = markFavoriteUncatalogedRow({ id: 'o/y', category: 'system', category_name: '系统' } as AppSummary);
    expect(kept.category).toBe('system');
    expect(kept.is_cataloged).toBe(false);
  });

  it('记录已收录行保留真实分类 + 已收录标记（记录优先）', () => {
    const hit = {
      id: 'o/rich',
      name: 'Rich',
      category: 'dev',
      category_name: '开发工具',
    } as AppSummary;
    const row = favoriteSummaryFromCached(hit, true);
    expect(row.category).toBe('dev');
    expect(row.is_cataloged).toBe(true);
    expect(markFavoriteRowByRecord(hit, false).is_cataloged).toBe(false);
  });

  it('占位行同样按记录打标（缺席即未收录）', () => {
    expect(makeFavoritePlaceholderSummary('o/x', true).is_cataloged).toBe(true);
    expect(makeFavoritePlaceholderSummary('o/x').is_cataloged).toBe(false);
    expect(makeFavoritePlaceholderSummary('o/x', false).category).toBe('external');
  });
});

describe('buildRecordCatalogedMap (record wins, false wins)', () => {
  it('收藏 + 关注 union，任一显式 false 即未收录（优先于 stale 的 true）', () => {
    const map = buildRecordCatalogedMap(
      [{ app_id: 'o/a', is_cataloged: false, favorited_at: 1 }],
      [{ app_id: 'O/A', is_cataloged: true }, { app_id: 'o/b', is_cataloged: false }],
    );
    expect(map.get('o/a')).toBe(false);
    expect(map.get('o/b')).toBe(false);
  });

  it('双 true 才已收录；缺字段旧快照默认已收录，脏行/非数组直接忽略', () => {
    const both = buildRecordCatalogedMap(
      [{ app_id: 'o/c', is_cataloged: true, favorited_at: 2 }],
      [{ app_id: 'o/c', is_cataloged: true }],
    );
    expect(both.get('o/c')).toBe(true);
    const map = buildRecordCatalogedMap(
      [{ app_id: 'o/old' } as { app_id: string },
        { app_id: '  ' } as { app_id: string },
        null as unknown as { app_id: string }],
      undefined,
    );
    expect(map.get('o/old')).toBe(true);
    expect(map.size).toBe(1);
    expect(buildRecordCatalogedMap(undefined, null).size).toBe(0);
  });

  it('占位行判定：空壳即占位，富卡行（任一实质字段非空）即非占位', () => {
    expect(isFavoritePlaceholderRow(makeFavoritePlaceholderSummary('o/x'))).toBe(true);
    expect(
      isFavoritePlaceholderRow({ ...makeFavoritePlaceholderSummary('o/x'), description: 'desc' }),
    ).toBe(false);
    expect(
      isFavoritePlaceholderRow({ ...makeFavoritePlaceholderSummary('o/x'), stars: 10 }),
    ).toBe(false);
    expect(isFavoritePlaceholderRow(null as unknown as AppSummary)).toBe(false);
  });
});
