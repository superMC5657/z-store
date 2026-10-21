/**
 * 移入收录入口内收回归测试（用户定案：只进富卡内部、仅未收录生效）：
 * - AppCard 内部操作区渲染门控：无回调 / 已收录 / 显式 is_cataloged /
 *   source=custom / custom 已存在一律不渲染；
 * - 点击走 onMoveInApp 且不冒泡到卡片详情（stopPropagation）；
 * - Home 在线段：内部单入口（无卡外按钮）、点击存草稿 + 派发
 *   `zstore:custom-apps-changed`、`customIds` 命中即隐藏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { AppCard } from './AppCard';
import { HomeView } from '../views/HomeView';
import { TrendsView } from '../views/TrendsView';
import { tauriApi } from '../services/api';
import { clearTrendsCache } from '../services/trends/cache';
import { clearTrendEnrichCache } from '../services/trends/enrich';
import { makeApp } from '../views/test-utils/filterFixture';
import { makeEnrichedApp, trendingHtmlFixture } from '../views/test-utils/trendFixture';
import type { AppSummary } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function externalApp(overrides?: Partial<AppSummary>): AppSummary {
  return makeApp({
    id: 'o/a',
    name: 'Atlas',
    owner: 'o',
    repo: 'a',
    category: 'external',
    category_name: 'external',
    platforms: [],
    ...overrides,
  });
}

function renderCard(app: AppSummary, extra?: Partial<React.ComponentProps<typeof AppCard>>) {
  return render(
    <AppCard
      app={app}
      isInstalled={false}
      isManaged={false}
      platformLoading={false}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      {...extra}
    />,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage('zh-CN');
});

describe('AppCard 移入收录内部入口门控', () => {
  it('仅未收录 external 行渲染入口（Linear 单色 + inbox 图标）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onMoveInApp = vi.fn();
    const { container } = renderCard(externalApp(), { onMoveInApp });
    const btn = screen.getByTestId('move-in-o/a');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('移入收录');
    // inbox 图标：单色描边 svg（与安装按钮同排、同 footer 内）。
    expect(btn.querySelector('svg')).toBeTruthy();
    expect(btn.closest('.app-card-footer')).toBeTruthy();
    expect(container.querySelector('.app-card-footer')?.textContent).toContain('移入收录');
  });

  it('无回调时不渲染（其它页面零变化）', () => {
    renderCard(externalApp());
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('已收录行不渲染（分类口径）', () => {
    const onMoveInApp = vi.fn();
    renderCard(externalApp({ category: 'dev', category_name: '开发工具' }), { onMoveInApp });
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('显式 is_cataloged=true 不渲染（category 仍为 external）', () => {
    const onMoveInApp = vi.fn();
    renderCard({ ...externalApp(), is_cataloged: true }, { onMoveInApp });
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('source=custom 草稿行不渲染', () => {
    const onMoveInApp = vi.fn();
    renderCard({ ...externalApp(), source: 'custom' } as AppSummary, { onMoveInApp });
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('custom 已存在（selectMergedCatalogApps 命中）不渲染', () => {
    const onMoveInApp = vi.fn();
    renderCard(externalApp(), { onMoveInApp, isCustomExisting: true });
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('点击走回调且不冒泡到详情（stopPropagation）', () => {
    const onMoveInApp = vi.fn();
    const onOpenDetail = vi.fn();
    renderCard(externalApp(), { onMoveInApp, onOpenDetail });
    fireEvent.click(screen.getByTestId('move-in-o/a'));
    expect(onMoveInApp).toHaveBeenCalledTimes(1);
    expect(onMoveInApp.mock.calls[0]?.[0]).toMatchObject({ id: 'o/a' });
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('移入中禁用并显示进度文案', () => {
    renderCard(externalApp(), { onMoveInApp: () => {}, isMovingIn: true });
    const btn = screen.getByTestId('move-in-o/a');
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.textContent).toContain('移入中…');
  });

  it('中英文案切换', async () => {
    await i18n.changeLanguage('en-US');
    renderCard(externalApp(), { onMoveInApp: () => {} });
    expect(screen.getByTestId('move-in-o/a').textContent).toContain('Move to catalog');
  });
});

describe('HomeView 在线段内部入口接线', () => {
  beforeEach(() => {
    vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({ id: 'o/a' } as never);
  });

  function renderOnline(customIds?: ReadonlySet<string>) {
    return render(
      <HomeView
        apps={[makeApp({ id: 'local/a', name: 'LocalA' })]}
        installedIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onNavigateTrends={() => {}}
        searchQuery="atlas"
        isOnlineResults
        onlineApps={[externalApp()]}
        onlineSearchPerformed
        customIds={customIds}
      />,
    );
  }

  it('在线卡只有内部单入口（无卡外按钮），点击存草稿并派发变更事件', async () => {
    await i18n.changeLanguage('zh-CN');
    const seen: string[] = [];
    const onChanged = (e: Event) => {
      seen.push(String((e as CustomEvent<{ id?: string }>).detail?.id ?? ''));
    };
    window.addEventListener('zstore:custom-apps-changed', onChanged);
    try {
      const { container } = renderOnline();
      const entries = container.querySelectorAll('[data-testid="move-in-o/a"]');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.closest('.app-card-footer')).toBeTruthy();
      fireEvent.click(entries[0] as HTMLElement);
      await waitFor(() => expect(tauriApi.saveCustomApp).toHaveBeenCalledTimes(1));
      const draft = (tauriApi.saveCustomApp as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as { id: string };
      expect(draft.id).toBe('o/a');
      await waitFor(() => expect(seen).toEqual(['o/a']));
    } finally {
      window.removeEventListener('zstore:custom-apps-changed', onChanged);
    }
  });

  it('customIds 命中即隐藏入口', () => {
    renderOnline(new Set(['o/a']));
    expect(screen.queryByTestId('move-in-o/a')).toBeNull();
  });

  it('dev 猜分类在线经显式标注仍显示入口（后端无 is_cataloged）', () => {
    render(
      <HomeView
        apps={[makeApp({ id: 'local/a', name: 'LocalA' })]}
        installedIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onNavigateTrends={() => {}}
        searchQuery="atlas"
        isOnlineResults
        onlineApps={[
          makeApp({
            id: 'o/dev-guess',
            name: 'Guess',
            owner: 'o',
            repo: 'dev-guess',
            category: 'dev',
            category_name: '开发工具',
            platforms: [],
          }),
        ]}
        onlineSearchPerformed
      />,
    );
    expect(screen.getByTestId('move-in-o/dev-guess').textContent).toContain('移入收录');
  });

  it('在线已收录 dev 行隐藏入口（命中 catalog 即 true）', () => {
    render(
      <HomeView
        apps={[makeApp({ id: 'o/kept', name: 'Kept' })]}
        installedIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onNavigateTrends={() => {}}
        searchQuery="kept"
        isOnlineResults
        onlineApps={[
          makeApp({
            id: 'O/KEPT',
            name: 'Kept',
            owner: 'O',
            repo: 'KEPT',
            category: 'dev',
            category_name: '开发工具',
            platforms: [],
          }),
        ]}
        onlineSearchPerformed
      />,
    );
    expect(screen.queryByTestId('move-in-O/KEPT')).toBeNull();
    expect(screen.queryByTestId('move-in-o/kept')).toBeNull();
  });
});

describe('TrendsView 未收录行入口位置', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    clearTrendsCache();
    clearTrendEnrichCache();
    window.localStorage.clear();
    vi.spyOn(tauriApi, 'getSettings').mockResolvedValue({});
    vi.spyOn(tauriApi, 'fetchTrendsText').mockImplementation(async (url: string) => {
      if (String(url).includes('github.com/trending')) return trendingHtmlFixture();
      throw new Error(`unexpected url: ${url}`);
    });
    vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({ id: 'acme/atlas' } as never);
  });

  function renderBoard(customIds?: ReadonlySet<string>) {
    return render(
      <TrendsView
        apps={[makeApp({ id: 'other/app', name: 'Other' })]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        managedIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onResetPlatformFilter={() => {}}
        customIds={customIds}
      />,
    );
  }

  it('裸行有同口径迷你入口（复用移入动作，stopPropagation）', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockResolvedValue([]);
    const { container } = renderBoard();
    // enrich 缺席即旧小行占位：行在，tags 区有迷你入口（裸行唯一呈现）。
    expect(await screen.findByText('acme/atlas')).toBeTruthy();
    const btn = screen.getByTestId('trend-move-in-acme/atlas');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('移入收录');
    expect(btn.closest('.app-card-footer')).toBeTruthy();
    // 富卡内部入口此时无（enrich 缺席），裸行迷你入口是唯一按钮。
    expect(screen.queryByTestId('move-in-acme/atlas')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="move-in-"]')).toHaveLength(0);
    // 三行裸行各一迷你入口（atlas/beacon/comet）。
    expect(container.querySelectorAll('[data-testid^="trend-move-in-"]')).toHaveLength(3);
    fireEvent.click(btn);
    await waitFor(() => expect(tauriApi.saveCustomApp).toHaveBeenCalledTimes(1));
    const draft = (tauriApi.saveCustomApp as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as { id: string };
    expect(draft.id).toBe('acme/atlas');
  });

  it('裸行 customIds 命中即隐藏迷你入口', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockResolvedValue([]);
    renderBoard(new Set(['acme/atlas']));
    expect(await screen.findByText('acme/atlas')).toBeTruthy();
    expect(screen.queryByTestId('trend-move-in-acme/atlas')).toBeNull();
  });

  it('富卡（enrich external 行）内部有入口，点击存草稿并派发事件', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) =>
        r.owner === 'acme' && r.repo === 'atlas'
          ? makeEnrichedApp({ id: 'acme/atlas', category: 'external', category_name: 'external', platforms: [] })
          : null,
      ),
    );
    const seen: string[] = [];
    const onChanged = (e: Event) => {
      seen.push(String((e as CustomEvent<{ id?: string }>).detail?.id ?? ''));
    };
    window.addEventListener('zstore:custom-apps-changed', onChanged);
    try {
      const { container } = renderBoard();
      const btn = await screen.findByTestId('move-in-acme/atlas');
      expect(btn.closest('.app-card-footer')).toBeTruthy();
      fireEvent.click(btn);
      await waitFor(() => expect(tauriApi.saveCustomApp).toHaveBeenCalledTimes(1));
      const draft = (tauriApi.saveCustomApp as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as { id: string };
      expect(draft.id).toBe('acme/atlas');
      await waitFor(() => expect(seen).toEqual(['acme/atlas']));
      void container;
    } finally {
      window.removeEventListener('zstore:custom-apps-changed', onChanged);
    }
  });

  it('customIds 命中即隐藏富卡内部入口', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) =>
        r.owner === 'acme' && r.repo === 'atlas'
          ? makeEnrichedApp({ id: 'acme/atlas', category: 'external', category_name: 'external', platforms: [] })
          : null,
      ),
    );
    renderBoard(new Set(['acme/atlas']));
    expect(await screen.findByText('acme/atlas')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('move-in-acme/atlas')).toBeNull());
    // 小行侧同样无残留按钮。
    expect(screen.queryByTestId('trend-move-in-acme/atlas')).toBeNull();
  });

  it('富卡 dev 猜分类经显式标注仍显示入口（后端无 is_cataloged）', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (repos) =>
      repos.map((r) =>
        r.owner === 'acme' && r.repo === 'atlas'
          ? makeEnrichedApp({ id: 'acme/atlas', category: 'dev', category_name: '开发工具', platforms: [] })
          : null,
      ),
    );
    renderBoard();
    // dev 猜分类 + 无显式标记时会被门控隐藏；标注 is_cataloged=false 即显示。
    const btn = await screen.findByTestId('move-in-acme/atlas');
    expect(btn.textContent).toContain('移入收录');
  });
});

describe('selectors 显式 is_cataloged 标注（canonical 小写）', () => {
  it('在线 dev 猜分类：未命中=false（显示），命中=true（隐藏）', async () => {
    const { annotateOnlineCataloged, buildCatalogIdSet } = await import('../app/selectors');
    const catalog = [makeApp({ id: 'o/kept', name: 'Kept' })];
    const ids = buildCatalogIdSet(catalog);
    // 大小写归一：O/KEPT 命中。
    expect(ids.has('o/kept')).toBe(true);
    const rows = [
      makeApp({ id: 'o/a', name: 'A', category: 'dev', category_name: '开发工具' }),
      makeApp({ id: 'O/KEPT', name: 'Kept', category: 'dev', category_name: '开发工具' }),
    ];
    const out = annotateOnlineCataloged(rows, ids);
    expect(out[0]?.is_cataloged).toBe(false);
    expect(out[1]?.is_cataloged).toBe(true);
    // 原数组不改写。
    expect(rows[0]?.is_cataloged).toBeUndefined();
  });

  it('在线收录标注不碰已认证：命中仅标is_cataloged，不回填is_verified', async () => {
    const { annotateIsCataloged, annotateOnlineCataloged, buildCatalogIdSet } = await import(
      '../app/selectors'
    );
    const ids = buildCatalogIdSet([makeApp({ id: 'o/kept', name: 'Kept' })]);
    const hit = makeApp({ id: 'O/KEPT', name: 'Kept', is_verified: false });
    const miss = makeApp({ id: 'o/other', name: 'Other', is_verified: false });
    const custom = {
      ...makeApp({ id: 'o/kept', name: 'Kept', is_verified: false }),
      source: 'custom',
    } as AppSummary;
    const out = annotateOnlineCataloged([hit, miss, custom], ids);
    expect(out[0]?.is_cataloged).toBe(true);
    expect(out[0]?.is_verified).toBe(false);
    expect(out[1]?.is_cataloged).toBe(false);
    expect(out[1]?.is_verified).toBe(false);
    expect(out[2]?.is_cataloged).toBe(true);
    expect(out[2]?.is_verified).toBe(false);
    // 原行不改写。
    expect(hit.is_cataloged).toBeUndefined();
    expect(hit.is_verified).toBe(false);
    // memo 友好：已有正确值即原引用透传。
    const clean = makeApp({ id: 'o/kept', name: 'Kept', is_verified: true, is_cataloged: true });
    expect(annotateIsCataloged(clean, ids)).toBe(clean);
  });

  it('enrich 镜像标注：dev 行未命中=false', async () => {
    const { annotateEnrichMirrorCataloged, buildCatalogIdSet } = await import('../app/selectors');
    const ids = buildCatalogIdSet([makeApp({ id: 'other/app', name: 'Other' })]);
    const mirror = {
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', category: 'dev', category_name: '开发工具', platforms: [] }),
    };
    const out = annotateEnrichMirrorCataloged(mirror, ids);
    expect(out['acme/atlas']?.is_cataloged).toBe(false);
  });

  it('在线已收录 dev 行经 AppCard 门控隐藏（回归根因）', async () => {
    await i18n.changeLanguage('zh-CN');
    const catalogedDev = {
      ...externalApp(),
      id: 'o/kept',
      category: 'dev',
      category_name: '开发工具',
      is_cataloged: true,
    };
    const onMoveInApp = vi.fn();
    renderCard(catalogedDev, { onMoveInApp });
    expect(screen.queryByTestId('move-in-o/kept')).toBeNull();
  });
});
