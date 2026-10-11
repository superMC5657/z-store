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
import {
  buildLowerIdSet,
  favoriteSummaryFromDetail,
  findMissingFavoriteIds,
  makeFavoritePlaceholderSummary,
  needsFavoriteIconWarm,
  parseFavoriteOwnerRepo,
  pickFavoritePersistIconUrl,
  selectFavoritesViewApps,
} from './favoritesUncataloged';

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

  it('camelCase 兼容别名 remoteUrl 同样优先', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: '',
        level: 3,
        remoteUrl: 'https://cdn.example.com/tree.png',
      } as never),
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
 * 票 14 删除测试：`useFavoritesExtra` 文件删除后，未收录 join 语义经深 join
 * 新模块保持——行不消失（exact 合并去重 + heuristic 占位合成）与计数保留
 * （调用方全集计数，本模块不参与计数）。
 */
function row(id: string, platforms: string[] = []): AppSummary {
  return { id, platforms } as AppSummary;
}

describe('uncataloged join keeps rows and full-set counts (ticket 14 deletion tests)', () => {
  it('findMissingFavoriteIds: union∖catalog 精确差集，大小写归一、保序、保留原值', () => {
    const missing = findMissingFavoriteIds(
      ['RustDesk/RustDesk', 'unknown/app', 'UNKNOWN/APP', '  ', 'videolan/vlc'],
      new Set(['rustdesk/rustdesk', 'videolan/vlc']),
    );
    expect(missing).toEqual(['unknown/app']);
  });

  it('findMissingFavoriteIds: 已有占位行不再重复合成', () => {
    const missing = findMissingFavoriteIds(
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
    expect(merged.map((a) => a.id).sort()).toEqual(['owner/app-a', 'owner/app-x']);
  });

  it('selectFavoritesViewApps: 无占位段时原数组透传', () => {
    const base = [row('owner/app-a', ['windows'])];
    expect(selectFavoritesViewApps(base, [], new Set(PLATFORM_IDS), new Set<string>())).toBe(base);
  });

  it('占位合成行恒为 external + platforms []（pending 恒可见，不参与计数）', () => {
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

  it('buildLowerIdSet 与 join 键口径一致（去空/小写/去重）', () => {
    expect([...buildLowerIdSet(['A/B', 'a/b', '', '  ', null])]).toEqual(['a/b']);
  });

  it('parseFavoriteOwnerRepo 启发式推导展示用 owner/repo', () => {
    expect(parseFavoriteOwnerRepo('https://github.com/RustDesk/RustDesk')).toEqual({
      owner: 'RustDesk',
      repo: 'RustDesk',
    });
    expect(parseFavoriteOwnerRepo('gh:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });
});
