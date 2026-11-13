/**
 * 收藏页「Star 同步」卡片流：
 * - 查询第 1 页后按 Star 时间顺序渲染；有下一页时按钮续拉第 2 页并追加；
 * - 输入框为登录名（或留空）时按登录账号查询（不传用户名，可带出私有 Star）；
 * - 只批量收藏已加载、已收录且未收藏的应用；
 * - 切页回来从分页缓存恢复，不重复请求；查自己的结果只对同一登录账号恢复；
 * - 是否还有下一页只看后端 `has_more`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { StarredFeed, STARRED_PER_PAGE, resetStarredFeedMemory } from './StarredFeed';
import { tauriApi } from '../../services/api';
import { clearSearchListCache } from '../../services/search/searchListCache';
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
});

afterEach(() => {
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
});
