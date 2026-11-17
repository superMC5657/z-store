import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadFeedResponse,
  LaunchpadPulseItem,
  LaunchpadUpvoteResult,
} from '../../types';
import { CMD } from '../api';
import { tauriInvoke } from './client';

/** 开源广场清单（后端按需拉取，失败降级本地快照并置 `is_stale`）。 */
export async function getLaunchpadFeed(forceRefresh = false): Promise<LaunchpadFeedResponse> {
  const res = await tauriInvoke<LaunchpadFeedResponse>(CMD.getLaunchpadFeed, { forceRefresh });
  return {
    ...res,
    spotlight: Array.isArray(res?.spotlight) ? res.spotlight : [],
    items: Array.isArray(res?.items) ? res.items : [],
    is_stale: res?.is_stale === true,
  };
}

/** 开源广场卡片讨论脉冲：从 GitHub Discussions 拉取最新顶帖数、评论数、已顶态与源仓统计并落库。 */
export async function syncLaunchpadDiscussions(
  forceRefresh = false,
): Promise<LaunchpadPulseItem[]> {
  const res = await tauriInvoke<LaunchpadPulseItem[]>(CMD.syncLaunchpadDiscussions, {
    forceRefresh,
  });
  return Array.isArray(res) ? res : [];
}

/** 讨论详情：已登录走 GraphQL，未登录为匿名只读降级（`auth_required_for_write`）。 */
export async function getLaunchpadDiscussion(
  discussionRepo: string,
  discussionNumber: number,
  cursor?: string | null,
  forceRefresh = false,
): Promise<LaunchpadDiscussionDetail> {
  return tauriInvoke<LaunchpadDiscussionDetail>(CMD.getLaunchpadDiscussion, {
    discussionRepo,
    discussionNumber,
    ...(cursor ? { cursor } : {}),
    forceRefresh,
  });
}

export interface AddLaunchpadCommentArgs {
  discussionRepo: string;
  discussionNumber: number;
  discussionId?: string | null;
  body: string;
  replyToId?: string | null;
}

export async function addLaunchpadComment(
  args: AddLaunchpadCommentArgs,
): Promise<LaunchpadDiscussionComment> {
  return tauriInvoke<LaunchpadDiscussionComment>(CMD.addLaunchpadComment, {
    discussionRepo: args.discussionRepo,
    discussionNumber: args.discussionNumber,
    discussionId: args.discussionId ?? undefined,
    body: args.body,
    replyToId: args.replyToId ?? undefined,
  });
}

export interface ToggleLaunchpadUpvoteArgs {
  discussionRepo: string;
  discussionNumber: number;
  subjectId?: string | null;
  currentlyUpvoted: boolean;
}

export async function toggleLaunchpadUpvote(
  args: ToggleLaunchpadUpvoteArgs,
): Promise<LaunchpadUpvoteResult> {
  return tauriInvoke<LaunchpadUpvoteResult>(CMD.toggleLaunchpadUpvote, {
    discussionRepo: args.discussionRepo,
    discussionNumber: args.discussionNumber,
    subjectId: args.subjectId ?? undefined,
    currentlyUpvoted: args.currentlyUpvoted,
  });
}
