/**
 * 收藏占位行图标热替口径测试（`favoriteIds ∖ apps` 合成行与搜索/最近同一套规则）。
 *
 * - `pickFavoritePersistIconUrl`：remote 优先 / url 非 data: 兜底 / data: 永不进盘 /
 *   avatar 与非远端置空走首字母（`AppIcon` 同规则）。
 * - `needsFavoriteIconWarm`：空/avatar/非远端需查轮换，合法远端仅文件预热。
 */
import { describe, expect, it } from 'vitest';
import {
  needsFavoriteIconWarm,
  pickFavoritePersistIconUrl,
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

  it('avatar 按 AppIcon 同规则置空（remote/avatar 均过滤）', () => {
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://avatars.githubusercontent.com/u/123?v=4',
        level: 2,
        remote_url: 'https://avatars.githubusercontent.com/u/123?v=4',
      }),
    ).toBe('');
    expect(
      pickFavoritePersistIconUrl({
        url: 'https://avatars.githubusercontent.com/u/123?v=4',
        level: 2,
      }),
    ).toBe('');
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

  it('avatar/非远端需查轮换', () => {
    expect(needsFavoriteIconWarm('https://avatars.githubusercontent.com/u/1?v=4')).toBe(true);
    expect(needsFavoriteIconWarm('not-a-url')).toBe(true);
  });

  it('合法远端仅文件预热（不需查轮换）', () => {
    expect(needsFavoriteIconWarm('https://cdn.simpleicons.org/foo')).toBe(false);
    expect(needsFavoriteIconWarm('https://cdn.example.com/a.svg')).toBe(false);
  });
});
