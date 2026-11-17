import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '../../i18n';
import { ModalShell } from '../../components/ModalShell';
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
  toggleLaunchpadCommentUpvote: vi.fn(),
  toggleLaunchpadReaction: vi.fn(),
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

import { LaunchpadDiscussionModal } from './LaunchpadDiscussionModal';

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

function renderModal(overrides: Partial<React.ComponentProps<typeof LaunchpadDiscussionModal>> = {}) {
  const props = {
    entry,
    oauthUser: user as OAuthUser | null,
    onClose: vi.fn(),
    onOpenDetail: vi.fn(),
    onOpenDeveloper: vi.fn(),
    onOpenAccount: vi.fn(),
    onUpvoteChange: vi.fn(),
    onCommentAdded: vi.fn(),
    ...overrides,
  };
  render(<LaunchpadDiscussionModal {...props} />);
  return props;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => cleanup());

describe('LaunchpadDiscussionModal', () => {
  it('加载主帖、评论与二级回复，恶意 Markdown 被净化，作者评论挂「作者」标签', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    renderModal();
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
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-discussion-upvote'));
    });
    expect(api.toggleLaunchpadUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      subjectId: 'D_7',
      currentlyUpvoted: false,
    });
    expect(props.onUpvoteChange).toHaveBeenCalledWith('acme/hyper', 4, true);
    expect(screen.getByTestId('launchpad-discussion-upvote').textContent).toBe('4');
  });

  it('发表一级评论与二级回复（带 replyToId）并就地上屏', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.addLaunchpadComment
      .mockResolvedValueOnce(comment('DC_9', 'me', 'top level'))
      .mockResolvedValueOnce(comment('DC_10', 'me', 'a reply'));
    const props = renderModal();
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
    const props = renderModal({ oauthUser: null });
    await screen.findByTestId('launchpad-comment-DC_1');
    expect(screen.queryByTestId('launchpad-comment-input')).toBeNull();
    const bar = screen.getByTestId('launchpad-login-bar');
    fireEvent.click(within(bar).getByRole('button', { name: '在 GitHub 网页参与' }));
    expect(api.openUrl).toHaveBeenCalledWith(entry.discussion_url);

    fireEvent.click(screen.getByTestId('launchpad-discussion-upvote'));
    expect(api.toggleLaunchpadUpvote).not.toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: '前往登录' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onOpenAccount).toHaveBeenCalled();
  });

  it('锁帖隐藏输入框并提示只读', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail({ locked: true, viewer_can_comment: false }));
    renderModal();
    expect(await screen.findByText('该讨论已被维护者锁定，仅支持浏览')).toBeTruthy();
    expect(screen.queryByTestId('launchpad-comment-input')).toBeNull();
  });

  it('游标分页加载更多评论并去重合并', async () => {
    api.getLaunchpadDiscussion
      .mockResolvedValueOnce(detail({ has_next_page: true, end_cursor: 'CUR' }))
      .mockResolvedValueOnce(detail({ comments: [comment('DC_1', 'bob', 'dup'), comment('DC_3', 'carol', 'page two')] }));
    renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '加载更多评论' }));
    });
    expect(api.getLaunchpadDiscussion).toHaveBeenLastCalledWith('superMC5657/z-store-launchpad', 7, 'CUR');
    expect(await screen.findByTestId('launchpad-comment-DC_3')).toBeTruthy();
    expect(screen.getAllByTestId('launchpad-comment-DC_1')).toHaveLength(1);
  });

  it('点击评论者头像呼起开发者画像，Escape 关闭讨论弹窗', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    fireEvent.click(screen.getByRole('button', { name: '查看 @bob 的主页' }));
    expect(props.onOpenDeveloper).toHaveBeenCalledWith('bob');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });
  it('「应用详情」按钮在讨论内跳转详情，详情叠在上方时 Escape 不关闭讨论', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    fireEvent.click(screen.getByTestId('launchpad-open-detail'));
    expect(props.onOpenDetail).toHaveBeenCalledWith('acme/hyper');

    const onCloseDetail = vi.fn();
    const overlay = render(
      <ModalShell ariaLabel="detail" onClose={onCloseDetail}>
        <p>detail</p>
      </ModalShell>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseDetail).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    overlay.unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('一级评论可顶帖并就地更新计数；二级回复不显示顶帖按钮', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.toggleLaunchpadCommentUpvote.mockResolvedValue({ subject_id: 'DC_1', upvote_count: 1, viewer_has_upvoted: true, mode: 'upvote' });
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    expect(screen.queryByTestId('launchpad-comment-vote-DC_2')).toBeNull();
    const vote = screen.getByTestId('launchpad-comment-vote-DC_1');
    expect(vote.querySelector('svg')?.getAttribute('fill')).toBe('none');
    await act(async () => {
      fireEvent.click(vote);
    });
    expect(api.toggleLaunchpadCommentUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      commentId: 'DC_1',
      currentlyUpvoted: false,
    });
    expect(screen.getByTestId('launchpad-comment-vote-DC_1').textContent).toBe('1');
    expect(screen.getByTestId('launchpad-comment-vote-DC_1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-comment-vote-DC_1').querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
    expect(api.toggleLaunchpadUpvote).not.toHaveBeenCalled();
    expect(props.onUpvoteChange).not.toHaveBeenCalled();
  });

  it('自己的评论按 GitHub 原始顶帖态展示，并支持取消/切换顶帖', async () => {
    const own = { ...comment('DC_5', 'me', 'my own words'), upvote_count: 3, viewer_has_upvoted: true };
    api.getLaunchpadDiscussion.mockResolvedValue(detail({ comments: [own] }));
    api.toggleLaunchpadCommentUpvote.mockResolvedValue({
      subject_id: 'DC_5',
      upvote_count: 2,
      viewer_has_upvoted: false,
      mode: 'upvote',
    });
    renderModal();
    const vote = await screen.findByTestId('launchpad-comment-vote-DC_5');
    expect(vote.textContent).toBe('3');
    expect(vote.getAttribute('aria-pressed')).toBe('true');
    expect((vote as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(vote);
    });
    expect(api.toggleLaunchpadCommentUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      commentId: 'DC_5',
      currentlyUpvoted: true,
    });
    expect(screen.getByTestId('launchpad-comment-vote-DC_5').textContent).toBe('2');
    expect(screen.getByTestId('launchpad-comment-vote-DC_5').getAttribute('aria-pressed')).toBe('false');
  });

  it('新发表的评论按 GitHub 回包原始顶帖数与状态展示', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.addLaunchpadComment.mockResolvedValue({ ...comment('DC_11', 'me', 'hello'), upvote_count: 1, viewer_has_upvoted: true });
    renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    fireEvent.change(screen.getByTestId('launchpad-comment-input'), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-comment-send'));
    });
    const vote = await screen.findByTestId('launchpad-comment-vote-DC_11');
    expect(vote.textContent).toBe('1');
    expect(vote.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-discussion-upvote').getAttribute('aria-pressed')).toBe('false');
  });

  it('评论支持 Markdown、短码表情与图片，预览页实时渲染', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(
      detail({ comments: [comment('DC_6', 'bob', 'nice :rocket:\n![shot](https://example.com/a.png)')] }),
    );
    renderModal();
    const c = await screen.findByTestId('launchpad-comment-DC_6');
    expect(c.textContent).toContain('🚀');
    expect(c.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    fireEvent.click(c.querySelector('img') as HTMLImageElement);
    expect(api.openUrl).toHaveBeenCalledWith('https://example.com/a.png');

    fireEvent.change(screen.getByTestId('launchpad-comment-input'), { target: { value: '**bold** :tada:' } });
    fireEvent.click(screen.getByRole('tab', { name: '预览' }));
    const preview = screen.getByTestId('launchpad-comment-preview');
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
    expect(preview.textContent).toContain('🎉');
    fireEvent.click(screen.getByRole('tab', { name: '编写' }));
    expect((screen.getByTestId('launchpad-comment-input') as HTMLTextAreaElement).value).toBe('**bold** :tada:');
  });

  it('表情面板与图片链接插入到输入框', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    const input = screen.getByTestId('launchpad-comment-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi ' } });
    input.setSelectionRange(3, 3);
    fireEvent.click(screen.getByTestId('launchpad-emoji-toggle'));
    fireEvent.click(screen.getByRole('option', { name: '🎉' }));
    expect(input.value).toBe('hi 🎉');
    expect(screen.queryByRole('option', { name: '🎉' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(screen.getByTestId('launchpad-image-url'), { target: { value: 'https://example.com/x.png' } });
    fireEvent.click(screen.getByTestId('launchpad-image-insert'));
    expect((screen.getByTestId('launchpad-comment-input') as HTMLTextAreaElement).value).toBe(
      'hi 🎉\n![图片](https://example.com/x.png)\n',
    );
  });

  it('主帖、一级评论与二级回复均支持表情回应（Reaction）按钮与计数切换，Escape 先关浮层', async () => {
    const d = detail({
      reaction_groups: [{ content: 'ROCKET', count: 2, viewer_has_reacted: false }],
      comments: [
        {
          ...comment('DC_1', 'bob', 'nice', [
            {
              ...comment('DC_2', 'acme', 'thanks'),
              reaction_groups: [{ content: 'HEART', count: 1, viewer_has_reacted: true }],
            },
          ]),
          reaction_groups: [{ content: 'THUMBS_UP', count: 1, viewer_has_reacted: false }],
        },
      ],
    });
    api.getLaunchpadDiscussion.mockResolvedValue(d);
    api.toggleLaunchpadReaction
      .mockResolvedValueOnce([
        { content: 'THUMBS_UP', count: 1, viewer_has_reacted: false },
        { content: 'LAUGH', count: 1, viewer_has_reacted: true },
      ])
      .mockResolvedValueOnce([]);
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');

    // 主帖、一级评论、二级回复都有表情按钮和已有回应胶囊
    expect(screen.getByTestId('launchpad-reaction-D_7-ROCKET').textContent).toBe('🚀2');
    expect(screen.getByTestId('launchpad-reaction-DC_1-THUMBS_UP').textContent).toBe('👍1');
    expect(screen.getByTestId('launchpad-reaction-DC_2-HEART').getAttribute('aria-pressed')).toBe('true');

    // 打开一级评论的表情选择面板，按 Escape 只关浮层不关弹窗
    fireEvent.click(screen.getByTestId('launchpad-reaction-trigger-DC_1'));
    expect(screen.getByTestId('launchpad-reaction-opt-DC_1-LAUGH')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('launchpad-reaction-opt-DC_1-LAUGH')).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();

    // 再次打开并点选 😄，然后取消二级回复的 ❤️
    fireEvent.click(screen.getByTestId('launchpad-reaction-trigger-DC_1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-reaction-opt-DC_1-LAUGH'));
    });
    expect(api.toggleLaunchpadReaction).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      subjectId: 'DC_1',
      content: 'LAUGH',
      currentlyReacted: false,
    });
    expect(screen.getByTestId('launchpad-reaction-DC_1-LAUGH').textContent).toBe('😄1');
    expect(screen.getByTestId('launchpad-reaction-DC_1-LAUGH').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-reaction-DC_2-HEART'));
    });
    expect(api.toggleLaunchpadReaction).toHaveBeenLastCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      subjectId: 'DC_2',
      content: 'HEART',
      currentlyReacted: true,
    });
    expect(screen.queryByTestId('launchpad-reaction-DC_2-HEART')).toBeNull();
  });

  it('二级回复支持回复：自动 @ 对方并挂到所属一级线程下发送', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    api.addLaunchpadComment.mockResolvedValue(comment('DC_12', 'me', '@acme 收到'));
    renderModal();
    await screen.findByTestId('launchpad-comment-DC_2');

    fireEvent.click(screen.getByTestId('launchpad-comment-reply-DC_2'));
    expect(screen.getByText('正在回复 @acme')).toBeTruthy();
    const input = screen.getByTestId('launchpad-comment-input') as HTMLTextAreaElement;
    expect(input.value).toBe('@acme ');

    fireEvent.change(input, { target: { value: '@acme 收到' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-comment-send'));
    });

    expect(api.addLaunchpadComment).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 7,
      discussionId: 'D_7',
      body: '@acme 收到',
      replyToId: 'DC_1',
    });
    const parent = screen.getByTestId('launchpad-comment-DC_1');
    expect(within(parent).getByTestId('launchpad-comment-DC_12')).toBeTruthy();
  });

  it('未开启投票的讨论分类隐藏一级评论顶帖按钮，保留表情与回复', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail({ viewer_can_upvote: false }));
    renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');

    expect(screen.queryByTestId('launchpad-comment-vote-DC_1')).toBeNull();
    expect(screen.getByTestId('launchpad-reaction-trigger-DC_1')).toBeTruthy();
    expect(screen.getByTestId('launchpad-comment-reply-DC_1')).toBeTruthy();
  });

  it('讨论弹窗内支持点击刷新按钮强制重拉并更新内容、计数与评论', async () => {
    let resolveInitial!: (v: LaunchpadDiscussionDetail) => void;
    let resolveRefresh!: (v: LaunchpadDiscussionDetail) => void;
    api.getLaunchpadDiscussion
      .mockImplementationOnce(
        () =>
          new Promise<LaunchpadDiscussionDetail>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<LaunchpadDiscussionDetail>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const onDiscussionSynced = vi.fn();
    renderModal({ onDiscussionSynced });

    const refreshBtn = screen.getByTestId('launchpad-discussion-refresh') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
    expect(refreshBtn.querySelector('.icon-spin')).toBeTruthy();

    await act(async () => {
      resolveInitial(detail());
    });
    await screen.findByTestId('launchpad-comment-DC_1');
    expect(refreshBtn.disabled).toBe(false);
    expect(refreshBtn.querySelector('.icon-spin')).toBeNull();

    fireEvent.click(refreshBtn);
    expect(refreshBtn.disabled).toBe(true);
    expect(refreshBtn.querySelector('.icon-spin')).toBeTruthy();
    // 刷新期间保留现有正文与评论，不回退骨架屏
    expect(screen.getByTestId('launchpad-comment-DC_1')).toBeTruthy();
    expect(api.getLaunchpadDiscussion).toHaveBeenLastCalledWith(
      'superMC5657/z-store-launchpad',
      7,
      undefined,
      true,
    );

    await act(async () => {
      resolveRefresh(
        detail({
          body: '**更新后的正文**',
          upvote_count: 8,
          viewer_has_upvoted: true,
          comments_total: 3,
          comments: [
            comment('DC_1', 'bob', 'nice'),
            comment('DC_99', 'carol', 'fresh comment after refresh'),
          ],
        }),
      );
    });

    expect(await screen.findByTestId('launchpad-comment-DC_99')).toBeTruthy();
    expect(document.querySelector('.launchpad-discussion-body strong')?.textContent).toBe('更新后的正文');
    expect(screen.getByTestId('launchpad-discussion-upvote').textContent).toBe('8');
    expect(onDiscussionSynced).toHaveBeenLastCalledWith('acme/hyper', {
      upvotes: 8,
      commentsCount: 3,
      viewerHasUpvoted: true,
      nodeId: 'D_7',
    });
    expect(refreshBtn.disabled).toBe(false);
    expect(refreshBtn.querySelector('.icon-spin')).toBeNull();
  });

  it('讨论弹窗刷新失败时保留已加载内容并恢复刷新按钮可用；首次加载失败后可点击刷新重试成功', async () => {
    api.getLaunchpadDiscussion
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new Error('timeout'));

    renderModal();
    await screen.findByText(/network down/);
    const refreshBtn = screen.getByTestId('launchpad-discussion-refresh') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(false);

    // 首次失败后点击刷新重试成功
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    await screen.findByTestId('launchpad-comment-DC_1');

    // 已加载后再次刷新失败：保留已有内容，按钮恢复可用
    await act(async () => {
      fireEvent.click(refreshBtn);
    });
    expect(screen.getByTestId('launchpad-comment-DC_1')).toBeTruthy();
    expect(refreshBtn.disabled).toBe(false);
    expect(refreshBtn.querySelector('.icon-spin')).toBeNull();
  });

  it('挂载到 .app-window 层叠上下文以覆盖标题栏虚化，不局限在 .app-body 内', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const appWindow = document.createElement('div');
    appWindow.className = 'app-window';
    const titlebar = document.createElement('div');
    titlebar.className = 'titlebar';
    const appBody = document.createElement('div');
    appBody.className = 'app-body';
    appWindow.append(titlebar, appBody);
    document.body.appendChild(appWindow);

    try {
      renderModal();
      await screen.findByTestId('launchpad-comment-DC_1');
      const backdrop = appWindow.querySelector('.modal-backdrop.modal-layer-sub');
      expect(backdrop).toBeTruthy();
      expect(backdrop?.parentElement).toBe(appWindow);
      expect(appBody.querySelector('.modal-backdrop.modal-layer-sub')).toBeNull();
    } finally {
      appWindow.remove();
    }
  });

  it('真实 .app-window 布局下应用详情（base 层）叠在讨论（sub 层）之上，Esc 逐层关闭', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const appWindow = document.createElement('div');
    appWindow.className = 'app-window';
    const appBody = document.createElement('div');
    appBody.className = 'app-body';
    appWindow.append(appBody);
    document.body.appendChild(appWindow);

    try {
      const props = renderModal();
      await screen.findByTestId('launchpad-comment-DC_1');
      const onCloseDetail = vi.fn();
      const overlay = render(
        <ModalShell ariaLabel="detail" onClose={onCloseDetail}>
          <p>detail</p>
        </ModalShell>,
        { container: appBody },
      );

      const backdrops = Array.from(appWindow.querySelectorAll(':scope > .modal-backdrop'));
      expect(backdrops).toHaveLength(2);
      expect(backdrops[0].classList.contains('modal-layer-sub')).toBe(true);
      expect(Array.from(backdrops[1].classList)).toEqual(['modal-backdrop']);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onCloseDetail).toHaveBeenCalledTimes(1);
      expect(props.onClose).not.toHaveBeenCalled();
      overlay.unmount();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    } finally {
      appWindow.remove();
    }
  });

  it('在面板内按下、松开到遮罩上不关闭讨论；按下与松开都在遮罩上才关闭', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(detail());
    const props = renderModal();
    await screen.findByTestId('launchpad-comment-DC_1');
    const backdrop = document.querySelector('.modal-backdrop.modal-layer-sub') as HTMLElement;
    fireEvent.mouseDown(screen.getByTestId('launchpad-comment-DC_1'));
    fireEvent.click(backdrop);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
