/**
 * 广场讨论状态：主帖加载 / 强刷序列防竞态、评论游标续拉、匿名 REST 顶帖数夹紧，
 * 评论 / 回复 / 表情 / 顶帖写入的树形纯函数 reducer；加载与写入结果经
 * `LaunchpadFeedActions` 写回广场清单。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../../services/api';
import { notifyToast } from '../../useToasts';
import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
  LaunchpadReactionContent,
  LaunchpadReactionGroup,
  LaunchpadUpvoteResult,
} from '../../types';
import type { DiscussionStatePatch, LaunchpadFeedActions } from './useLaunchpadFeed';

/* ------------------------------------------------------------------ */
/* 纯函数 reducer                                                      */
/* ------------------------------------------------------------------ */

/** 续页评论按 id 去重追加。 */
export function mergeComments(
  prev: LaunchpadDiscussionComment[],
  next: LaunchpadDiscussionComment[],
): LaunchpadDiscussionComment[] {
  const seen = new Set(prev.map((c) => c.id));
  return [...prev, ...next.filter((c) => !seen.has(c.id))];
}

/** 在评论树（含二级回复）中按 id 改写单条评论。 */
export function patchComment(
  list: LaunchpadDiscussionComment[],
  id: string,
  patch: (c: LaunchpadDiscussionComment) => LaunchpadDiscussionComment,
): LaunchpadDiscussionComment[] {
  return list.map((c) => (c.id === id ? patch(c) : { ...c, replies: patchComment(c.replies, id, patch) }));
}

/** 新评论上屏：`threadId` 为一级评论 id 时挂为二级回复，否则追加为一级评论。 */
export function appendComment(
  detail: LaunchpadDiscussionDetail,
  created: LaunchpadDiscussionComment,
  threadId?: string,
): LaunchpadDiscussionDetail {
  const comments = threadId
    ? detail.comments.map((c) => (c.id === threadId ? { ...c, replies: [...c.replies, created] } : c))
    : [...detail.comments, created];
  return { ...detail, comments, comments_total: detail.comments_total + 1 };
}

/** 顶帖降级为 👍 Reaction 时，以返回计数改写主帖的 `THUMBS_UP` 表情组。 */
export function applyThumbsUpFallback(
  detail: LaunchpadDiscussionDetail,
  res: LaunchpadUpvoteResult,
): LaunchpadDiscussionDetail {
  if (res.mode !== 'reaction') return detail;
  const rest = (detail.reaction_groups ?? []).filter((g) => g.content !== 'THUMBS_UP');
  const thumbs: LaunchpadReactionGroup = {
    content: 'THUMBS_UP',
    count: res.upvote_count,
    viewer_has_reacted: res.viewer_has_upvoted,
  };
  return { ...detail, reaction_groups: res.upvote_count > 0 ? [thumbs, ...rest] : rest };
}

/** 表情回应结果写回主帖或评论树。 */
export function applyReactionGroups(
  detail: LaunchpadDiscussionDetail,
  subjectId: string,
  groups: LaunchpadReactionGroup[],
): LaunchpadDiscussionDetail {
  if (detail.id === subjectId) return { ...detail, reaction_groups: groups };
  return {
    ...detail,
    comments: patchComment(detail.comments, subjectId, (c) => ({ ...c, reaction_groups: groups })),
  };
}

/**
 * 主帖顶帖展示值：匿名 REST（`auth_required_for_write`）缺原生顶帖数，只作下界，
 * 不把卡片已知的顶帖数降回 0，本人顶帖态沿用卡片值（未登录恒为 false）。
 */
export function resolveDiscussionVotes(
  d: LaunchpadDiscussionDetail,
  known: { upvotes: number; upvoted: boolean },
  loggedIn: boolean,
): { upvotes: number; upvoted: boolean } {
  if (!d.auth_required_for_write) return { upvotes: d.upvote_count, upvoted: d.viewer_has_upvoted };
  return { upvotes: Math.max(known.upvotes, d.upvote_count), upvoted: loggedIn ? known.upvoted : false };
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

interface UseLaunchpadDiscussionParams {
  entry: LaunchpadEntry;
  loggedIn: boolean;
  /** 登录身份键：变化即重拉讨论。 */
  authKey: string;
  actions: Pick<LaunchpadFeedActions, 'upvote' | 'isUpvoting' | 'patchDiscussionState'>;
}

export function useLaunchpadDiscussion({ entry, loggedIn, authKey, actions }: UseLaunchpadDiscussionParams) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<LaunchpadDiscussionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [upvoteCount, setUpvoteCount] = useState(entry.discussion_upvotes);
  const [upvoted, setUpvoted] = useState(Boolean(entry.viewer_has_upvoted));
  const [votingComments, setVotingComments] = useState<ReadonlySet<string>>(() => new Set());
  const [reactingSubjects, setReactingSubjects] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);

  const appId = entry.summary.id;
  const { discussion_repo: repo, discussion_number: number } = entry;
  const ctxRef = useRef({ entry, loggedIn, actions });
  ctxRef.current = { entry, loggedIn, actions };
  const fetchSeqRef = useRef(0);
  const detailRef = useRef<LaunchpadDiscussionDetail | null>(null);
  detailRef.current = detail;

  const writeBack = useCallback((patch: DiscussionStatePatch) => {
    const { entry: e, actions: a } = ctxRef.current;
    a.patchDiscussionState(e.summary.id, patch);
  }, []);

  const applyDetail = useCallback(
    (d: LaunchpadDiscussionDetail) => {
      setDetail(d);
      // 匿名空壳无计数口径：保留卡片展示值。
      if (!d.id) return;
      const { entry: e, loggedIn: li } = ctxRef.current;
      const votes = resolveDiscussionVotes(
        d,
        { upvotes: e.discussion_upvotes, upvoted: Boolean(e.viewer_has_upvoted) },
        li,
      );
      setUpvoteCount(votes.upvotes);
      setUpvoted(votes.upvoted);
      if (!d.is_stale) {
        writeBack({
          upvotes: votes.upvotes,
          commentsCount: d.comments_total,
          viewerHasUpvoted: votes.upvoted,
          nodeId: d.id,
        });
      }
    },
    [writeBack],
  );

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setRefreshing(false);
    setError(null);
    tauriApi
      .getLaunchpadDiscussion(repo, number)
      .then((d) => {
        if (fetchSeqRef.current === seq) applyDetail(d);
      })
      .catch((e) => {
        if (fetchSeqRef.current === seq) setError(String(e));
      })
      .finally(() => {
        if (fetchSeqRef.current === seq) setLoading(false);
      });
    return () => {
      fetchSeqRef.current += 1;
    };
  }, [repo, number, authKey, applyDetail]);

  const refresh = useCallback(async () => {
    if (loading || refreshing) return;
    const seq = ++fetchSeqRef.current;
    const hadDetail = detailRef.current !== null;
    setRefreshing(true);
    if (!hadDetail) setError(null);
    try {
      const d = await tauriApi.getLaunchpadDiscussion(repo, number, undefined, true);
      if (fetchSeqRef.current !== seq) return;
      setError(null);
      applyDetail(d);
    } catch (e) {
      if (fetchSeqRef.current !== seq) return;
      if (hadDetail) notifyToast(t('launchpad.load_failed', { error: String(e) }), 'error');
      else setError(String(e));
    } finally {
      if (fetchSeqRef.current === seq) setRefreshing(false);
    }
  }, [loading, refreshing, repo, number, applyDetail, t]);

  const loadMore = useCallback(async () => {
    const cur = detailRef.current;
    if (!cur?.has_next_page || !cur.end_cursor || loadingMore) return;
    const seq = fetchSeqRef.current;
    setLoadingMore(true);
    try {
      const page = await tauriApi.getLaunchpadDiscussion(repo, number, cur.end_cursor);
      if (fetchSeqRef.current !== seq) return;
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              comments: mergeComments(prev.comments, page.comments),
              has_next_page: page.has_next_page,
              end_cursor: page.end_cursor,
            }
          : prev,
      );
    } catch (e) {
      if (fetchSeqRef.current === seq) notifyToast(t('launchpad.load_failed', { error: String(e) }), 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, repo, number, t]);

  const toggleUpvote = useCallback(async () => {
    const { entry: e, actions: a } = ctxRef.current;
    const res = await a.upvote(e, {
      subjectId: detailRef.current?.id || e.discussion_node_id,
      currentlyUpvoted: upvoted,
    });
    if (!res) return;
    setUpvoteCount(res.upvote_count);
    setUpvoted(res.viewer_has_upvoted);
    setDetail((prev) => (prev ? applyThumbsUpFallback(prev, res) : prev));
  }, [upvoted]);

  const toggleReaction = useCallback(
    async (subjectId: string, content: LaunchpadReactionContent, currentlyReacted: boolean) => {
      if (reactingSubjects.has(subjectId)) return;
      setReactingSubjects((s) => new Set(s).add(subjectId));
      try {
        const groups = await tauriApi.toggleLaunchpadReaction({
          discussionRepo: repo,
          discussionNumber: number,
          subjectId,
          content,
          currentlyReacted,
        });
        const cur = detailRef.current;
        // 主帖分类不支持原生顶帖时，👍 即顶帖口径。
        if (cur && cur.id === subjectId && !cur.viewer_can_upvote && content === 'THUMBS_UP') {
          const thumbs = groups.find((g) => g.content === 'THUMBS_UP');
          const nextCount = thumbs?.count ?? 0;
          const nextReacted = thumbs?.viewer_has_reacted ?? false;
          setUpvoteCount(nextCount);
          setUpvoted(nextReacted);
          writeBack({ upvotes: nextCount, viewerHasUpvoted: nextReacted });
        }
        setDetail((prev) => (prev ? applyReactionGroups(prev, subjectId, groups) : prev));
      } catch (e) {
        notifyToast(t('launchpad.reaction_failed', { error: String(e) }), 'error');
      } finally {
        setReactingSubjects((s) => {
          const next = new Set(s);
          next.delete(subjectId);
          return next;
        });
      }
    },
    [reactingSubjects, repo, number, writeBack, t],
  );

  const toggleCommentUpvote = useCallback(
    async (c: LaunchpadDiscussionComment) => {
      if (votingComments.has(c.id)) return;
      setVotingComments((s) => new Set(s).add(c.id));
      try {
        const res = await tauriApi.toggleLaunchpadCommentUpvote({
          discussionRepo: repo,
          discussionNumber: number,
          commentId: c.id,
          currentlyUpvoted: c.viewer_has_upvoted,
        });
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                comments: patchComment(prev.comments, c.id, (x) => ({
                  ...x,
                  upvote_count: res.upvote_count,
                  viewer_has_upvoted: res.viewer_has_upvoted,
                })),
              }
            : prev,
        );
      } catch (e) {
        notifyToast(t('launchpad.upvote_failed', { error: String(e) }), 'error');
      } finally {
        setVotingComments((s) => {
          const next = new Set(s);
          next.delete(c.id);
          return next;
        });
      }
    },
    [votingComments, repo, number, t],
  );

  /** 发表评论或回复；成功上屏、写回评论数并返回新评论，失败提示并返回 `null`。 */
  const sendComment = useCallback(
    async (body: string, threadId?: string): Promise<LaunchpadDiscussionComment | null> => {
      const cur = detailRef.current;
      if (!body || sending || !cur) return null;
      setSending(true);
      try {
        const created = await tauriApi.addLaunchpadComment({
          discussionRepo: repo,
          discussionNumber: number,
          discussionId: cur.id || ctxRef.current.entry.discussion_node_id,
          body,
          replyToId: threadId,
        });
        setDetail((prev) => (prev ? appendComment(prev, created, threadId) : prev));
        writeBack({ commentsDelta: 1 });
        return created;
      } catch (e) {
        notifyToast(t('launchpad.comment_failed', { error: String(e) }), 'error');
        return null;
      } finally {
        setSending(false);
      }
    },
    [sending, repo, number, writeBack, t],
  );

  return {
    appId,
    detail,
    loading,
    refreshing,
    error,
    loadingMore,
    upvoteCount,
    upvoted,
    upvoting: actions.isUpvoting(appId),
    votingComments,
    reactingSubjects,
    sending,
    refresh,
    loadMore,
    toggleUpvote,
    toggleReaction,
    toggleCommentUpvote,
    sendComment,
  };
}
