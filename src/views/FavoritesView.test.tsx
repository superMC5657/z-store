import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '../i18n';
import { FavoritesView } from './FavoritesView';
import { makeApp } from './test-utils/filterFixture';
import { makeFavoritePlaceholderSummary } from '../app/favoritesUncataloged';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('favorites & watched views do not display cataloged/uncataloged badges', () => {
  const baseLocal = {
    installedIds: new Set<string>(),
    installingIds: new Set<string>(),
    onOpenDetail: () => {},
    onQuickInstall: async () => {},
    onToggleFavorite: () => {},
    onToggleWatch: () => {},
  };
  const verifiedApp = makeApp({ id: 'owner/app-a', name: 'AppA', category: 'system', is_verified: true });
  const external = makeApp({ id: 'owner/app-x', name: 'AppX', category: 'external', is_verified: false });

  it('收藏列表不渲染已收录/未收录标签，收录/认证状态由应用名角标体现', () => {
    const { container } = render(
      <FavoritesView
        apps={[verifiedApp, external]}
        favoriteIds={new Set(['owner/app-a', 'owner/app-x'])}
        {...baseLocal}
      />,
    );
    expect(container.querySelector('.app-tag-cataloged')).toBeNull();
    expect(container.querySelector('.app-tag-uncataloged')).toBeNull();
    expect(container.textContent).not.toContain('已收录');
    expect(container.textContent).not.toContain('未收录');
    expect(container.querySelector('.verified-badge')).not.toBeNull();
  });

  it('关注列表同样不渲染已收录/未收录标签', () => {
    const { container } = render(
      <FavoritesView
        apps={[verifiedApp, external]}
        favoriteIds={new Set()}
        watchedIds={new Set(['owner/app-a', 'owner/app-x'])}
        {...baseLocal}
      />,
    );
    fireEvent.click(screen.getByText(/关注/));
    expect(container.querySelector('.app-tag-cataloged')).toBeNull();
    expect(container.querySelector('.app-tag-uncataloged')).toBeNull();
    expect(screen.queryByText('已收录')).toBeNull();
    expect(screen.queryByText('未收录')).toBeNull();
  });
});

describe('rows kept and counts from full sets', () => {
  const baseLocal = {
    installedIds: new Set<string>(),
    installingIds: new Set<string>(),
    onOpenDetail: () => {},
    onQuickInstall: async () => {},
    onToggleFavorite: () => {},
  };

  it('未收录占位行照常渲染（行不消失），tab 计数等于实际渲染的卡片数', () => {
    const cataloged = makeApp({ id: 'owner/app-a', name: 'AppA', category: 'system', platforms: ['windows'] });
    const extra = makeFavoritePlaceholderSummary('Unknown/PlaceholderApp');
    const { container } = render(
      <FavoritesView
        apps={[cataloged, extra]}
        favoriteIds={new Set(['owner/app-a', 'Unknown/PlaceholderApp', 'ghost/app'])}
        {...baseLocal}
      />,
    );
    // 行：已 join 的两行渲染（ghost/app 无行，由 join 模块在 App 层补齐，此处不断言）。
    expect(container.textContent).toContain('AppA');
    expect(container.textContent).toContain('PlaceholderApp');
    expect(container.textContent).not.toContain('未收录');
    // 计数：与网格行数一致（ghost/app 无行不计）。
    expect(screen.getByRole('tab', { name: '收藏 2' })).not.toBeNull();
  });

  it('缓存回填的富卡行按真实信息直显渲染（同形 AppSummary）', () => {
    const rich = {
      ...makeApp({ id: 'owner/app-rich', name: 'RichApp', description: 'rich desc', stars: 4242 }),
      is_cataloged: false,
    };
    const { container } = render(
      <FavoritesView
        apps={[rich]}
        favoriteIds={new Set(['owner/app-rich'])}
        {...baseLocal}
      />,
    );
    expect(container.textContent).toContain('RichApp');
    expect(container.textContent).toContain('rich desc');
    expect(container.textContent).not.toContain('未收录');
  });

  it('取消收藏即行消失（缺席 id 不成行）', () => {
    const cataloged = makeApp({ id: 'owner/app-a', name: 'AppA', category: 'system', platforms: ['windows'] });
    const { container } = render(
      <FavoritesView apps={[cataloged]} favoriteIds={new Set(['owner/app-a'])} {...baseLocal} />,
    );
    expect(container.textContent).toContain('AppA');
    expect(screen.getByRole('tab', { name: '收藏 1' })).not.toBeNull();
  });

  it('占位行渲染行内加载按钮并透传 id；富卡行无按钮', async () => {
    await i18n.changeLanguage('zh-CN');
    const placeholder = makeFavoritePlaceholderSummary('Unknown/App');
    const rich = makeApp({ id: 'owner/app-a', name: 'AppA' });
    const onLoadUncatalogedDetail = vi.fn(async () => {});
    const { container } = render(
      <FavoritesView
        apps={[placeholder, rich]}
        favoriteIds={new Set(['Unknown/App', 'owner/app-a'])}
        onLoadUncatalogedDetail={onLoadUncatalogedDetail}
        {...baseLocal}
      />,
    );
    const buttons = container.querySelectorAll('[data-testid^="load-detail-"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('加载详情');
    fireEvent.click(buttons[0]);
    expect(onLoadUncatalogedDetail).toHaveBeenCalledWith('Unknown/App');
  });

  it('未传 onLoadUncatalogedDetail 时占位行无加载按钮', () => {
    const placeholder = makeFavoritePlaceholderSummary('Unknown/App');
    const { container } = render(
      <FavoritesView
        apps={[placeholder]}
        favoriteIds={new Set(['Unknown/App'])}
        {...baseLocal}
      />,
    );
    expect(container.querySelectorAll('[data-testid^="load-detail-"]')).toHaveLength(0);
  });
});

describe('watch release alerts live on the Watched tab', () => {
  it('opens on the Watched tab when alerts are pending and routes view / dismiss actions', async () => {
    await i18n.changeLanguage('zh-CN');
    const watched = makeApp({ id: 'rustdesk/rustdesk', name: 'RustDesk' });
    const onOpenDetail = vi.fn();
    const onDismissWatch = vi.fn();
    render(
      <FavoritesView
        apps={[watched]}
        favoriteIds={new Set<string>()}
        watchedIds={new Set<string>(['rustdesk/rustdesk'])}
        installedIds={new Set<string>()}
        onOpenDetail={onOpenDetail}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        watchNotifications={[{ app_id: 'rustdesk/rustdesk', app_name: 'RustDesk', version: 'v1.5.0' }]}
        onDismissWatch={onDismissWatch}
      />,
    );

    expect(screen.getByText('有新版本')).toBeTruthy();
    expect(screen.getByText('你关注的 RustDesk 发布了 v1.5.0')).toBeTruthy();

    const panel = document.querySelector('.watch-releases-panel') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: '查看' }));
    expect(onOpenDetail).toHaveBeenCalledWith('rustdesk/rustdesk');
    fireEvent.click(within(panel).getByRole('button', { name: '知道了' }));
    expect(onDismissWatch).toHaveBeenCalledWith('rustdesk/rustdesk');
  });

  it('stays on the Favorites tab and renders no alert section when nothing is pending', () => {
    render(
      <FavoritesView
        apps={[]}
        favoriteIds={new Set<string>()}
        watchedIds={new Set<string>()}
        installedIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.queryByText('有新版本')).toBeNull();
    expect(document.querySelector('.watch-releases-panel')).toBeNull();
  });
});

describe('watched release check is triggered from the Watched tab', () => {
  const props = {
    apps: [makeApp({ id: 'rustdesk/rustdesk', name: 'RustDesk' })],
    favoriteIds: new Set<string>(),
    watchedIds: new Set<string>(['rustdesk/rustdesk']),
    installedIds: new Set<string>(),
    onOpenDetail: () => {},
    onQuickInstall: () => {},
    onToggleFavorite: () => {},
  };

  it('reports each entry into the Watched tab, without a manual check button', async () => {
    await i18n.changeLanguage('zh-CN');
    const onEnterWatchedTab = vi.fn();
    render(<FavoritesView {...props} onEnterWatchedTab={onEnterWatchedTab} />);
    // 默认落在「收藏」签：不触发
    expect(onEnterWatchedTab).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /^关注/ }));
    expect(onEnterWatchedTab).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /检查/ })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /^收藏/ }));
    fireEvent.click(screen.getByRole('tab', { name: /^关注/ }));
    expect(onEnterWatchedTab).toHaveBeenCalledTimes(2);
  });

  it('reports entry when the view opens straight on the Watched tab', () => {
    const onEnterWatchedTab = vi.fn();
    render(
      <FavoritesView
        {...props}
        watchNotifications={[{ app_id: 'rustdesk/rustdesk', version: 'v1.5.0' }]}
        onEnterWatchedTab={onEnterWatchedTab}
      />,
    );
    expect(onEnterWatchedTab).toHaveBeenCalledTimes(1);
  });
});

describe('watch release alerts arriving after the page opened', () => {
  it('switches to the Watched tab unless the user already picked a tab', async () => {
    await i18n.changeLanguage('zh-CN');
    const props = {
      apps: [],
      favoriteIds: new Set<string>(),
      watchedIds: new Set<string>(),
      installedIds: new Set<string>(),
      onOpenDetail: () => {},
      onQuickInstall: () => {},
      onToggleFavorite: () => {},
    };
    const alert = [{ app_id: 'rustdesk/rustdesk', app_name: 'RustDesk', version: 'v1.5.0' }];

    const { rerender, unmount } = render(<FavoritesView {...props} watchNotifications={[]} />);
    rerender(<FavoritesView {...props} watchNotifications={alert} />);
    expect(screen.getByText('你关注的 RustDesk 发布了 v1.5.0')).toBeTruthy();
    unmount();

    const second = render(<FavoritesView {...props} watchNotifications={[]} />);
    fireEvent.click(screen.getByRole('tab', { name: /^收藏/ }));
    second.rerender(<FavoritesView {...props} watchNotifications={alert} />);
    expect(screen.queryByText('你关注的 RustDesk 发布了 v1.5.0')).toBeNull();
  });
});

describe('favorites & watched counts, platform spread and empty states', () => {
  const winApp = makeApp({ id: 'acme/win-tool', name: 'WinTool', platforms: ['windows'] });
  const macApp = makeApp({ id: 'acme/mac-tool', name: 'MacTool', platforms: ['macos'] });
  const linuxApp = makeApp({ id: 'acme/linux-tool', name: 'LinuxTool', platforms: ['linux'] });
  const all = [winApp, macApp, linuxApp];
  const base = {
    allApps: all,
    favoriteIds: new Set(['acme/win-tool', 'acme/mac-tool']),
    watchedIds: new Set(['ACME/Linux-Tool', 'acme/mac-tool']),
    installedIds: new Set<string>(),
    onOpenDetail: () => {},
    onQuickInstall: () => {},
    onToggleFavorite: () => {},
  };
  const cardCount = (container: HTMLElement) => container.querySelectorAll('.app-grid > *').length;

  it('tab badges equal the rendered cards under platform filter and page search', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container, rerender } = render(<FavoritesView {...base} apps={all} />);
    expect(screen.getByRole('tab', { name: '收藏 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '关注 2' })).toBeTruthy();
    expect(cardCount(container)).toBe(2);

    // 平台筛选后（父层已过滤 apps）只剩 macOS 行
    rerender(<FavoritesView {...base} apps={[macApp, linuxApp]} />);
    expect(screen.getByRole('tab', { name: '收藏 1' })).toBeTruthy();
    expect(cardCount(container)).toBe(1);

    fireEvent.change(screen.getByPlaceholderText('搜索应用或仓库...'), { target: { value: 'linux' } });
    expect(screen.getByRole('tab', { name: '收藏 0' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '关注 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '关注 1' }));
    expect(cardCount(container)).toBe(1);
  });

  it('renders a platform-filter empty state with reset when favorites exist but none match the platforms', async () => {
    await i18n.changeLanguage('zh-CN');
    const onReset = vi.fn();
    render(<FavoritesView {...base} apps={[]} onResetPlatformFilter={onReset} />);
    expect(screen.queryByText('收藏夹还是空的')).toBeNull();
    expect(screen.getByText('当前平台下暂无收藏应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onReset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /^关注/ }));
    expect(screen.queryByText('关注的应用暂未收录')).toBeNull();
    expect(screen.getByText('当前平台下暂无关注应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('a search with no hits offers a clear-search action', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<FavoritesView {...base} apps={all} />);
    fireEvent.change(screen.getByPlaceholderText('搜索应用或仓库...'), { target: { value: 'zzz' } });
    expect(screen.getByText('没有匹配的收藏应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(cardCount(container)).toBe(2);
  });

  it('reports the full favorites or watched platform spread for the active tab', () => {
    const onCounts = vi.fn();
    render(<FavoritesView {...base} apps={[]} onDisplayPlatformCounts={onCounts} />);
    expect(onCounts).toHaveBeenLastCalledWith({ windows: 1, macos: 1, linux: 0, ios: 0, android: 0, other: 0 });
    fireEvent.click(screen.getByRole('tab', { name: /^关注/ }));
    expect(onCounts).toHaveBeenLastCalledWith({ windows: 0, macos: 1, linux: 1, ios: 0, android: 0, other: 0 });
  });

  it('the new-release panel follows the platform filter and page search', async () => {
    await i18n.changeLanguage('zh-CN');
    const alerts = [
      { app_id: 'acme/linux-tool', app_name: 'LinuxTool', version: 'v2' },
      { app_id: 'acme/mac-tool', app_name: 'MacTool', version: 'v3' },
    ];
    render(<FavoritesView {...base} apps={[linuxApp]} watchNotifications={alerts} />);
    const panel = () => document.querySelector('.watch-releases-panel') as HTMLElement;
    expect(within(panel()).getByText('你关注的 LinuxTool 发布了 v2')).toBeTruthy();
    expect(within(panel()).queryByText('你关注的 MacTool 发布了 v3')).toBeNull();
    expect(within(panel()).getByText('1')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('搜索应用或仓库...'), { target: { value: 'nothing' } });
    expect(panel()).toBeNull();
  });

  it('opens CollectionShareModal from FavoritesView when current list is non-empty', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<FavoritesView {...base} apps={all} />);

    fireEvent.click(screen.getByRole('button', { name: '分享清单' }));
    expect(await screen.findByRole('heading', { name: '分享应用合集' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'WinTool' })).toBeTruthy();
  });
});