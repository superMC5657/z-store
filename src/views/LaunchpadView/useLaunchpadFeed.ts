/**
 * 开源广场清单状态：清单加载与后台脉冲合并、`mutationVer` 版本栅栏、一键 Star、
 * 卡片与讨论弹窗共用的顶帖动作，以及讨论状态的唯一写回口 `patchDiscussionState`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tauriApi } from '../../services/api';
import { notifyToast } from '../../useToasts';
import { zlogWarn } from '../../lib/z-log';
import type {
  LaunchpadEntry,
  LaunchpadFeedResponse,
  LaunchpadPulseItem,
  LaunchpadUpvoteResult,
} from '../../types';

/** 讨论状态补丁（`commentsDelta` 在当前评论数上累加）。 */
export interface DiscussionStatePatch {
  nodeId?: string;
  upvotes?: number;
  commentsCount?: number;
  commentsDelta?: number;
  viewerHasUpvoted?: boolean;
}

/** 顶帖参数：缺省取条目上的节点 id 与本人顶帖态。 */
export interface UpvoteOptions {
  subjectId?: string | null;
  currentlyUpvoted?: boolean;
}

/** 卡片与讨论弹窗共用的广场写动作。 */
export interface LaunchpadFeedActions {
  isStarring(id: string): boolean;
  isUpvoting(id: string): boolean;
  toggleStar(entry: LaunchpadEntry): Promise<void>;
  /** 顶帖 / 取消：成功写回清单并返回结果；失败提示并返回 `null`。 */
  upvote(entry: LaunchpadEntry, opts?: UpvoteOptions): Promise<LaunchpadUpvoteResult | null>;
  patchDiscussionState(id: string, patch: DiscussionStatePatch): void;
}

export interface LaunchpadFeedState extends LaunchpadFeedActions {
  feed: LaunchpadFeedResponse | null;
  allEntries: LaunchpadEntry[];
  loading: boolean;
  error: string | null;
  load(forceRefresh: boolean): void;
}

interface UseLaunchpadFeedParams {
  loggedIn: boolean;
  /** 登录身份键：变化即重拉清单。 */
  authKey: string;
  /** 未登录 Star 时引导账号设置。 */
  onRequireLogin: () => void;
}

type EntryPatch = (e: LaunchpadEntry) => LaunchpadEntry;

function patchFeedEntry(
  feed: LaunchpadFeedResponse | null,
  id: string,
  patch: EntryPatch,
): LaunchpadFeedResponse | null {
  if (!feed) return feed;
  const key = id.toLowerCase();
  const apply = (list: LaunchpadEntry[]) => list.map((e) => (e.summary.id.toLowerCase() === key ? patch(e) : e));
  return { ...feed, spotlight: apply(feed.spotlight), items: apply(feed.items) };
}

/** 讨论补丁应用到条目（未登录时本人顶帖态恒为 false）。 */
export function applyDiscussionPatch(e: LaunchpadEntry, patch: DiscussionStatePatch, loggedIn: boolean): LaunchpadEntry {
  const comments =
    patch.commentsCount ??
    (patch.commentsDelta ? Math.max(0, e.discussion_comments_count + patch.commentsDelta) : e.discussion_comments_count);
  return {
    ...e,
    discussion_node_id: patch.nodeId || e.discussion_node_id,
    discussion_upvotes: patch.upvotes ?? e.discussion_upvotes,
    discussion_comments_count: comments,
    viewer_has_upvoted: loggedIn ? (patch.viewerHasUpvoted ?? e.viewer_has_upvoted) : false,
  };
}

/** 后台脉冲并入条目：局部缺失的计数保留原值。 */
export function mergePulse(e: LaunchpadEntry, p: LaunchpadPulseItem, loggedIn: boolean): LaunchpadEntry {
  return {
    ...e,
    discussion_node_id: p.discussion_node_id ?? e.discussion_node_id,
    discussion_upvotes: p.discussion_upvotes ?? e.discussion_upvotes,
    discussion_comments_count: p.discussion_comments_count ?? e.discussion_comments_count,
    viewer_has_upvoted: loggedIn ? (p.viewer_has_upvoted ?? e.viewer_has_upvoted) : false,
    viewer_has_starred:
      loggedIn && p.viewer_has_starred !== undefined && p.viewer_has_starred !== null
        ? p.viewer_has_starred
        : e.viewer_has_starred,
    summary: {
      ...e.summary,
      stars: p.stars ?? e.summary.stars,
      forks: p.forks ?? e.summary.forks,
      latest_version: p.latest_version || e.summary.latest_version,
    },
  };
}

function withId(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function hasDiscussion(entry: LaunchpadEntry): boolean {
  return entry.discussion_number > 0 && entry.discussion_repo.trim() !== '';
}

export function useLaunchpadFeed({ loggedIn, authKey, onRequireLogin }: UseLaunchpadFeedParams): LaunchpadFeedState {
  const { t } = useTranslation();
  const [feed, setFeed] = useState<LaunchpadFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starring, setStarring] = useState<ReadonlySet<string>>(() => new Set());
  const [upvoting, setUpvoting] = useState<ReadonlySet<string>>(() => new Set());
  const reqRef = useRef(0);
  /** 每条目本地写入版本：后台脉冲只覆盖其发起后未被本地改写的条目。 */
  const mutationVerRef = useRef<Map<string, number>>(new Map());
  const loggedInRef = useRef(loggedIn);
  loggedInRef.current = loggedIn;
  const starringRef = useRef(starring);
  starringRef.current = starring;
  const upvotingRef = useRef(upvoting);
  upvotingRef.current = upvoting;
  const onRequireLoginRef = useRef(onRequireLogin);
  onRequireLoginRef.current = onRequireLogin;

  const writeEntry = useCallback((id: string, patch: EntryPatch) => {
    const key = id.toLowerCase();
    mutationVerRef.current.set(key, (mutationVerRef.current.get(key) ?? 0) + 1);
    setFeed((f) => patchFeedEntry(f, id, patch));
  }, []);

  const patchDiscussionState = useCallback(
    (id: string, patch: DiscussionStatePatch) => {
      writeEntry(id, (e) => applyDiscussionPatch(e, patch, loggedInRef.current));
    },
    [writeEntry],
  );

  const load = useCallback((forceRefresh: boolean) => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    tauriApi
      .getLaunchpadFeed(forceRefresh)
      .then((res) => {
        if (reqRef.current !== req) return;
        setFeed(res);
        if (res.spotlight.length + res.items.length === 0) return;
        const snapVer = new Map(mutationVerRef.current);
        void tauriApi
          .syncLaunchpadDiscussions(forceRefresh)
          .then((pulses) => {
            if (reqRef.current !== req || pulses.length === 0) return;
            const byId = new Map(pulses.map((p) => [p.id.toLowerCase(), p]));
            const merge = (list: LaunchpadEntry[]) =>
              list.map((e) => {
                const key = e.summary.id.toLowerCase();
                const p = byId.get(key);
                const untouched = (mutationVerRef.current.get(key) ?? 0) === (snapVer.get(key) ?? 0);
                return p && untouched ? mergePulse(e, p, loggedInRef.current) : e;
              });
            setFeed((prev) => (prev ? { ...prev, spotlight: merge(prev.spotlight), items: merge(prev.items) } : prev));
          })
          .catch((err) => {
            zlogWarn(`[launchpad] syncLaunchpadDiscussions failed: ${String(err)}`);
          });
      })
      .catch((e) => {
        if (reqRef.current !== req) return;
        setError(String(e));
      })
      .finally(() => {
        if (reqRef.current === req) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load, authKey]);

  const toggleStar = useCallback(
    async (entry: LaunchpadEntry) => {
      const id = entry.summary.id;
      if (!loggedInRef.current) {
        notifyToast(t('launchpad.login_required'), 'info');
        onRequireLoginRef.current();
        return;
      }
      if (starringRef.current.has(id)) return;
      setStarring((s) => withId(s, id, true));
      const wasStarred = entry.viewer_has_starred;
      try {
        if (wasStarred) await tauriApi.unstarApp(id);
        else {
          const res = await tauriApi.starApp(id);
          if (res?.warning) notifyToast(res.warning, 'warning');
        }
        writeEntry(id, (e) => ({
          ...e,
          viewer_has_starred: !wasStarred,
          summary: { ...e.summary, stars: Math.max(0, e.summary.stars + (wasStarred ? -1 : 1)) },
        }));
      } catch (e) {
        notifyToast(t('launchpad.star_failed', { error: String(e) }), 'error');
      } finally {
        setStarring((s) => withId(s, id, false));
      }
    },
    [t, writeEntry],
  );

  const upvote = useCallback(
    async (entry: LaunchpadEntry, opts?: UpvoteOptions): Promise<LaunchpadUpvoteResult | null> => {
      const id = entry.summary.id;
      if (upvotingRef.current.has(id)) return null;
      setUpvoting((s) => withId(s, id, true));
      try {
        const res = await tauriApi.toggleLaunchpadUpvote({
          discussionRepo: entry.discussion_repo,
          discussionNumber: entry.discussion_number,
          subjectId: opts?.subjectId || entry.discussion_node_id,
          currentlyUpvoted: opts?.currentlyUpvoted ?? Boolean(entry.viewer_has_upvoted),
        });
        patchDiscussionState(id, { upvotes: res.upvote_count, viewerHasUpvoted: res.viewer_has_upvoted });
        return res;
      } catch (e) {
        notifyToast(t('launchpad.upvote_failed', { error: String(e) }), 'error');
        return null;
      } finally {
        setUpvoting((s) => withId(s, id, false));
      }
    },
    [patchDiscussionState, t],
  );

  const allEntries = useMemo(() => (feed ? [...feed.spotlight, ...feed.items] : []), [feed]);
  const isStarring = useCallback((id: string) => starring.has(id), [starring]);
  const isUpvoting = useCallback((id: string) => upvoting.has(id), [upvoting]);

  return {
    feed,
    allEntries,
    loading,
    error,
    load,
    isStarring,
    isUpvoting,
    toggleStar,
    upvote,
    patchDiscussionState,
  };
}
