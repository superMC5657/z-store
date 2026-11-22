/** `useLaunchpadDiscussion`：THUMBS_UP 降级、匿名 REST 顶帖数保留与评论树合并。 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
} from '../../types';

const api = vi.hoisted(() => ({
  getLaunchpadDiscussion: vi.fn(),
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

import {
  appendComment,
  applyThumbsUpFallback,
  mergeComments,
  resolveDiscussionVotes,
  useLaunchpadDiscussion,
} from './useLaunchpadDiscussion';

function comment(id: string, replies: LaunchpadDiscussionComment[] = []): LaunchpadDiscussionComment {
  return {
    id,
    body: id,
    created_at: '',
    author_association: 'NONE',
    author: null,
    upvote_count: 0,
    viewer_has_upvoted: false,
    replies,
  };
}

function detail(overrides: Partial<LaunchpadDiscussionDetail> = {}): LaunchpadDiscussionDetail {
  return {
    id: 'D_7',
    number: 7,
    title: '',
    body: '',
    url: '',
    created_at: '',
    locked: false,
    closed: false,
    author: null,
    category_name: '',
    upvote_count: 3,
    viewer_has_upvoted: false,
    viewer_can_upvote: true,
    viewer_can_comment: true,
    auth_required_for_write: false,
    comments_total: 1,
    has_next_page: false,
    end_cursor: null,
    comments: [comment('DC_1')],
    is_stale: false,
    ...overrides,
  };
}

const entry = {
  summary: { id: 'acme/hyper' },
  discussion_repo: 'owner/launchpad',
  discussion_number: 7,
  discussion_node_id: 'D_7',
  discussion_upvotes: 5,
  discussion_comments_count: 1,
  viewer_has_upvoted: true,
} as unknown as LaunchpadEntry;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('讨论树纯函数', () => {
  it('顶帖降级为 👍 Reaction 时改写主帖 THUMBS_UP 组，计数归零则移除', () => {
    const base = detail({ reaction_groups: [{ content: 'HEART', count: 1, viewer_has_reacted: false }] });
    const up = applyThumbsUpFallback(base, { subject_id: 'D_7', upvote_count: 4, viewer_has_upvoted: true, mode: 'reaction' });
    expect(up.reaction_groups).toEqual([
      { content: 'THUMBS_UP', count: 4, viewer_has_reacted: true },
      { content: 'HEART', count: 1, viewer_has_reacted: false },
    ]);
    const down = applyThumbsUpFallback(up, { subject_id: 'D_7', upvote_count: 0, viewer_has_upvoted: false, mode: 'reaction' });
    expect(down.reaction_groups).toEqual([{ content: 'HEART', count: 1, viewer_has_reacted: false }]);
    const native = { subject_id: 'D_7', upvote_count: 9, viewer_has_upvoted: true, mode: 'upvote' as const };
    expect(applyThumbsUpFallback(base, native)).toBe(base);
  });

  it('匿名 REST 顶帖数只作下界，本人顶帖态沿用卡片值（未登录恒 false）', () => {
    const anon = detail({ auth_required_for_write: true, upvote_count: 0, viewer_has_upvoted: false });
    expect(resolveDiscussionVotes(anon, { upvotes: 5, upvoted: true }, true)).toEqual({ upvotes: 5, upvoted: true });
    expect(resolveDiscussionVotes(anon, { upvotes: 5, upvoted: true }, false)).toEqual({ upvotes: 5, upvoted: false });
    const authed = detail({ upvote_count: 2, viewer_has_upvoted: true });
    expect(resolveDiscussionVotes(authed, { upvotes: 5, upvoted: false }, true)).toEqual({ upvotes: 2, upvoted: true });
  });

  it('二级回复挂到所属线程，一级评论追加，续页按 id 去重', () => {
    const base = detail();
    const withReply = appendComment(base, comment('DC_2'), 'DC_1');
    expect(withReply.comments[0].replies.map((c) => c.id)).toEqual(['DC_2']);
    expect(withReply.comments_total).toBe(2);
    const withTop = appendComment(withReply, comment('DC_3'));
    expect(withTop.comments.map((c) => c.id)).toEqual(['DC_1', 'DC_3']);
    expect(mergeComments(withTop.comments, [comment('DC_3'), comment('DC_4')]).map((c) => c.id)).toEqual([
      'DC_1',
      'DC_3',
      'DC_4',
    ]);
  });
});

describe('useLaunchpadDiscussion', () => {
  it('匿名讨论载入保留卡片顶帖数并写回广场', async () => {
    api.getLaunchpadDiscussion.mockResolvedValue(
      detail({ auth_required_for_write: true, upvote_count: 0, comments_total: 4 }),
    );
    const actions = {
      upvote: vi.fn(),
      isUpvoting: () => false,
      patchDiscussionState: vi.fn(),
    };
    const { result } = renderHook(() =>
      useLaunchpadDiscussion({ entry, loggedIn: false, authKey: '0', actions }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.upvoteCount).toBe(5);
    expect(result.current.upvoted).toBe(false);
    expect(actions.patchDiscussionState).toHaveBeenCalledWith('acme/hyper', {
      upvotes: 5,
      commentsCount: 4,
      viewerHasUpvoted: false,
      nodeId: 'D_7',
    });
  });
});
