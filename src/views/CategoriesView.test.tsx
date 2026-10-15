/**
 * 任务 4 — CategoriesView 汇聚至全局设备平台过滤器测试。
 *
 * 第一部分（基线特征化测试）：锁定收敛改造后依然保留的单维度分类行为：
 *   大厅渲染分类卡片；点击卡片列出该分类下的应用；
 *   返回按钮返回大厅。
 *
 * 第二部分（新收敛规范测试）：验证收敛后的新契约：
 *   移除平台胶囊切换栏；大厅各分类计数仅来源于传入的预过滤 `apps` 属性；
 *   空状态使用多选连接文案 + 绑定了必选 `onResetPlatformFilter` 属性的
 *   `.filter-empty-reset` 按钮（通过 App 恢复全量设备集合并返回大厅）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CategoriesView } from './CategoriesView';
import type { AppSummary } from '../types';
import { matchPlatformSet, parseSelectedPlatformArray } from '../lib/platformFilter';
import { makeCategorizedApp as makeApp } from './test-utils/filterFixture';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { mockGetCategoryApps } = vi.hoisted(() => ({ mockGetCategoryApps: vi.fn() }));
vi.mock('../services/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api/catalog')>();
  return {
    ...actual,
    getCategoryApps: (...args: unknown[]) => mockGetCategoryApps(...args),
  };
});

let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
function stubIntersectionObserver() {
  ioCallback = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
function intersectSentinel() {
  act(() => {
    ioCallback?.([{ isIntersecting: true }]);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mockGetCategoryApps.mockReset();
  mockGetCategoryApps.mockResolvedValue({ items: [], total: 0, has_more: false });
});

// 交集测试数据：dev 覆盖 windows+ios，media 仅限 ios（makeApp 见 test-utils/filterFixture）。
const DEV_WIN = makeApp('a-dev-win', 'dev', ['windows']);
const DEV_IOS = makeApp('a-dev-ios', 'dev', ['ios']);
const MEDIA_IOS = makeApp('a-media-ios', 'media', ['ios']);

function renderCategories(
  apps: AppSummary[],
  extraProps?: Partial<React.ComponentProps<typeof CategoriesView>>,
) {
  return render(
    <CategoriesView
      apps={apps}
      installedIds={new Set<string>()}
      installingIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      watchedIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      onToggleWatch={() => {}}
      onResetPlatformFilter={() => {}}
      {...extraProps}
    />,
  );
}

/** 通过可见的分类名称点击大厅卡片。 */
function openCategory(container: HTMLElement, name: string) {
  const card = within(container as HTMLElement)
    .getAllByText(name)
    .map((el) => el.closest('.app-card'))
    .find((el): el is HTMLElement => el !== null);
  expect(card).toBeTruthy();
  fireEvent.click(card as HTMLElement);
}

describe('baseline: category one-dimension behavior (survives convergence)', () => {
  it('renders the category hall', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
    expect(within(container as HTMLElement).getByText('影音视听')).toBeTruthy();
  });

  it('clicking a category lists only that category, back button returns to hall', async () => {
    mockGetCategoryApps.mockResolvedValue({
      items: [DEV_WIN, DEV_IOS],
      total: 2,
      has_more: false,
    });
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    openCategory(container, '开发工具');
    expect(mockGetCategoryApps).toHaveBeenCalledWith('dev', 1, 20);
    await screen.findByText('a-dev-win');
    expect(screen.getByText('a-dev-ios')).toBeTruthy();
    expect(screen.queryByText('a-media-ios')).toBeNull();
    fireEvent.click(screen.getByText('返回分类大厅'));
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
  });
});

describe('CategoriesView: converged to global filter (no local platform state)', () => {
  it('renders no platform capsule bar', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    expect(within(container as HTMLElement).queryByText('支持设备:')).toBeNull();
    expect(screen.queryByText('全部设备')).toBeNull();
  });

  it('hall card counts come from the incoming pre-filtered prop only', () => {
    // 调用方在全局预过滤为 ios：dev=1 (DEV_IOS), media=1。
    const { container } = renderCategories([DEV_IOS, MEDIA_IOS]);
    const cards = Array.from(container.querySelectorAll('.app-card'));
    const devCard = cards.find((c) => c.textContent?.includes('开发工具'));
    const mediaCard = cards.find((c) => c.textContent?.includes('影音视听'));
    const graphicsCard = cards.find((c) => c.textContent?.includes('图形设计'));
    expect(devCard?.textContent).toContain('1 款可用');
    expect(mediaCard?.textContent).toContain('1 款可用');
    // 属性中缺失的分类展示无可用项（绝不自行二次过滤）。
    expect(graphicsCard?.textContent).toContain('暂无此端应用');
  });

  it('lists whatever the prop contains without second-pass platform filtering', async () => {
    mockGetCategoryApps.mockResolvedValue({ items: [DEV_IOS], total: 1, has_more: false });
    const { container } = renderCategories([DEV_IOS]);
    openCategory(container, '开发工具');
    await screen.findByText('a-dev-ios');
  });

  it('empty category shows multi-select Join copy + .filter-empty-reset wired to onResetPlatformFilter', async () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
    // 多选连接文案：指明设备组合名称，绝不显示搜索为空提示。
    await screen.findByText(/设备组合/);
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('reset restores the full device set and returns to the hall', async () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
    await screen.findByText(/设备组合/);
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
    // 重置同时会返回大厅（所有分类重新可见）。
    expect(within(container as HTMLElement).getByText('开发工具')).toBeTruthy();
  });
});

describe('CategoriesView: Decision B select-nothing (empty/unknown-only match nothing)', () => {
  it('empty selection pre-filters everything out (no fallback-to-all)', () => {
    const sel = parseSelectedPlatformArray([]);
    expect(sel.size).toBe(0);
    expect([DEV_WIN, DEV_IOS, MEDIA_IOS].filter((a) => matchPlatformSet(a, sel))).toEqual([]);
  });

  it('unknown-only selection behaves like empty (never falls back to all)', () => {
    const sel = parseSelectedPlatformArray(['amigaos']);
    expect(sel.size).toBe(0);
    expect([DEV_WIN, DEV_IOS, MEDIA_IOS].filter((a) => matchPlatformSet(a, sel))).toEqual([]);
  });

  it('empty prop renders the filter-empty copy + reset wired to onResetPlatformFilter', async () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([], { onResetPlatformFilter });
    openCategory(container, '开发工具');
    await screen.findByText(/设备组合/);
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });
});

describe('CategoriesView: paginated detail via get_category_apps', () => {
  function devRow(i: number): AppSummary {
    return makeApp(`c-dev-${i}`, 'dev', ['windows']);
  }

  it('首屏 20 条，触底续页去重追加，无重叠无遗漏', async () => {
    stubIntersectionObserver();
    const all = Array.from({ length: 25 }, (_, i) => devRow(i));
    mockGetCategoryApps.mockImplementation((category: unknown, page: unknown, perPage: unknown) => {
      expect(category).toBe('dev');
      expect(perPage).toBe(20);
      const start = ((page as number) - 1) * 20;
      const items = all.slice(start, start + 20);
      return Promise.resolve({
        items,
        total: all.length,
        has_more: start + items.length < all.length,
      });
    });
    const { container } = renderCategories(all);
    openCategory(container, '开发工具');
    await screen.findByText('c-dev-0');
    expect(screen.queryByText('c-dev-20')).toBeNull();
    expect(mockGetCategoryApps).toHaveBeenCalledWith('dev', 1, 20);
    await waitFor(() => expect(ioCallback).not.toBeNull());
    intersectSentinel();
    await screen.findByText('c-dev-24');
    expect(mockGetCategoryApps).toHaveBeenCalledWith('dev', 2, 20);
    // 25 行各一次，去重追加成立。
    for (let i = 0; i < 25; i += 1) {
      expect(screen.getAllByText(`c-dev-${i}`)).toHaveLength(1);
    }
  });

  it('失败页置 error，重试按钮重发当页', async () => {
    const rows = [DEV_WIN, DEV_IOS];
    mockGetCategoryApps.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderCategories(rows);
    openCategory(container, '开发工具');
    await screen.findByText(/分类列表加载失败/);
    const retry = screen.getByText('重试');
    expect(retry.tagName).toBe('BUTTON');
    mockGetCategoryApps.mockResolvedValue({ items: rows, total: 2, has_more: false });
    fireEvent.click(retry);
    await screen.findByText('a-dev-win');
    expect(screen.getByText('a-dev-ios')).toBeTruthy();
    expect(screen.queryByText('分类列表加载失败')).toBeNull();
  });

  it('只取 id 交集：接口多回的行不显示（平台过滤单次在 App 侧）', async () => {
    mockGetCategoryApps.mockResolvedValue({
      items: [DEV_IOS, DEV_WIN],
      total: 2,
      has_more: false,
    });
    const { container } = renderCategories([DEV_IOS]);
    openCategory(container, '开发工具');
    await screen.findByText('a-dev-ios');
    expect(screen.queryByText('a-dev-win')).toBeNull();
  });

  it('分类匹配以 BE 为准：category_name 命中亦显示，不做本地二次分类过滤', async () => {
    const alias = makeApp('alias-1', 'misc', ['windows']);
    alias.category_name = 'dev';
    mockGetCategoryApps.mockResolvedValue({ items: [alias], total: 1, has_more: false });
    const { container } = renderCategories([alias]);
    openCategory(container, '开发工具');
    await screen.findByText('alias-1');
  });
});
