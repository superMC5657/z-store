/**
 * 任务 5 — HomeView 基于全局平台过滤后的数据派生测试。
 *
 * 契约规范：App.tsx 在相同的 `apps` 属性名下传入 `platformFilteredApps`，
 * 因此 HomeView 必须将传入的属性视为已完成平台预过滤：
 * 置顶/精选/收录分片均直接基于传入数组切分；当传入为空时，
 * HomeView 展示专属的筛选为空引导界面（绝非搜索 `owner/repo` 引导文案），
 * 并提供 `.filter-empty-reset` 按钮。HomeView.tsx 内不允许存在任何页面内平台过滤逻辑。
 *
 * 第一部分（基线特征化测试）：锁定当前派生行为——分片直接基于属性运行，
 * 当 rustdesk 不在集合中时置顶回退至 apps[0]。
 *
 * 第二部分（筛选为空新规范测试）：验证筛选为空状态与重置按钮行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { HomeView } from './HomeView';
import type { AppSummary } from '../types';
import { PLATFORM_IDS, matchPlatformSet, parseSelectedPlatformArray } from '../lib/platformFilter';
import { filterAppsByPlatform, makeApp } from './test-utils/filterFixture';

afterEach(() => {
  cleanup();
});

// 规范测试数据：rustdesk:windows, 仅iosApp:ios, 无platformsApp:undefined。
const RUSTDESK = makeApp({ id: 'rustdesk', name: 'RustDesk', platforms: ['windows'], stars: 90000 });
const IOS_APP = makeApp({ id: 'ios-only-app', name: '仅iosApp', platforms: ['ios'], stars: 5000 });
const NO_PLATFORMS_APP = makeApp({ id: 'no-platforms-app', name: '无platformsApp', stars: 3000 });
// platforms 刻意省略 (undefined) — 按过滤语义视作仅限 windows。

const BASE_FIXTURE: AppSummary[] = [RUSTDESK, IOS_APP, NO_PLATFORMS_APP];

// 扩展测试数据，确保全选时 置顶 + 精选(4) + 剩余(1) 全部非空。
const EXTENDED_FIXTURE: AppSummary[] = [
  RUSTDESK,
  IOS_APP,
  NO_PLATFORMS_APP,
  makeApp({ id: 'android-app', name: 'AndroidApp', platforms: ['android'], stars: 2000 }),
  makeApp({ id: 'linux-app', name: 'LinuxApp', platforms: ['linux'], stars: 1500 }),
  makeApp({ id: 'macos-app', name: 'MacApp', platforms: ['macos'], stars: 1200 }),
];

/** 与 App.tsx 派生逻辑完全对齐：应用按所选集合进行过滤（见 test-utils/filterFixture）。 */
function filterApps(apps: AppSummary[], selected: string[]): AppSummary[] {
  return filterAppsByPlatform(apps, selected);
}

function renderHomeView(
  apps: AppSummary[],
  extraProps?: Partial<React.ComponentProps<typeof HomeView>>,
) {
  return render(
    <HomeView
      apps={apps}
      installedIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      onNavigateTrends={() => {}}
      {...extraProps}
    />,
  );
}

describe('baseline: HomeView slices the incoming apps prop as-is', () => {
  it('prefers rustdesk as hero when present in the set', () => {
    const { container } = renderHomeView(BASE_FIXTURE);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('RustDesk');
  });

  it('hero falls back to the first app of the set when rustdesk is absent (never outside the set)', () => {
    // 仅选 ios 会排除 rustdesk (windows) 和 无platformsApp (兜底视作 windows-only)。
    const filtered = filterApps(BASE_FIXTURE, ['ios']);
    expect(filtered.map((a) => a.id)).toEqual(['ios-only-app']);
    const { container } = renderHomeView(filtered);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('仅iosApp');
    expect(heroTitle?.textContent).not.toContain('RustDesk');
  });

  it('fallback hero uses generic copy (name + category, no RustDesk-specific claims)', () => {
    // 仅选 ios 会排除 rustdesk：置顶为 仅iosApp，
    // 因此针对 RustDesk 的专属标题和标签绝不能泄露到该应用上。
    const filtered = filterApps(BASE_FIXTURE, ['ios']);
    expect(filtered.map((a) => a.id)).toEqual(['ios-only-app']);
    const { container } = renderHomeView(filtered);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('仅iosApp');
    expect(heroTitle?.textContent).toContain(filtered[0].category_name);
    expect(heroTitle?.textContent).not.toContain('开源远程桌面');
    const heroTags = container.querySelector('.hero-banner .hero-tags');
    expect(heroTags?.textContent).toContain('Stars');
    expect(heroTags?.textContent).toContain(filtered[0].license);
    expect(heroTags?.textContent).toContain(filtered[0].category_name);
    expect(heroTags?.textContent).not.toContain('自建中继');
    expect(heroTags?.textContent).not.toContain('端到端加密');
  });

  it('rustdesk hero keeps the RustDesk-specific title/tags', () => {
    const { container } = renderHomeView(BASE_FIXTURE);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain('RustDesk');
    expect(heroTitle?.textContent).toContain('开源远程桌面');
    const heroTags = container.querySelector('.hero-banner .hero-tags');
    expect(heroTags?.textContent).toContain('自建中继');
    expect(heroTags?.textContent).toContain('端到端加密');
  });

  it('featured/remaining slices execute on the prop as-is (hero excluded, order kept)', () => {
    const { container } = renderHomeView(BASE_FIXTURE);
    // 置顶应用 (rustdesk) 绝不能在下方的网格列表中重复出现。
    const gridText = Array.from(container.querySelectorAll('.app-grid'))
      .map((g) => g.textContent ?? '')
      .join('\n');
    expect(gridText).toContain('仅iosApp');
    expect(gridText).toContain('无platformsApp');
    expect(gridText).not.toContain('RustDesk');
  });

  it('does not render hero-verified-badge when heroApp.is_verified is false or missing', () => {
    const unverifiedApp = makeApp({ id: 'custom-app', name: 'CustomApp', is_verified: false });
    const { container } = renderHomeView([unverifiedApp]);
    expect(container.querySelector('.hero-verified-badge')).toBeNull();
  });

  it('renders hero-verified-badge when heroApp.is_verified is true', () => {
    const verifiedApp = makeApp({ id: 'verified-app', name: 'VerifiedApp', is_verified: true });
    const { container } = renderHomeView([verifiedApp]);
    const badge = container.querySelector('.hero-verified-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('官方认证 · Verified');
  });
});

describe('task5: filter-empty state with .filter-empty-reset', () => {
  it('ios-only selection → hero is the filtered first app, never rustdesk', () => {
    const filtered = filterApps(BASE_FIXTURE, ['ios']);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.some((a) => a.id === 'rustdesk')).toBe(false);
    const { container } = renderHomeView(filtered);
    const heroTitle = container.querySelector('.hero-banner .hero-title');
    expect(heroTitle?.textContent).toContain(filtered[0].name);
    expect(screen.queryByText(/RustDesk/)).toBeNull();
  });

  it('full-select → hero, featured and remaining sections are ALL non-empty', () => {
    const filtered = filterApps(EXTENDED_FIXTURE, [...PLATFORM_IDS]);
    expect(filtered).toHaveLength(EXTENDED_FIXTURE.length);
    const { container } = renderHomeView(filtered);
    // 置顶应用
    expect(container.querySelector('.hero-banner')).toBeTruthy();
    // 经典精选开源软件网格非空
    const grids = container.querySelectorAll('.app-grid');
    expect(grids.length).toBeGreaterThanOrEqual(2);
    grids.forEach((g) => {
      expect((g.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
    expect(container.textContent).toContain('经典精选开源软件');
    expect(container.textContent).toContain('全部精选开源收录');
  });

  it('empty prop → dedicated filter-empty state, NOT the search owner/repo copy', () => {
    const { container } = renderHomeView([]);
    // 针对全局设备平台筛选的专属重置入口
    expect(container.querySelector('.filter-empty-reset')).toBeTruthy();
    // 绝不能复用搜索为空状态的引导文案
    expect(container.textContent).not.toContain('owner/repo');
  });

  it('clicking .filter-empty-reset calls the reset handler', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderHomeView([], { onResetPlatformFilter });
    const btn = container.querySelector('.filter-empty-reset');
    expect(btn).toBeTruthy();
    fireEvent.click(btn as Element);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('reset button without a wired handler still broadcasts the platform reset intent', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    try {
      const { container } = renderHomeView([]);
      fireEvent.click(container.querySelector('.filter-empty-reset') as Element);
      const events = dispatchSpy.mock.calls
        .map((args) => args[0])
        .filter((e): e is CustomEvent => e instanceof CustomEvent);
      expect(events.some((e) => e.type === 'zstore:reset-platform-filter')).toBe(true);
    } finally {
      dispatchSpy.mockRestore();
    }
  });
});

describe('HomeView: Decision B select-nothing (empty/unknown-only match nothing)', () => {
  it('empty selection filters the whole fixture out (no fallback-to-all)', () => {
    const sel = parseSelectedPlatformArray([]);
    expect(sel.size).toBe(0);
    expect(EXTENDED_FIXTURE.filter((a) => matchPlatformSet(a, sel))).toEqual([]);
  });

  it('unknown-only selection behaves like empty (renders filter-empty, never the full list)', () => {
    const sel = parseSelectedPlatformArray(['amigaos']);
    expect(sel.size).toBe(0);
    const filtered = BASE_FIXTURE.filter((a) => matchPlatformSet(a, sel));
    expect(filtered).toEqual([]);
    const { container } = renderHomeView(filtered);
    expect(container.querySelector('.filter-empty-reset')).toBeTruthy();
    expect(container.textContent).not.toContain('owner/repo');
  });

  it('null persisted selection is empty too (not fallback-to-all)', () => {
    expect(parseSelectedPlatformArray(null).size).toBe(0);
  });
});

describe('U16b: recently-viewed platform filter (App derivation)', () => {
  // 与 App.tsx 派生逻辑严格对齐：最近浏览数据在进入 setRecentlyViewedApps 前
  // 先经过 matchPlatformSet 过滤，非匹配项绝不会流入 HomeView 的「最近浏览」区域（后端 history.rs 保持纯净）。
  function filterRecents(apps: AppSummary[], selected: string[]): AppSummary[] {
    return apps.filter((a) => matchPlatformSet(a, new Set(selected)));
  }

  it('non-matching recents are excluded by the derivation', () => {
    // 仅选 ios 会排除 rustdesk (windows) 和 无platformsApp (兜底视作 windows-only)。
    const visible = filterRecents(BASE_FIXTURE, ['ios']);
    expect(visible.map((a) => a.id)).toEqual(['ios-only-app']);
  });

  it('non-matching recents stay hidden in Home 最近浏览', () => {
    const visible = filterRecents(BASE_FIXTURE, ['ios']);
    const { container } = renderHomeView(filterApps(BASE_FIXTURE, ['ios']), {
      recentlyViewedApps: visible,
    });
    // 「最近浏览」区域渲染可见的最近浏览项…
    expect(container.textContent).toContain('最近浏览');
    expect(container.textContent).toContain('仅iosApp');
    // …而过滤掉的仅限 windows 的最近浏览项保持隐藏。
    expect(container.textContent).not.toContain('RustDesk');
    expect(container.textContent).not.toContain('无platformsApp');
  });

  it('hides 最近浏览 in search state when searchQuery is present', () => {
    const visible = filterRecents(BASE_FIXTURE, ['ios']);
    const { container } = renderHomeView(filterApps(BASE_FIXTURE, ['ios']), {
      recentlyViewedApps: visible,
      searchQuery: 'ios',
    });
    expect(container.textContent).not.toContain('最近浏览');
  });
});
