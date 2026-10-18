/**
 * 类别页分页（mock `handleGetCategoryApps`，与 Rust `get_category_apps` 同形）：
 * - 默认第 1 页 20 条（与发现页/在线搜索对齐），`{ items, total, has_more }`；
 * - 第二页去重续接，尾页 `has_more=false`，越界页空；
 * - `perPage` 钳制 1-50，未知分类空页。
 */
import { describe, expect, it } from 'vitest';
import { summaries } from '../fixtures';
import {
  handleGetAppDetails,
  handleGetCategoryApps,
  handleGetOrFetchIcon,
  handleGetPlatformsLite,
  handleSearchAppsOnline,
} from './catalog';
import { argStr } from './common';

function fullCount(category: string): number {
  return summaries.filter((s) => s.category.toLowerCase() === category).length;
}

// 选用条数最多的分类，保证跨页（catalog.json 动态算，不锁死具体数）。
function biggestCategory(): { category: string; total: number } {
  const counts = new Map<string, number>();
  for (const s of summaries) {
    const c = s.category.toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = { category: '', total: 0 };
  for (const [category, total] of counts) {
    if (total > best.total) best = { category, total };
  }
  return best;
}

describe('handleGetCategoryApps pagination', () => {
  it('首屏默认 20 条并带总量/has_more', () => {
    const { category, total } = biggestCategory();
    expect(total).toBeGreaterThan(20);
    const res = handleGetCategoryApps({ category });
    expect(res.items.length).toBe(20);
    expect(res.total).toBe(total);
    expect(res.has_more).toBe(true);
    expect(fullCount(category)).toBe(total);
  });

  it('第二页去重续接，无重叠无遗漏', () => {
    const { category, total } = biggestCategory();
    const p1 = handleGetCategoryApps({ category, page: 1 });
    const p2 = handleGetCategoryApps({ category, page: 2 });
    expect(p2.items.length).toBe(20);
    const ids1 = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !ids1.has(i.id))).toBe(true);
    const p3 = handleGetCategoryApps({ category, page: 3 });
    const seen = [...p1.items, ...p2.items, ...p3.items];
    expect(new Set(seen.map((i) => i.id)).size).toBe(seen.length);
    expect(seen.length).toBe(total);
    expect(p3.has_more).toBe(false);
  });

  it('越界页空且 has_more=false，未知分类空页', () => {
    const { category } = biggestCategory();
    const over = handleGetCategoryApps({ category, page: 99 });
    expect(over.items).toEqual([]);
    expect(over.has_more).toBe(false);
    const unknown = handleGetCategoryApps({ category: '__no_such_cat__' });
    expect(unknown).toEqual({ items: [], total: 0, has_more: false });
  });

  it('perPage 钳制 1-50', () => {
    const { category, total } = biggestCategory();
    const clamped = handleGetCategoryApps({ category, perPage: 500 });
    expect(clamped.items.length).toBe(Math.min(50, total));
    const tiny = handleGetCategoryApps({ category, perPage: 0, page: 2 });
    expect(tiny.items.length).toBe(1);
  });
});

describe('camel 直通（searchId/perPage/appId，snake 不再回退）', () => {
  it('searchId 回声 sid，snake 键被忽略', () => {
    const withCamel = handleSearchAppsOnline({ query: 'test', searchId: 'sid-1' });
    expect(withCamel.sid).toBe('sid-1');
    const withSnake = handleSearchAppsOnline({
      query: 'test',
      search_id: 'sid-1',
    } as unknown as Record<string, unknown>);
    expect(withSnake.sid).toBe('');
  });

  it('perPage 分页生效，snake 键被忽略回默认 20', () => {
    const { category } = biggestCategory();
    expect(handleGetCategoryApps({ category, perPage: 5 }).items.length).toBe(5);
    const withSnake = handleGetCategoryApps({
      category,
      per_page: 5,
    } as unknown as Record<string, unknown>);
    expect(withSnake.items.length).toBe(20);
  });

  it('remoteUrl/appId 直通', () => {
    const remote = 'https://example.com/x.png';
    expect(handleGetOrFetchIcon({ remoteUrl: remote })).toBe(remote);
    const hit = summaries[0];
    expect(handleGetOrFetchIcon({ appId: hit.id })).toBe(hit.icon);
  });
});

describe('camel 直通（custom 草稿 includeArchived/prUrl/remoteIds，snake 忽略回默认/空）', () => {
  it('includeArchived camel 读取、snake 忽略回默认 false', () => {
    const readIncludeArchived = (a: Record<string, unknown>) => a['includeArchived'] === true;
    expect(readIncludeArchived({ includeArchived: true })).toBe(true);
    expect(readIncludeArchived({ includeArchived: false })).toBe(false);
    expect(readIncludeArchived({ include_archived: true } as unknown as Record<string, unknown>)).toBe(
      false,
    );
    expect(readIncludeArchived({})).toBe(false);
  });

  it('prUrl camel 直通、snake 忽略回空', () => {
    expect(argStr({ prUrl: 'https://example.com/pr' }, 'prUrl')).toBe('https://example.com/pr');
    expect(
      argStr(
        { pr_url: 'https://example.com/pr' } as unknown as Record<string, unknown>,
        'prUrl',
      ),
    ).toBe('');
    expect(argStr({}, 'prUrl')).toBe('');
  });

  it('remoteIds camel 直通、snake 忽略回空', () => {
    const readRemoteIds = (a: Record<string, unknown>) =>
      Array.isArray(a['remoteIds']) ? (a['remoteIds'] as string[]) : [];
    expect(readRemoteIds({ remoteIds: ['a/b'] })).toEqual(['a/b']);
    expect(
      readRemoteIds({ remote_ids: ['a/b'] } as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(readRemoteIds({})).toEqual([]);
  });
});

describe('forceRefresh camel 生效、snake 忽略（详情/轻量）', () => {
  it('get_app_details camel forceRefresh 同详情、snake 被忽略同结果', () => {
    const hit = summaries[0];
    const camel = handleGetAppDetails({ id: hit.id, forceRefresh: true });
    const snake = handleGetAppDetails({
      id: hit.id,
      force_refresh: true,
    } as unknown as Record<string, unknown>);
    expect(camel.id).toBe(hit.id);
    expect(snake).toEqual(camel);
  });

  it('get_platforms_lite camel forceRefresh 同结果、snake 忽略', () => {
    const hit = summaries[0];
    const camel = handleGetPlatformsLite({ id: hit.id, forceRefresh: true });
    const snake = handleGetPlatformsLite({
      id: hit.id,
      force_refresh: true,
    } as unknown as Record<string, unknown>);
    expect(camel.id).toBe(hit.id);
    expect(snake).toEqual(camel);
  });
});
