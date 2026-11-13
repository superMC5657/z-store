/**
 * 收藏页「Star 同步」卡片流：
 * - 查询第 1 页后按 Star 时间顺序渲染；有下一页时按钮续拉第 2 页并追加；
 * - 输入框为登录名（或留空）时按登录账号查询（不传用户名，可带出私有 Star）；
 * - 只批量收藏已加载、已收录且未收藏的应用；
 * - 切页回来从分页缓存恢复，不重复请求；查自己的结果只对同一登录账号恢复；
 * - 是否还有下一页只看后端 `has_more`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { StarredFeed, STARRED_PER_PAGE, resetStarredFeedMemory } from './StarredFeed';
import { tauriApi } from '../../services/api';
import {
  clearSearchListCache,
  patchSearchListCacheRows,
  readSearchListCache,
} from '../../services/search/searchListCache';
import { __resetIconStoreForTests, admitIconHit } from '../../services/iconStore';
import { LOADING_SETTLE_MS } from '../../lib/platformFilter';
import { makeApp } from '../test-utils/filterFixture';
import type { AppSummary } from '../../types';

const pageOf = (prefix: string, n: number, cataloged = true): AppSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    ...makeApp({ id: `${prefix}/app-${i}`, name: `${prefix}-${i}` }),
    is_cataloged: cataloged,
  }));

const user = (login: string) => ({ login, avatar_url: '', has_list_scope: true, is_expired: false });

async function queryAs(value: string) {
  fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
}

const baseProps = {
  platformResolvedOtherIds: new Set<string>(),
  favoriteIds: new Set<string>(),
  installedIds: new Set<string>(),
  installingIds: new Set<string>(),
  onOpenDetail: () => {},
  onQuickInstall: () => {},
  onToggleFavorite: () => {},
};

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  resetStarredFeedMemory();
  clearSearchListCache();
  __resetIconStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('StarredFeed', () => {
  it('queries a named user, then appends the next page via the load-more button', async () => {
    const spy = vi
      .spyOn(tauriApi, 'listGithubStarred')
      .mockResolvedValueOnce({ rows: pageOf('p1', STARRED_PER_PAGE), has_more: true })
      .mockResolvedValueOnce({ rows: pageOf('p2', 3), has_more: false });
    render(<StarredFeed {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value: 'octocat' } });
    fireEvent.click(screen.getByRole('button', { name: '查看' }));

    await screen.findByText('p1-0');
    expect(spy).toHaveBeenNthCalledWith(1, 'octocat', 1, STARRED_PER_PAGE);
    expect(screen.getByTestId('starred-armed-boundary')).toBeTruthy();

    fireEvent.click(screen.getByTestId('starred-load-more'));
    await screen.findByText('p2-2');
    expect(spy).toHaveBeenNthCalledWith(2, 'octocat', 2, STARRED_PER_PAGE);
    expect(screen.getByTestId('starred-grid').children).toHaveLength(STARRED_PER_PAGE + 3);
    expect(screen.getByTestId('starred-end').textContent).toContain(`${STARRED_PER_PAGE + 3} 个应用`);
  });

  it('own login (any case) queries the signed-in account without a username', async () => {
    const spy = vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: pageOf('me', 1), has_more: false });
    render(
      <StarredFeed {...baseProps} oauthUser={{ login: 'SuperMC', avatar_url: '', has_list_scope: true, is_expired: false }} />,
    );
    fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value: 'supermc' } });
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await screen.findByText('me-0');
    expect(spy).toHaveBeenCalledWith(undefined, 1, STARRED_PER_PAGE);
  });

  it('without login or username it asks for a username instead of calling the backend', () => {
    const spy = vi.spyOn(tauriApi, 'listGithubStarred');
    render(<StarredFeed {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(/请输入 GitHub 用户名/)).toBeTruthy();
  });

  it('batch favorite only touches loaded, cataloged, not-yet-favorited apps', async () => {
    const rows = [...pageOf('cat', 2, true), ...pageOf('ext', 1, false)];
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows, has_more: false });
    const onToggleFavorite = vi.fn();
    render(
      <StarredFeed {...baseProps} favoriteIds={new Set(['cat/app-0'])} onToggleFavorite={onToggleFavorite} />,
    );
    fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value: 'octocat' } });
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await screen.findByText('cat-1');

    fireEvent.click(screen.getByRole('button', { name: '收藏已加载的已收录应用' }));
    expect(onToggleFavorite.mock.calls).toEqual([['cat/app-1']]);
  });

  it('restores loaded pages from the page cache after remount without refetching', async () => {
    const spy = vi
      .spyOn(tauriApi, 'listGithubStarred')
      .mockResolvedValueOnce({ rows: pageOf('p1', STARRED_PER_PAGE), has_more: true })
      .mockResolvedValueOnce({ rows: pageOf('p2', 2), has_more: false });
    const first = render(<StarredFeed {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value: 'octocat' } });
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await screen.findByText('p1-0');
    fireEvent.click(screen.getByTestId('starred-load-more'));
    await screen.findByText('p2-1');
    first.unmount();

    render(<StarredFeed {...baseProps} />);
    expect(screen.getByText('p1-0')).toBeTruthy();
    expect(screen.getByText('p2-1')).toBeTruthy();
    expect((screen.getByPlaceholderText('GitHub 用户名') as HTMLInputElement).value).toBe('octocat');
    expect(screen.getByTestId('starred-end')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a failed next page keeps loaded rows and shows the error', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred')
      .mockResolvedValueOnce({ rows: pageOf('p1', STARRED_PER_PAGE), has_more: true })
      .mockRejectedValueOnce(new Error('rate limited'));
    render(<StarredFeed {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value: 'octocat' } });
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await screen.findByText('p1-0');
    fireEvent.click(screen.getByTestId('starred-load-more'));
    await waitFor(() => expect(screen.getByText(/rate limited/)).toBeTruthy());
    expect(screen.getByText('p1-0')).toBeTruthy();
    expect((screen.getByTestId('starred-load-more') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a full last page ends the feed when the backend says there is no next page', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: pageOf('p1', STARRED_PER_PAGE), has_more: false });
    render(<StarredFeed {...baseProps} />);
    await queryAs('octocat');
    await screen.findByText('p1-0');
    expect(screen.queryByTestId('starred-load-more')).toBeNull();
    expect(screen.getByTestId('starred-end')).toBeTruthy();
  });

  it('own stars are not restored for a different account', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: pageOf('mine', 2), has_more: false });
    const first = render(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
    await queryAs('alice');
    await screen.findByText('mine-0');
    first.unmount();

    render(<StarredFeed {...baseProps} oauthUser={user('bob')} />);
    expect(screen.queryByText('mine-0')).toBeNull();
    expect((screen.getByPlaceholderText('GitHub 用户名') as HTMLInputElement).value).toBe('bob');
  });

  it('switching accounts while viewing own stars clears them', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: pageOf('mine', 2), has_more: false });
    const view = render(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
    await queryAs('');
    await screen.findByText('mine-0');
    view.rerender(<StarredFeed {...baseProps} oauthUser={user('bob')} />);
    expect(screen.queryByText('mine-0')).toBeNull();
    expect(screen.getByText('查看 GitHub Star')).toBeTruthy();
  });

  it('own stars restore once the login arrives and keep querying the signed-in account', async () => {
    const spy = vi
      .spyOn(tauriApi, 'listGithubStarred')
      .mockResolvedValueOnce({ rows: pageOf('p1', STARRED_PER_PAGE), has_more: true })
      .mockResolvedValueOnce({ rows: pageOf('p2', 1), has_more: false });
    const first = render(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
    await queryAs('Alice');
    await screen.findByText('p1-0');
    first.unmount();

    const second = render(<StarredFeed {...baseProps} oauthUser={null} />);
    expect(screen.queryByText('p1-0')).toBeNull();
    second.rerender(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
    expect(screen.getByText('p1-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('starred-load-more'));
    await screen.findByText('p2-0');
    expect(spy).toHaveBeenLastCalledWith(undefined, 2, STARRED_PER_PAGE);
  });

  it('an empty result is restored as empty instead of the not-queried state', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: [], has_more: false });
    const first = render(<StarredFeed {...baseProps} />);
    await queryAs('nobody');
    await screen.findByText('该账号还没有 Star 任何公开仓库。');
    first.unmount();

    render(<StarredFeed {...baseProps} />);
    expect(screen.getByText('该账号还没有 Star 任何公开仓库。')).toBeTruthy();
  });

  it('backfills platforms via getPlatformsLite (DB-first) and writes through to cache and other-set', async () => {
    const rows: AppSummary[] = [
      { ...makeApp({ id: 'acme/desktop', name: 'DesktopApp', platforms: [] }), is_cataloged: false },
      { ...makeApp({ id: 'acme/skill', name: 'SkillRepo', platforms: [] }), is_cataloged: false },
    ];
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows, has_more: false });
    const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => {
      if (id === 'acme/desktop') return { id, platforms: ['windows', 'linux'], is_stale: false };
      return { id, platforms: [], is_stale: false };
    });
    const onConfirmPlatformOtherIds = vi.fn();

    const view = render(
      <StarredFeed {...baseProps} onConfirmPlatformOtherIds={onConfirmPlatformOtherIds} />,
    );
    await queryAs('octocat');
    await screen.findByText('DesktopApp');

    await waitFor(() => {
      expect(liteSpy).toHaveBeenCalledWith('acme/desktop', false);
      expect(liteSpy).toHaveBeenCalledWith('acme/skill', false);
      expect(onConfirmPlatformOtherIds).toHaveBeenCalledWith(['acme/skill']);
    });

    // 真实平台从 loading 占位变为 OS 图标且按钮升级为「获取」，同步写透分页缓存。
    await waitFor(() => {
      expect(screen.getByTitle('获取 DesktopApp')).toBeTruthy();
    });
    expect(readSearchListCache({ namespace: 'starred', query: 'octocat', page: 1, perPage: STARRED_PER_PAGE })?.[0].platforms).toEqual([
      'windows',
      'linux',
    ]);

    // 独立使用时（未传回调）也能本地落定「其他」。
    view.unmount();
    resetStarredFeedMemory();
    clearSearchListCache();
    const standalone = render(<StarredFeed {...baseProps} />);
    await queryAs('octocat');
    await waitFor(() => {
      expect(standalone.container.querySelectorAll('.app-tag-platforms-loading')).toHaveLength(0);
      expect(standalone.container.textContent).toContain('其他');
    });
  });

  it('settles stale/failed rows to Other after 15s without hammering getPlatformsLite', async () => {
    vi.useFakeTimers();
    const rows: AppSummary[] = [
      { ...makeApp({ id: 'acme/offline', name: 'OfflineRepo', platforms: [] }), is_cataloged: false },
    ];
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows, has_more: false });
    const liteSpy = vi
      .spyOn(tauriApi, 'getPlatformsLite')
      .mockResolvedValue({ id: 'acme/offline', platforms: [], is_stale: true });

    const { container } = render(<StarredFeed {...baseProps} />);
    await queryAs('octocat');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('OfflineRepo')).toBeTruthy();
    expect(container.querySelector('.app-tag-platforms-loading')).not.toBeNull();
    expect(liteSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_SETTLE_MS + 10);
    });
    expect(container.querySelector('.app-tag-platforms-loading')).toBeNull();
    expect(container.textContent).toContain('其他');
    expect(liteSpy).toHaveBeenCalledTimes(1);
  });

  it('updates mounted rows immediately on icon writes and detail cache patches', async () => {
    const rows: AppSummary[] = [
      { ...makeApp({ id: 'acme/live', name: 'LiveApp', icon: '', platforms: ['windows'] }), is_cataloged: false },
    ];
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows, has_more: false });
    vi.spyOn(tauriApi, 'getPlatformsLite').mockResolvedValue({ id: 'acme/live', platforms: ['windows'] });

    const { container } = render(<StarredFeed {...baseProps} />);
    await queryAs('octocat');
    await screen.findByText('LiveApp');
    expect(container.querySelector('img')).toBeNull();

    act(() => {
      admitIconHit({
        id: 'acme/live',
        icon: 'https://cdn.simpleicons.org/live',
        level: 2,
        via: 'live',
      });
    });
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://cdn.simpleicons.org/live');
    });

    act(() => {
      patchSearchListCacheRows((prev) =>
        prev.map((r) => (r.id === 'acme/live' ? { ...r, stars: 9876 } : r)),
      );
    });
    await waitFor(() => {
      expect(container.textContent).toContain('9.9k');
    });
  });

  it('aligns rich-card actions & badges with Search/Trends: move-in, customIds, cataloged, and local badge', async () => {
    const rows: AppSummary[] = [
      makeApp({ id: 'acme/guess-dev', name: 'GuessDev', owner: 'acme', repo: 'guess-dev', category: 'dev', category_name: '开发工具', platforms: ['windows'] }),
      makeApp({ id: 'acme/in-draft', name: 'InDraft', owner: 'acme', repo: 'in-draft', category: 'external', category_name: 'external', platforms: ['linux'] }),
      makeApp({ id: 'acme/in-catalog', name: 'InCatalog', owner: 'acme', repo: 'in-catalog', category: 'dev', is_verified: true, platforms: ['windows'] }),
      makeApp({ id: 'acme/in-local', name: 'InLocal', owner: 'acme', repo: 'in-local', category: 'dev', is_verified: false, platforms: ['macos'] }),
    ];
    const catalogApps = [
      makeApp({ id: 'acme/in-catalog', name: 'InCatalog', owner: 'acme', repo: 'in-catalog', is_verified: true, platforms: ['windows'] }),
    ];
    const localApps = [
      { ...makeApp({ id: 'acme/in-local', name: 'InLocal', owner: 'acme', repo: 'in-local', platforms: ['macos'] }), source: 'local', status: 'collected' } as AppSummary,
    ];
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows, has_more: false });
    vi.spyOn(tauriApi, 'getPlatformsLite').mockResolvedValue({ id: 'x', platforms: [] });
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({ id: 'acme/guess-dev' } as never);
    const onOpenDetail = vi.fn();

    const seen: string[] = [];
    const onChanged = (e: Event) => {
      seen.push(String((e as CustomEvent<{ id?: string }>).detail?.id ?? ''));
    };
    window.addEventListener('zstore:custom-apps-changed', onChanged);
    try {
      const { container } = render(
        <StarredFeed
          {...baseProps}
          onOpenDetail={onOpenDetail}
          catalogApps={catalogApps}
          customIds={new Set(['acme/in-draft'])}
          localApps={localApps}
        />,
      );
      await queryAs('octocat');
      await screen.findByText('GuessDev');

      // 未收录项（含 dev 猜分类）经显式标注露出「移入收录」；已草稿/已收录/本地收录隐藏入口。
      const moveInBtn = screen.getByTestId('move-in-acme/guess-dev');
      expect(moveInBtn.textContent).toContain('移入收录');
      expect(screen.queryByTestId('move-in-acme/in-draft')).toBeNull();
      expect(screen.queryByTestId('move-in-acme/in-catalog')).toBeNull();
      expect(screen.queryByTestId('move-in-acme/in-local')).toBeNull();

      // 本地收录项叠加橘黄角标，已认证项保持蓝标。
      expect(container.querySelector('.verified-badge-local')).not.toBeNull();
      expect(container.querySelector('.verified-badge')).not.toBeNull();

      fireEvent.click(moveInBtn);
      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
      expect((saveSpy.mock.calls[0]?.[0] as { id?: string }).id).toBe('acme/guess-dev');
      expect(onOpenDetail).not.toHaveBeenCalled();
      await waitFor(() => expect(seen).toEqual(['acme/guess-dev']));
    } finally {
      window.removeEventListener('zstore:custom-apps-changed', onChanged);
    }
  });

  it('接入 selectedPlatforms 过滤（loading 保持可见、空匹配展示重置引导）并上报平台分布计数', async () => {
    const winApp = makeApp({ id: 'acme/win-app', name: 'WinApp', platforms: ['windows'] });
    const macApp = makeApp({ id: 'acme/mac-app', name: 'MacApp', platforms: ['macos'] });
    const loadingApp = makeApp({ id: 'acme/loading-app', name: 'LoadingApp', platforms: [] });
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({
      rows: [winApp, macApp, loadingApp],
      has_more: false,
    });
    vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(() => new Promise(() => {}));

    const onDisplayPlatformCounts = vi.fn();
    const onResetPlatformFilter = vi.fn();

    const { rerender, unmount } = render(
      <StarredFeed
        {...baseProps}
        selectedPlatforms={new Set(['windows'])}
        onDisplayPlatformCounts={onDisplayPlatformCounts}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );

    await queryAs('octocat');
    await screen.findByText('WinApp');

    // Windows 命中 + loading 行可见，macOS 行被过滤；平台计数基于全量已加载行（loading 不计）。
    expect(screen.getByText('WinApp')).toBeTruthy();
    expect(screen.getByText('LoadingApp')).toBeTruthy();
    expect(screen.queryByText('MacApp')).toBeNull();
    expect(onDisplayPlatformCounts).toHaveBeenLastCalledWith({
      windows: 1,
      macos: 1,
      linux: 0,
      ios: 0,
      android: 0,
      other: 0,
    });

    // 切到全空筛选（如 android）时展示 FilterEmptyState 并可触发重置回调。
    rerender(
      <StarredFeed
        {...baseProps}
        selectedPlatforms={new Set(['android'])}
        platformResolvedOtherIds={new Set(['acme/loading-app'])}
        onDisplayPlatformCounts={onDisplayPlatformCounts}
        onResetPlatformFilter={onResetPlatformFilter}
      />,
    );
    expect(screen.getByText('当前平台下暂无 Star 应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onResetPlatformFilter).toHaveBeenCalledTimes(1);

    // 卸载清空上报计数（回落收录库口径）。
    unmount();
    expect(onDisplayPlatformCounts).toHaveBeenLastCalledWith(null);
  });
});
