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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { CategoriesView } from './CategoriesView';
import type { AppSummary } from '../types';
import { matchPlatformSet, parseSelectedPlatformArray } from '../lib/platformFilter';

afterEach(() => {
  cleanup();
});

function makeApp(id: string, category: string, platforms?: string[]): AppSummary {
  return {
    id,
    name: id,
    owner: 'owner',
    repo: id,
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${id} desc`,
    stars: 1,
    forks: 0,
    license: 'MIT',
    latest_version: '1.0.0',
    category,
    category_name: category,
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: platforms ?? [],
  };
}

// 交集测试数据：dev 覆盖 windows+ios，media 仅限 ios。
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

  it('clicking a category lists only that category, back button returns to hall', () => {
    const { container } = renderCategories([DEV_WIN, DEV_IOS, MEDIA_IOS]);
    openCategory(container, '开发工具');
    expect(screen.getByText('a-dev-win')).toBeTruthy();
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

  it('lists whatever the prop contains without second-pass platform filtering', () => {
    const { container } = renderCategories([DEV_IOS]);
    openCategory(container, '开发工具');
    expect(screen.getByText('a-dev-ios')).toBeTruthy();
  });

  it('empty category shows multi-select Join copy + .filter-empty-reset wired to onResetPlatformFilter', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
    // 多选连接文案：指明设备组合名称，绝不显示搜索为空提示。
    expect(screen.getByText(/设备组合/)).toBeTruthy();
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('reset restores the full device set and returns to the hall', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([DEV_WIN], { onResetPlatformFilter });
    openCategory(container, '图形设计');
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

  it('empty prop renders the filter-empty copy + reset wired to onResetPlatformFilter', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderCategories([], { onResetPlatformFilter });
    openCategory(container, '开发工具');
    expect(screen.getByText(/设备组合/)).toBeTruthy();
    const reset = container.querySelector('.filter-empty-reset');
    expect(reset).toBeTruthy();
    expect(reset?.tagName).toBe('BUTTON');
    fireEvent.click(reset as HTMLElement);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });
});
