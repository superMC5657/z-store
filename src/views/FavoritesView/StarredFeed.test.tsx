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
import { clearTrendEnrichCache } from '../../services/trends/enrich';
import { peekFreshRepoCard } from '../../services/repoEnrichCache';
import { STARRED_OPTS_STORAGE_KEY } from '../../services/starred/starredCache';
import { LOADING_SETTLE_MS } from '../../lib/platformFilter';
import { makeApp } from '../test-utils/filterFixture';
import type { AppSummary } from '../../types';

const pageOf = (prefix: string, n: number, cataloged = true): AppSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    ...makeApp({ id: `${prefix}/app-${i}`, name: `${prefix}-${i}` }),
    is_cataloged: cataloged,
  }));

const user = (login: string) => ({ login, avatar_url: '', has_list_scope: true, is_expired: false });

function syncButton(): HTMLButtonElement {
  const btn = document.querySelector('.starred-banner-actions button');
  if (!btn) throw new Error('sync button not found');
  return btn as HTMLButtonElement;
}

async function queryAs(value: string) {
  fireEvent.change(screen.getByPlaceholderText('GitHub 用户名'), { target: { value } });
  fireEvent.click(syncButton());
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
  clearTrendEnrichCache();
  __resetIconStoreForTests();
  window.localStorage.clear();
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
    expect(spy).toHaveBeenNthCalledWith(1, 'octocat', 1, STARRED_PER_PAGE, false);
    expect(screen.getByTestId('starred-armed-boundary')).toBeTruthy();

    fireEvent.click(screen.getByTestId('starred-load-more'));
    await screen.findByText('p2-2');
    expect(spy).toHaveBeenNthCalledWith(2, 'octocat', 2, STARRED_PER_PAGE, false);
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
    expect(spy).toHaveBeenCalledWith(undefined, 1, STARRED_PER_PAGE, false);
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
    expect(spy).toHaveBeenLastCalledWith(undefined, 2, STARRED_PER_PAGE, false);
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
    // 底部叙述计数取平台过滤后的行数（2），而非已加载全量（3）。
    expect(screen.getByTestId('starred-end').textContent).toContain('2 个应用');
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

  it('load-more hint counts only rows that pass the platform filter', async () => {
    vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({
      rows: [
        makeApp({ id: 'acme/win-a', name: 'WinA', platforms: ['windows'] }),
        makeApp({ id: 'acme/mac-b', name: 'MacB', platforms: ['macos'] }),
        makeApp({ id: 'acme/mac-c', name: 'MacC', platforms: ['macos'] }),
      ],
      has_more: true,
    });
    render(<StarredFeed {...baseProps} selectedPlatforms={new Set(['windows'])} />);
    await queryAs('octocat');
    await screen.findByText('WinA');
    const hint = document.querySelector('.online-armed-sub')?.textContent ?? '';
    expect(hint).toBe(i18n.t('search.online_armed_hint', { count: 1 }));
  });

  describe('L1/L2 cache and SWR sync', () => {
    const snapshot = (pages: Array<{ page: number; ids: string[] }>, hasMore = false) => ({
      payload_json: JSON.stringify({ v: 2, pages, hasMore }),
      cached_at: Math.floor(Date.now() / 1000) - 60,
    });

    it('cold mount hydrates the v2 snapshot via one getRepoCardsBatch call: icons, platforms, Other, zero list/lite', async () => {
      window.localStorage.setItem(STARRED_OPTS_STORAGE_KEY, JSON.stringify({ mode: 'user', username: 'Torvalds' }));
      const listSpy = vi.spyOn(tauriApi, 'listGithubStarred');
      const getSpy = vi
        .spyOn(tauriApi, 'getStarredFeedCache')
        .mockResolvedValue(snapshot([{ page: 1, ids: ['snap/app-0', 'snap/app-1'] }]));
      const [card0, card1] = pageOf('snap', 2, false);
      const nowSecs = Math.floor(Date.now() / 1000);
      const batchSpy = vi.spyOn(tauriApi, 'getRepoCardsBatch').mockResolvedValue([
        {
          summary: { ...card0, icon: 'https://cdn.example/snap0.png', platforms: ['windows'] },
          confirmed_other: false,
          updated_at: nowSecs,
        },
        { summary: { ...card1, icon: '', platforms: [] }, confirmed_other: true, updated_at: nowSecs },
      ]);
      const iconSpy = vi.spyOn(tauriApi, 'getConfirmedIconsBatch');
      const liteSpy = vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(() => new Promise(() => {}));
      const onConfirm = vi.fn();

      const view = render(<StarredFeed {...baseProps} onConfirmPlatformOtherIds={onConfirm} />);
      await screen.findByText('snap-0');
      expect(getSpy).toHaveBeenCalledWith('torvalds');
      expect((screen.getByPlaceholderText('GitHub 用户名') as HTMLInputElement).value).toBe('Torvalds');
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).toHaveBeenCalledWith(['snap/app-0', 'snap/app-1']);
      expect(view.container.querySelector('img[src="https://cdn.example/snap0.png"]')).toBeTruthy();
      expect(onConfirm).toHaveBeenCalledWith(['snap/app-1']);
      await new Promise((r) => setTimeout(r, 50));
      expect(iconSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
      expect(liteSpy).not.toHaveBeenCalled();
    });

    it('switching alice → bob → alice within 5 minutes serves alice from the page cache', async () => {
      vi.spyOn(tauriApi, 'getStarredFeedCache').mockResolvedValue(null);
      const spy = vi.spyOn(tauriApi, 'listGithubStarred').mockImplementation(async (username) => ({
        rows: pageOf(String(username), 2),
        has_more: false,
      }));
      render(<StarredFeed {...baseProps} />);
      await queryAs('alice');
      await screen.findByText('alice-0');
      await queryAs('bob');
      await screen.findByText('bob-0');
      await queryAs('alice');
      await screen.findByText('alice-0');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => c[0])).toEqual(['alice', 'bob']);
    });

    it('re-sync keeps cards on screen, forces refresh and writes through to L1 + L2', async () => {
      vi.spyOn(tauriApi, 'getStarredFeedCache').mockResolvedValue(null);
      const saveSpy = vi.spyOn(tauriApi, 'saveStarredFeedCache').mockResolvedValue();
      let resolveSecond: ((v: { rows: AppSummary[]; has_more: boolean }) => void) | undefined;
      const spy = vi
        .spyOn(tauriApi, 'listGithubStarred')
        .mockResolvedValueOnce({ rows: pageOf('old', 2), has_more: false })
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
      render(<StarredFeed {...baseProps} />);
      await queryAs('octocat');
      await screen.findByText('old-0');

      fireEvent.click(syncButton());
      // 在途时旧卡片仍在屏。
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      expect(spy).toHaveBeenLastCalledWith('octocat', 1, STARRED_PER_PAGE, true);
      expect(screen.getByText('old-0')).toBeTruthy();

      await act(async () => {
        resolveSecond?.({ rows: pageOf('new', 3), has_more: false });
      });
      await screen.findByText('new-2');
      expect(screen.queryByText('old-0')).toBeNull();
      expect(
        readSearchListCache({ namespace: 'starred', query: 'octocat', page: 1, perPage: STARRED_PER_PAGE })?.map(
          (r) => r.id,
        ),
      ).toEqual(['new/app-0', 'new/app-1', 'new/app-2']);
      // 首次同步与手动重同步各直接写一次 v2 id 快照（无防抖）。
      expect(saveSpy).toHaveBeenCalledTimes(2);
      const [key, scope, payload] = saveSpy.mock.calls.at(-1)!;
      expect(key).toBe('octocat');
      expect(scope).toBe('octocat');
      expect(JSON.parse(payload)).toEqual({
        v: 2,
        pages: [{ page: 1, ids: ['new/app-0', 'new/app-1', 'new/app-2'] }],
        hasMore: false,
      });
      expect(payload).not.toContain('is_cataloged');
    });

    it('platform and icon updates never rewrite the snapshot; load-more writes the next page ids once', async () => {
      vi.spyOn(tauriApi, 'getStarredFeedCache').mockResolvedValue(null);
      const saveSpy = vi.spyOn(tauriApi, 'saveStarredFeedCache').mockResolvedValue();
      vi.spyOn(tauriApi, 'getPlatformsLite').mockImplementation(async (id: string) => ({
        id,
        platforms: ['linux'],
        is_stale: false,
      }));
      vi.spyOn(tauriApi, 'listGithubStarred')
        .mockResolvedValueOnce({ rows: pageOf('ext', STARRED_PER_PAGE, false).map((r) => ({ ...r, platforms: [] })), has_more: true })
        .mockResolvedValueOnce({ rows: pageOf('more', 2, false), has_more: false });
      render(<StarredFeed {...baseProps} />);
      await queryAs('octocat');
      await screen.findByText('ext-0');
      expect(saveSpy).toHaveBeenCalledTimes(1);
      act(() => {
        admitIconHit({ id: 'ext/app-0', icon: 'https://cdn.example/late.png', via: 'live' });
      });
      await new Promise((r) => setTimeout(r, 1000));
      expect(saveSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('starred-load-more'));
      await screen.findByText('more-1');
      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
      const env = JSON.parse(saveSpy.mock.calls[1][2]);
      expect(env.pages.map((p: { page: number }) => p.page)).toEqual([1, 2]);
      expect(env.pages[1].ids).toEqual(['more/app-0', 'more/app-1']);
      expect(env.hasMore).toBe(false);
    });

    it('logging out clears the @me state, its memory cache and private repo cards', async () => {
      vi.spyOn(tauriApi, 'getStarredFeedCache').mockResolvedValue(null);
      vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({
        rows: pageOf('mine', 2, false),
        has_more: false,
        private_ids: ['mine/app-0'],
      });
      const view = render(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
      await queryAs('');
      await screen.findByText('mine-0');
      expect(
        readSearchListCache({ namespace: 'starred', query: '@me:alice', page: 1, perPage: STARRED_PER_PAGE }),
      ).toBeDefined();

      expect(peekFreshRepoCard('mine/app-0')).toBeDefined();

      view.rerender(<StarredFeed {...baseProps} oauthUser={null} />);
      expect(screen.queryByText('mine-0')).toBeNull();
      expect(
        readSearchListCache({ namespace: 'starred', query: '@me:alice', page: 1, perPage: STARRED_PER_PAGE }),
      ).toBeUndefined();
      expect(peekFreshRepoCard('mine/app-0')).toBeUndefined();
    });

    it('after logout the @me snapshot is never written again, even on unmount or late responses', async () => {
      vi.spyOn(tauriApi, 'getStarredFeedCache').mockResolvedValue(null);
      const saveSpy = vi.spyOn(tauriApi, 'saveStarredFeedCache').mockResolvedValue();
      vi.spyOn(tauriApi, 'listGithubStarred').mockResolvedValue({ rows: pageOf('mine', 2), has_more: false });
      const view = render(<StarredFeed {...baseProps} oauthUser={user('alice')} />);
      await queryAs('');
      await screen.findByText('mine-0');
      const savedBeforeLogout = saveSpy.mock.calls.length;
      expect(savedBeforeLogout).toBe(1);

      view.rerender(<StarredFeed {...baseProps} oauthUser={null} />);
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(saveSpy).toHaveBeenCalledTimes(savedBeforeLogout);
    });
  });
});
