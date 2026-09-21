/**
 * 任务 6 — TrendsView 在全局平台筛选生效后重新排名。
 *
 * 约定：`apps` 从 App.platformFilteredApps 传入时已预先经过过滤，
 * 因此组件只需对传入集合进行排序并在其内部重新计算 #1..N 名次
 * （绝不保留原始名次），并在过滤结果为空时渲染 `.trends-empty` 空状态
 * 而非空白页面。页面内部不再进行平台过滤。
 *
 * 共享测试数据（与 Home/Categories 一致）：
 *   rustdesk → windows | 仅iosApp → ios | 无platformsApp → undefined (=windows)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TrendsView } from './TrendsView';
import { matchPlatformSet, PLATFORM_IDS, parseSelectedPlatformArray } from '../lib/platformFilter';
import { AppSummary } from '../types';

afterEach(() => {
  cleanup();
});

function makeApp(overrides: Partial<AppSummary> & { id: string; name: string }): AppSummary {
  return {
    owner: 'owner',
    repo: overrides.id,
    icon: '',
    icon_bg: '#888888',
    description: `desc of ${overrides.name}`,
    stars: 1000,
    forks: 100,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...overrides,
  };
}

// 共享测试数据：设定区分度明显的周热度分数，锁定全选时的排序。
const FIXTURE: AppSummary[] = [
  makeApp({ id: 'rustdesk', name: 'RustDesk', platforms: ['windows'], stars: 90000, forks: 10000 }),
  makeApp({ id: 'ios-only-app', name: '仅iosApp', platforms: ['ios'], stars: 50000, forks: 5000 }),
  // platforms: undefined 视作仅限 windows（规则与原 CategoriesView 一致）。
  makeApp({ id: 'no-platform-app', name: '无platformsApp', stars: 10000, forks: 1000 }),
];

/** 与 App.tsx 对齐：TrendsView 接收到的 `apps` 属性已经是过滤后的数据。 */
function preFiltered(selected: string[]): AppSummary[] {
  return FIXTURE.filter((a) => matchPlatformSet(a, new Set(selected)));
}

function renderTrends(apps: AppSummary[], extra: Partial<React.ComponentProps<typeof TrendsView>> = {}) {
  return render(
    <TrendsView
      apps={apps}
      favoriteIds={new Set<string>()}
      installedIds={new Set<string>()}
      installingIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      {...extra}
    />,
  );
}

function cardNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.app-card')).map(
    (el) => el.textContent ?? '',
  );
}

describe('baseline: full-select Top3 matches current week-sort behavior', () => {
  it('full 5-platform selection keeps all 3 fixture apps', () => {
    expect(preFiltered([...PLATFORM_IDS]).length).toBe(3);
  });

  it('full-select renders Top3 in current week-rank order (rustdesk #1)', () => {
    const { container } = renderTrends(preFiltered([...PLATFORM_IDS]));
    const names = cardNames(container);
    expect(names.length).toBe(3);
    expect(names[0]).toContain('RustDesk');
    expect(names[1]).toContain('仅iosApp');
    expect(names[2]).toContain('无platformsApp');
    expect(names[0]).toContain('#1');
    expect(names[1]).toContain('#2');
    expect(names[2]).toContain('#3');
  });
});

describe('task6: rerank #1..N within the filtered set', () => {
  it('ios-only → #1 is 仅iosApp and total equals the filtered count', () => {
    const filtered = preFiltered(['ios']);
    expect(filtered.length).toBe(1);
    const { container } = renderTrends(filtered);
    const cards = container.querySelectorAll('.app-card');
    expect(cards.length).toBe(filtered.length);
    expect(cards[0].textContent).toContain('仅iosApp');
    // 在过滤集合内部重新排名：名次从 #1 重新开始计数（不保留旧名次）。
    expect(cards[0].textContent).toContain('#1');
    expect(container.querySelector('.trends-empty')).toBeNull();
  });

  it('empty filtered set renders .trends-empty (never a blank page)', () => {
    const { container } = renderTrends([]);
    expect(container.querySelectorAll('.app-card').length).toBe(0);
    const empty = container.querySelector('.trends-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent!.length).toBeGreaterThan(0);
  });

  it('task7: .trends-empty shares the 所选设备组合 terminology and offers a reset action', () => {
    const onResetPlatformFilter = vi.fn();
    const { container } = renderTrends([], { onResetPlatformFilter });
    const empty = container.querySelector('.trends-empty');
    expect(empty).not.toBeNull();
    // 与 Home/Categories 筛选为空状态保持一致的文案术语
    expect(empty!.textContent).toMatch(/所选设备组合/);
    // 绝不复用搜索 owner/repo 的引导文案
    expect(empty!.textContent).not.toContain('owner/repo');
    const btn = empty!.querySelector('.filter-empty-reset');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    fireEvent.click(btn as Element);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('task7: trends reset falls back to broadcast when the caller provides no callback', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    try {
      const { container } = renderTrends([]);
      fireEvent.click(container.querySelector('.trends-empty .filter-empty-reset') as Element);
      const events = dispatchSpy.mock.calls
        .map((args) => args[0])
        .filter((e): e is CustomEvent => e instanceof CustomEvent);
      expect(events.some((e) => e.type === 'zstore:reset-platform-filter')).toBe(true);
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('empty selection pre-filters everything out and renders .trends-empty with reset (no fallback-to-all)', () => {
    const sel = parseSelectedPlatformArray([]);
    expect(sel.size).toBe(0);
    const filtered = FIXTURE.filter((a) => matchPlatformSet(a, sel));
    expect(filtered).toEqual([]);
    const onResetPlatformFilter = vi.fn();
    const { container } = renderTrends(filtered, { onResetPlatformFilter });
    expect(container.querySelectorAll('.app-card').length).toBe(0);
    const empty = container.querySelector('.trends-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/所选设备组合/);
    expect(empty!.textContent).not.toContain('owner/repo');
    const btn = empty!.querySelector('.filter-empty-reset');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    fireEvent.click(btn as Element);
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);
  });

  it('unknown-only selection behaves like empty (never falls back to all)', () => {
    const sel = parseSelectedPlatformArray(['amigaos']);
    expect(sel.size).toBe(0);
    const { container } = renderTrends(FIXTURE.filter((a) => matchPlatformSet(a, sel)));
    expect(container.querySelectorAll('.app-card').length).toBe(0);
    expect(container.querySelector('.trends-empty')).not.toBeNull();
  });

  it('switches app name, category and description in TrendsView between Chinese and English', async () => {
    const { default: i18n } = await import('../i18n');
    const bilingualApp = makeApp({
      id: 'rustdesk',
      name: 'RustDesk',
      chinese_name: 'RustDesk 远程桌面',
      description: '开源远程桌面软件',
      description_en: 'Open source remote desktop software',
      category: 'system',
      category_name: '系统实用',
    });

    await i18n.changeLanguage('zh-CN');
    const { container, unmount } = renderTrends([bilingualApp]);
    expect(container.textContent).toContain('RustDesk 远程桌面');
    expect(container.textContent).toContain('开源远程桌面软件');
    expect(container.textContent).toContain('系统实用');
    unmount();

    await i18n.changeLanguage('en-US');
    const { container: enContainer } = renderTrends([bilingualApp]);
    expect(enContainer.textContent).toContain('RustDesk');
    expect(enContainer.textContent).toContain('Open source remote desktop software');
    expect(enContainer.textContent).toContain('System Utilities');
    await i18n.changeLanguage('zh-CN');
  });
});
