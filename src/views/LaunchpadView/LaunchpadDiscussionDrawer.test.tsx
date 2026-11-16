import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '../../i18n';
import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
  OAuthUser,
} from '../../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const api = vi.hoisted(() => ({
  getLaunchpadDiscussion: vi.fn(),
  addLaunchpadComment: vi.fn(),
  toggleLaunchpadUpvote: vi.fn(),
  openUrl: vi.fn(async () => undefined),
}));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        prop in api ? api[prop as keyof typeof api] : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

import { LaunchpadDiscussionDrawer } from './LaunchpadDiscussionDrawer';

const entry: LaunchpadEntry = {
  summary: {
    id: 'acme/hyper',
    name: 'HyperTerm',
    owner: 'acme',
    repo: 'hyper',
    icon: '',
    icon_bg: '',
    description: '',
    stars: 1,
    forks: 0,
    license: 'MIT',
    latest_version: 'v1',
    category: 'dev',
    category_name: 'Dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  },
  maker_note: '自荐语',
  maker: { login: 'acme', avatar_url: '', html_url: 'https://github.com/acme' },
  launched_at: '2027-01-10T00:00:00Z',
  stars_7d_delta: 0,
  discussion_repo: 'superMC5657/z-store-launchpad',
  discussion_number: 7,
  discussion_node_id: 'D_7',
  discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/7',
  discussion_comments_count: 2,
  discussion_upvotes: 3,
  is_pinned: false,
  viewer_has_starred: false,
};

function comment(id: string, login: string, body: string, replies: LaunchpadDiscussionComment[] = []): LaunchpadDiscussionComment {
  return {
    id,
    body,
    created_at: '2027-01-11T00:00:00Z',
    author_association: 'NONE',
    author: { login, avatar_url: '', html_url: `https://github.com/${login}` },
    upvote_count: 0,
    viewer_has_upvoted: false,
    replies,
  };
}

function detail(overrides: Partial<LaunchpadDiscussionDetail> = {}): LaunchpadDiscussionDetail {
  return {
    id: 'D_7',
    number: 7,
    title: 'HyperTerm',
    body: '**主帖正文**',
    url: entry.discussion_url,
    created_at: '2027-01-10T00:00:00Z',
    locked: false,
    closed: false,
    author: { login: 'zstore-bot', avatar_url: '', html_url: '' },
    category_name: 'Launches',
    upvote_count: 3,
    viewer_has_upvoted: false,
    viewer_can_upvote: true,
    viewer_can_comment: true,
    auth_required_for_write: false,
    comments_total: 2,
    has_next_page: false,
    end_cursor: null,
    comments: [
      comment('DC_1', 'bob', 'nice <script>alert(1)</script><img src=x onerror="alert(2)">', [
        comment('DC_2', 'acme', 'thanks from the maker'),
      ]),
    ],
    is_stale: false,
    ...overrides,
  };
}

const user: OAuthUser = { login: 'me', has_list_scope: true, is_expired: false };

function renderDrawer(overrides: Partial<React.ComponentProps<typeof LaunchpadDiscussionDrawer>> = {}) {
  const props = {
    entry,
    oauthUser: user as OAuthUser | null,
    onClose: vi.fn(),
    onOpenDeveloper: vi.fn(),
    onOpenAccount: vi.fn(),
    onUpvoteChange: vi.fn(),
    onCommentAdded: vi.fn(),
    ...overrides,
  };
  render(<LaunchpadDiscussionDrawer {...props} />);
  return props;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => cleanup());

describe('LaunchpadDiscussionDrawer', () => {
  it('加载主帖、评论与二级回复，恶意 Markdown 被净化，作者评论挂「作者」标签', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    renderDrawer();
    const c1 = await screen.findByTestId('launchpad-comment-DC_1');
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.launchpad-discussion-body strong')?.textContent).toBe('主帖正文');
    const html = c1.innerHTML;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    const reply = screen.getByTestId('launchpad-comment-DC_2');
    expect(within(reply).getByText('作者').className).toBe('status-tag');
    expect(within(c1.querySelector('.launchpad-comment-head') as HTMLElement).queryByText('作者')).toBeNull();
    expect(api.getLaunchpadDiscussion).toHaveBeenCalledWith('superMC5657/z-store-launchpad', 7);
  });

  it('已登录顶帖调用 toggleLaunchpadUpvote 并同步父级计数', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.toggleLaunchpadUpvote.mockResolvedValue({ subject_id: 'D_7', upvote_count: 4, viewer_has_upvoted: true, mode: 'reaction' });
    const props = renderDrawer();
    await screen.findByTestId('launchpad-comment-DC_1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-drawer-upvote'));
    });
    expect(api.toggleLaunchpadUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      subjectId: 'D_7',
      currentlyUpvoted: false,
    });
    expect(props.onUpvoteChange).toHaveBeenCalledWith('acme/hyper', 4, true);
    expect(screen.getByTestId('launchpad-drawer-upvote').textContent).toBe('4');
  });

  it('发表一级评论与二级回复（带 replyToId）并就地上屏', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.addLaunchpadComment
      .mockResolvedValueOnce(comment('DC_9', 'me', 'top level'))
      .mockResolvedValueOnce(comment('DC_10', 'me', 'a reply'));
    const props = renderDrawer();
    await screen.findByTestId('launchpad-comment-DC_1');

    const input = screen.getByTestId('launchpad-comment-input');
    fireEvent.change(input, { target: { value: 'top level' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    });
    expect(api.addLaunchpadComment).toHaveBeenLastCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      discussionId: 'D_7',
      body: 'top level',
      replyToId: undefined,
    });
    expect(await screen.findByTestId('launchpad-comment-DC_9')).toBeTruthy();
    expect(props.onCommentAdded).toHaveBeenCalledWith('acme/hyper');

    fireEvent.click(within(screen.getByTestId('launchpad-comment-DC_1')).getByRole('button', { name: '回复 @bob' }));
    fireEvent.change(screen.getByTestId('launchpad-comment-input'), { target: { value: 'a reply' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-comment-send'));
    });
    expect(api.addLaunchpadComment).toHaveBeenLastCalledWith(expect.objectContaining({ replyToId: 'DC_1', body: 'a reply' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('launchpad-comment-DC_1')).getByTestId('launchpad-comment-DC_10')).toBeTruthy(),
    );
    expect((screen.getByTestId('launchpad-comment-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('未登录不渲染输入框，展示登录与 GitHub 降级入口；顶帖不发写请求', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(
      detail({ auth_required_for_write: true, viewer_can_comment: false, viewer_can_upvote: false }),
    );
    const props = renderDrawer({ oauthUser: null });
    await screen.findByTestId('launchpad-comment-DC_1');
    expect(screen.queryByTestId('launchpad-comment-input')).toBeNull();
    const bar = screen.getByTestId('launchpad-login-bar');
    fireEvent.click(within(bar).getByRole('button', { name: '在 GitHub 网页参与' }));
    expect(api.openUrl).toHaveBeenCalledWith(entry.discussion_url);

    fireEvent.click(screen.getByTestId('launchpad-drawer-upvote'));
    expect(api.toggleLaunchpadUpvote).not.toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: '前往登录' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onOpenAccount).toHaveBeenCalled();
  });

  it('锁帖隐藏输入框并提示只读', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail({ locked: true, viewer_can_comment: false }));
    renderDrawer();
    expect(await screen.findByText('该讨论已被维护者锁定，仅支持浏览')).toBeTruthy();
    expect(screen.queryByTestId('launchpad-comment-input')).toBeNull();
  });

  it('游标分页加载更多评论并去重合并', async () => {
    api.getLaunchpadDiscussion
      .mockResolvedValueOnce(detail({ has_next_page: true, end_cursor: 'CUR' }))
      .mockResolvedValueOnce(detail({ comments: [comment('DC_1', 'bob', 'dup'), comment('DC_3', 'carol', 'page two')] }));
    renderDrawer();
    await screen.findByTestId('launchpad-comment-DC_1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '加载更多评论' }));
    });
    expect(api.getLaunchpadDiscussion).toHaveBeenLastCalledWith('superMC5657/z-store-launchpad', 7, 'CUR');
    expect(await screen.findByTestId('launchpad-comment-DC_3')).toBeTruthy();
    expect(screen.getAllByTestId('launchpad-comment-DC_1')).toHaveLength(1);
  });

  it('点击评论者头像呼起开发者画像，Escape 关闭抽屉', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const props = renderDrawer();
    await screen.findByTestId('launchpad-comment-DC_1');
    fireEvent.click(screen.getByRole('button', { name: '查看 @bob 的主页' }));
    expect(props.onOpenDeveloper).toHaveBeenCalledWith('bob');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });
});
