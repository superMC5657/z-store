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

  it('未收录占位行照常渲染（行不消失），tab 计数用全集（含无行 id）', () => {
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
    // 计数：全集 3（含无行的 ghost/app），不随行数缩水。
    expect(screen.getByRole('tab', { name: '收藏 3' })).not.toBeNull();
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
