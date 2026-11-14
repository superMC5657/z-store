/**
 * 演示站精选页负反馈（mock `handleDismissFeatured`，与 Rust `dismiss_featured` 同形）：
 * 「少推这类」带 `appId` 时，重拉页面后该分类与触发卡片都不再出现在页面上（其余分类足够填满 hero）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturedPage } from '../../types';
import { handleClearFeedFeedback, handleDismissFeatured, handleGetFeaturedPage } from './featured';

function allPicks(page: FeaturedPage) {
  return [...page.hero, ...page.shelves.flatMap((s) => s.items)];
}

function pageCategories(page: FeaturedPage): string[] {
  return [
    ...allPicks(page).map((p) => p.app.category),
    ...page.shelves.flatMap((s) => (s.category ? [s.category] : [])),
  ];
}

describe('handleDismissFeatured category scope', () => {
  afterEach(() => {
    handleClearFeedFeedback();
  });

  it('filters the category and the originating card on refetch', () => {
    const before = handleGetFeaturedPage({ daySeed: 3 });
    const pick = before.shelves.find((s) => s.kind === 'category_pick');
    expect(pick).toBeTruthy();
    const category = pick!.category!;
    const card = pick!.items[0].app.id;

    handleDismissFeatured({ target: category, scope: 'category', appId: card });
    const after = handleGetFeaturedPage({ daySeed: 3 });

    expect(pageCategories(after)).not.toContain(category);
    expect(allPicks(after).map((p) => p.app.id.toLowerCase())).not.toContain(card.toLowerCase());
    expect(handleClearFeedFeedback()).toBe(2);
  });
});
