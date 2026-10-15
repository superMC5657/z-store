/**
 * 类别页分页（mock `handleGetCategoryApps`，与 Rust `get_category_apps` 同形）：
 * - 默认第 1 页 20 条（与发现页/在线搜索对齐），`{ items, total, has_more }`；
 * - 第二页去重续接，尾页 `has_more=false`，越界页空；
 * - `per_page` 钳制 1-50，未知分类空页。
 */
import { describe, expect, it } from 'vitest';
import { summaries } from '../fixtures';
import { handleGetCategoryApps } from './catalog';

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

  it('per_page 钳制 1-50', () => {
    const { category, total } = biggestCategory();
    const clamped = handleGetCategoryApps({ category, per_page: 500 });
    expect(clamped.items.length).toBe(Math.min(50, total));
    const tiny = handleGetCategoryApps({ category, per_page: 0, page: 2 });
    expect(tiny.items.length).toBe(1);
  });
});
