import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { AppWindow, ArrowBigUp, ExternalLink, LogIn, MessageSquare, Reply, SmilePlus, X } from 'lucide-react';
import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
  LaunchpadReactionContent,
  LaunchpadReactionGroup,
  OAuthUser,
} from '../../types';
import { tauriApi } from '../../services/api';
import { notifyToast } from '../../useToasts';
import { AppIconFrame } from '../../components/AppIconFrame';
import { CachedAvatar } from '../../components/CachedAvatar';
import { CountBadge } from '../../components/CountBadge';
import { VerifiedBadge, resolveVerifiedBadgeVariant } from '../../components/VerifiedBadge';
import { getCategoryLabel } from '../../utils/appHelper';
import { LaunchpadStarButton, formatLaunchedLabel, makerNoteFor } from './LaunchpadCard';
import { DiscussionComposer } from './DiscussionComposer';
import { DiscussionMarkdown } from './DiscussionMarkdown';
import { DISCUSSION_REACTIONS, formatRelativeTime, reactionEmoji } from './discussionFormat';

export interface LaunchpadDiscussionSyncedPayload {
  upvotes: number;
  commentsCount: number;
  viewerHasUpvoted: boolean;
  nodeId?: string;
}

export interface LaunchpadDiscussionModalProps {
  entry: LaunchpadEntry;
  oauthUser: OAuthUser | null;
  /** 已知的本人顶帖态（卡片水合或已顶帖后带入）。 */
  initialUpvoted?: boolean;
  isStarring?: boolean;
  onClose: () => void;
  /** 在讨论之上叠开应用详情弹窗；关闭详情即回到讨论。 */
  onOpenDetail: (id: string) => void;
  onOpenDeveloper: (login: string) => void;
  onOpenAccount: () => void;
  onToggleStar?: (entry: LaunchpadEntry) => void;
  onUpvoteChange: (entryId: string, count: number, upvoted: boolean) => void;
  onCommentAdded: (entryId: string) => void;
  onDiscussionSynced?: (entryId: string, synced: LaunchpadDiscussionSyncedPayload) => void;
}

function mergeComments(
  prev: LaunchpadDiscussionComment[],
  next: LaunchpadDiscussionComment[],
): LaunchpadDiscussionComment[] {
  const seen = new Set(prev.map((c) => c.id));
  return [...prev, ...next.filter((c) => !seen.has(c.id))];
}

function patchComment(
  list: LaunchpadDiscussionComment[],
  id: string,
  patch: (c: LaunchpadDiscussionComment) => LaunchpadDiscussionComment,
): LaunchpadDiscussionComment[] {
  return list.map((c) => (c.id === id ? patch(c) : { ...c, replies: patchComment(c.replies, id, patch) }));
}

/** 弹窗挂载点：与应用详情同处 `.app-body` 层叠上下文，保证详情弹窗能盖在讨论之上。 */
function portalTarget(): HTMLElement {
  return (document.querySelector('.app-body') as HTMLElement | null) ?? document.body;
}

export const LaunchpadDiscussionModal: React.FC<LaunchpadDiscussionModalProps> = ({
  entry,
  oauthUser,
  initialUpvoted = false,
  isStarring = false,
  onClose,
  onOpenDetail,
  onOpenDeveloper,
  onOpenAccount,
  onToggleStar,
  onUpvoteChange,
  onCommentAdded,
  onDiscussionSynced,
}) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<LaunchpadDiscussionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [upvoting, setUpvoting] = useState(false);
  const [upvoteCount, setUpvoteCount] = useState(entry.discussion_upvotes);
  const [upvoted, setUpvoted] = useState(initialUpvoted);
  const [votingComments, setVotingComments] = useState<ReadonlySet<string>>(new Set());
  const [reactingSubjects, setReactingSubjects] = useState<ReadonlySet<string>>(new Set());
  const [openReactionFor, setOpenReactionFor] = useState<string | null>(null);
  const openReactionRef = useRef<string | null>(null);
  openReactionRef.current = openReactionFor;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<{ threadId: string; targetLogin: string; seq: number } | null>(null);
  const [loginNudge, setLoginNudge] = useState(false);

  const app = entry.summary;
  const makerLogin = entry.maker.login || app.owner;
  const loggedIn = Boolean(oauthUser && !oauthUser.is_expired);
  const viewerLogin = loggedIn ? oauthUser?.login : undefined;
  const loggedInRef = useRef(loggedIn);
  loggedInRef.current = loggedIn;
  const authKey = loggedIn ? `1:${oauthUser?.login ?? ''}` : '0';
  const canWrite = loggedIn && detail !== null && !detail.auth_required_for_write;
  const webUrl = detail?.url || entry.discussion_url;
  const isGithub = (app.forge || 'github') === 'github';
  const badgeVariant = resolveVerifiedBadgeVariant(app as { is_verified?: unknown; source?: unknown; status?: unknown });
  const note = makerNoteFor(entry, i18n.language);
  const launchedText = formatLaunchedLabel(entry.launched_at, t);
  const canUpvoteComments = detail ? detail.viewer_can_upvote || detail.auth_required_for_write : false;

  const syncCtxRef = useRef({
    appId: app.id,
    entryUpvotes: entry.discussion_upvotes,
    initialUpvoted,
    onDiscussionSynced,
  });
  syncCtxRef.current = {
    appId: app.id,
    entryUpvotes: entry.discussion_upvotes,
    initialUpvoted,
    onDiscussionSynced,
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    tauriApi
      .getLaunchpadDiscussion(entry.discussion_repo, entry.discussion_number)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        // 匿名空壳无计数口径，保留卡片上的展示值；匿名 REST 缺原生 upvote_count 时不将已知顶帖数降回 0。
        if (d.id) {
          const ctx = syncCtxRef.current;
          const resolvedUpvotes = d.auth_required_for_write
            ? Math.max(ctx.entryUpvotes, d.upvote_count)
            : d.upvote_count;
          const resolvedUpvoted = d.auth_required_for_write
            ? (loggedInRef.current ? ctx.initialUpvoted : false)
            : d.viewer_has_upvoted;
          setUpvoteCount(resolvedUpvotes);
          setUpvoted(resolvedUpvoted);
          if (!d.is_stale) {
            ctx.onDiscussionSynced?.(ctx.appId, {
              upvotes: resolvedUpvotes,
              commentsCount: d.comments_total,
              viewerHasUpvoted: resolvedUpvoted,
              nodeId: d.id,
            });
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.discussion_repo, entry.discussion_number, authKey]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openReactionRef.current) {
        e.stopPropagation();
        setOpenReactionFor(null);
        return;
      }
      // 应用详情 / 开发者画像叠在讨论之上时，Escape 只属于最上层弹窗。
      const panel = panelRef.current;
      const covered = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
        (d) => d !== panel && !panel?.contains(d),
      );
      if (covered) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!openReactionFor) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-reaction-picker]') || target?.closest?.('[data-reaction-trigger]')) return;
      setOpenReactionFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openReactionFor]);

  const openWeb = () => {
    if (webUrl) void tauriApi.openUrl(webUrl);
  };

  const nudgeLogin = () => {
    setLoginNudge(true);
    notifyToast(t('launchpad.login_required'), 'info');
  };

  const handleUpvote = async () => {
    if (!canWrite) {
      nudgeLogin();
      return;
    }
    if (upvoting) return;
    setUpvoting(true);
    try {
      const res = await tauriApi.toggleLaunchpadUpvote({
        discussionRepo: entry.discussion_repo,
        discussionNumber: entry.discussion_number,
        subjectId: detail?.id || entry.discussion_node_id,
        currentlyUpvoted: upvoted,
      });
      setUpvoteCount(res.upvote_count);
      setUpvoted(res.viewer_has_upvoted);
      if (res.mode === 'reaction') {
        setDetail((prev) => {
          if (!prev) return prev;
          const rest = (prev.reaction_groups ?? []).filter((g) => g.content !== 'THUMBS_UP');
          const next =
            res.upvote_count > 0
              ? [{ content: 'THUMBS_UP' as const, count: res.upvote_count, viewer_has_reacted: res.viewer_has_upvoted }, ...rest]
              : rest;
          return { ...prev, reaction_groups: next };
        });
      }
      onUpvoteChange(app.id, res.upvote_count, res.viewer_has_upvoted);
    } catch (e) {
      notifyToast(t('launchpad.upvote_failed', { error: String(e) }), 'error');
    } finally {
      setUpvoting(false);
    }
  };

  const handleToggleReaction = async (
    subjectId: string,
    content: LaunchpadReactionContent,
    currentlyReacted: boolean,
  ) => {
    if (!canWrite) {
      nudgeLogin();
      return;
    }
    if (detail?.locked || reactingSubjects.has(subjectId)) return;
    setOpenReactionFor(null);
    setReactingSubjects((s) => new Set(s).add(subjectId));
    try {
      const groups = await tauriApi.toggleLaunchpadReaction({
        discussionRepo: entry.discussion_repo,
        discussionNumber: entry.discussion_number,
        subjectId,
        content,
        currentlyReacted,
      });
      setDetail((prev) => {
        if (!prev) return prev;
        if (prev.id === subjectId) {
          if (!prev.viewer_can_upvote && content === 'THUMBS_UP') {
            const thumbs = groups.find((g) => g.content === 'THUMBS_UP');
            const nextCount = thumbs?.count ?? 0;
            const nextReacted = thumbs?.viewer_has_reacted ?? false;
            setUpvoteCount(nextCount);
            setUpvoted(nextReacted);
            onUpvoteChange(app.id, nextCount, nextReacted);
          }
          return { ...prev, reaction_groups: groups };
        }
        return {
          ...prev,
          comments: patchComment(prev.comments, subjectId, (x) => ({
            ...x,
            reaction_groups: groups,
          })),
        };
      });
    } catch (e) {
      notifyToast(t('launchpad.reaction_failed', { error: String(e) }), 'error');
    } finally {
      setReactingSubjects((s) => {
        const next = new Set(s);
        next.delete(subjectId);
        return next;
      });
    }
  };

  const handleCommentUpvote = async (c: LaunchpadDiscussionComment) => {
    if (!canWrite) {
      nudgeLogin();
      return;
    }
    if (!canUpvoteComments) return;
    if (votingComments.has(c.id)) return;
    setVotingComments((s) => new Set(s).add(c.id));
    try {
      const res = await tauriApi.toggleLaunchpadCommentUpvote({
        discussionRepo: entry.discussion_repo,
        discussionNumber: entry.discussion_number,
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
  };

  const handleLoadMore = async () => {
    if (!detail?.has_next_page || !detail.end_cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await tauriApi.getLaunchpadDiscussion(
        entry.discussion_repo,
        entry.discussion_number,
        detail.end_cursor,
      );
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
      notifyToast(t('launchpad.load_failed', { error: String(e) }), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending || !detail) return;
    setSending(true);
    try {
      const created = await tauriApi.addLaunchpadComment({
        discussionRepo: entry.discussion_repo,
        discussionNumber: entry.discussion_number,
        discussionId: detail.id || entry.discussion_node_id,
        body,
        replyToId: replyTo?.threadId,
      });
      setDetail((prev) => {
        if (!prev) return prev;
        if (replyTo) {
          return {
            ...prev,
            comments: prev.comments.map((c) =>
              c.id === replyTo.threadId ? { ...c, replies: [...c.replies, created] } : c,
            ),
            comments_total: prev.comments_total + 1,
          };
        }
        return {
          ...prev,
          comments: [...prev.comments, created],
          comments_total: prev.comments_total + 1,
        };
      });
      setDraft('');
      setReplyTo(null);
      onCommentAdded(app.id);
      window.setTimeout(() => {
        const nodes = panelRef.current?.querySelectorAll<HTMLElement>('.launchpad-comment') ?? [];
        Array.from(nodes)
          .find((n) => n.dataset.testid === `launchpad-comment-${created.id}`)
          ?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      }, 30);
    } catch (e) {
      notifyToast(t('launchpad.comment_failed', { error: String(e) }), 'error');
    } finally {
      setSending(false);
    }
  }, [draft, sending, detail, entry, replyTo, onCommentAdded, app.id, t]);

  const goLogin = () => {
    onClose();
    onOpenAccount();
  };

  const timeLabel = (iso: string) => {
    const rel = formatRelativeTime(iso, i18n.language);
    if (!rel) return null;
    const full = new Date(iso).toLocaleString(i18n.language);
    return (
      <time className="launchpad-comment-time" dateTime={iso} title={full}>
        {rel}
      </time>
    );
  };

  const startReply = (threadId: string, target: LaunchpadDiscussionComment, isReply: boolean) => {
    const targetLogin = target.author?.login ?? '';
    setReplyTo((prev) => ({ threadId, targetLogin, seq: (prev?.seq ?? 0) + 1 }));
    if (isReply && targetLogin) {
      setDraft((prev) => {
        const trimmed = prev.trimStart();
        if (!trimmed) return `@${targetLogin} `;
        if (trimmed.toLowerCase().startsWith(`@${targetLogin.toLowerCase()} `)) return prev;
        return `@${targetLogin} ${trimmed}`;
      });
    }
  };

  const renderReactions = (subjectId: string, groups: LaunchpadReactionGroup[] | undefined) => {
    const visible = (groups ?? []).filter((g) => g.count > 0);
    const pickerOpen = openReactionFor === subjectId;
    const busy = reactingSubjects.has(subjectId);
    const locked = Boolean(detail?.locked);
    if (locked && visible.length === 0) return null;
    return (
      <>
        {!locked && (
          <div className="launchpad-reaction-wrap">
            <button
              type="button"
              className={`launchpad-reaction-trigger${pickerOpen ? ' active' : ''}`}
              data-reaction-trigger
              data-testid={`launchpad-reaction-trigger-${subjectId}`}
              aria-expanded={pickerOpen}
              disabled={busy}
              title={t('launchpad.add_reaction')}
              aria-label={t('launchpad.add_reaction')}
              onClick={() => {
                if (!canWrite) {
                  nudgeLogin();
                  return;
                }
                setOpenReactionFor((cur) => (cur === subjectId ? null : subjectId));
              }}
            >
              <SmilePlus size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
            {pickerOpen && (
              <div
                className="launchpad-reaction-popover"
                data-reaction-picker
                role="menu"
                aria-label={t('launchpad.add_reaction')}
              >
                {DISCUSSION_REACTIONS.map((item) => {
                  const current = visible.find((g) => g.content === item.content);
                  const reacted = Boolean(current?.viewer_has_reacted);
                  const label = t(item.labelKey);
                  return (
                    <button
                      key={item.content}
                      type="button"
                      className={`launchpad-reaction-opt${reacted ? ' active' : ''}`}
                      data-testid={`launchpad-reaction-opt-${subjectId}-${item.content}`}
                      aria-pressed={reacted}
                      title={label}
                      aria-label={label}
                      onClick={() => void handleToggleReaction(subjectId, item.content, reacted)}
                    >
                      {item.emoji}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {visible.map((g) => {
          const meta = DISCUSSION_REACTIONS.find((r) => r.content === g.content);
          const label = meta ? t(meta.labelKey) : g.content;
          return (
            <button
              key={g.content}
              type="button"
              className={`launchpad-reaction-pill${g.viewer_has_reacted ? ' active' : ''}`}
              data-testid={`launchpad-reaction-${subjectId}-${g.content}`}
              aria-pressed={g.viewer_has_reacted}
              disabled={locked || busy}
              title={label}
              aria-label={`${label} ${g.count}`}
              onClick={() => void handleToggleReaction(subjectId, g.content, g.viewer_has_reacted)}
            >
              <span>{reactionEmoji(g.content)}</span>
              <span>{g.count}</span>
            </button>
          );
        })}
      </>
    );
  };

  const renderComment = (c: LaunchpadDiscussionComment, isReply: boolean, parentId?: string) => {
    const author = c.author;
    const profileLabel = author ? t('launchpad.maker_profile', { login: author.login }) : '';
    const isMaker = Boolean(author && author.login.toLowerCase() === makerLogin.toLowerCase());
    const voting = votingComments.has(c.id);
    const voteLabel = c.viewer_has_upvoted ? t('launchpad.upvoted') : t('launchpad.upvote');
    const threadId = isReply && parentId ? parentId : c.id;
    return (
      <li
        key={c.id}
        className={`launchpad-comment${isReply ? ' launchpad-comment-reply' : ''}${isMaker ? ' is-maker' : ''}`}
        data-testid={`launchpad-comment-${c.id}`}
      >
        <div className="launchpad-comment-avatar">
          {author ? (
            <button
              type="button"
              className="launchpad-avatar-btn"
              title={profileLabel}
              aria-label={profileLabel}
              onClick={() => onOpenDeveloper(author.login)}
            >
              <CachedAvatar src={author.avatar_url} login={author.login} size={isReply ? 24 : 32} />
            </button>
          ) : (
            <span className="launchpad-avatar-ghost" style={{ width: isReply ? 24 : 32, height: isReply ? 24 : 32 }} />
          )}
        </div>
        <div className="launchpad-comment-main">
          <div className="launchpad-comment-head">
            {author ? (
              <button
                type="button"
                className="launchpad-comment-author"
                title={profileLabel}
                onClick={() => onOpenDeveloper(author.login)}
              >
                @{author.login}
              </button>
            ) : (
              <span className="launchpad-comment-author">{t('launchpad.ghost_user')}</span>
            )}
            {isMaker && <span className="status-tag">{t('launchpad.maker_tag')}</span>}
            {c.created_at && timeLabel(c.created_at)}
          </div>
          <DiscussionMarkdown body={c.body} className="launchpad-comment-body" />
          <div className="launchpad-comment-actions">
            {!isReply && canUpvoteComments && (
              <button
                type="button"
                className={`launchpad-comment-vote${c.viewer_has_upvoted ? ' active' : ''}`}
                data-testid={`launchpad-comment-vote-${c.id}`}
                aria-pressed={c.viewer_has_upvoted}
                disabled={voting}
                title={voteLabel}
                aria-label={voteLabel}
                onClick={() => void handleCommentUpvote(c)}
              >
                <ArrowBigUp
                  size={14}
                  strokeWidth={1.5}
                  fill={c.viewer_has_upvoted ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
                <span>{c.upvote_count}</span>
              </button>
            )}
            {detail?.id && renderReactions(c.id, c.reaction_groups)}
            {canWrite && !detail?.locked && (
              <button
                type="button"
                className="launchpad-comment-reply-btn"
                data-testid={`launchpad-comment-reply-${c.id}`}
                onClick={() => startReply(threadId, c, isReply)}
                aria-label={t('launchpad.reply_to', { login: author?.login ?? '' })}
              >
                <Reply size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('launchpad.reply')}</span>
              </button>
            )}
          </div>
          {c.replies.length > 0 && (
            <ul className="launchpad-replies">{c.replies.map((r) => renderComment(r, true, c.id))}</ul>
          )}
        </div>
      </li>
    );
  };

  const upvoteLabel = upvoted ? t('launchpad.upvoted') : t('launchpad.upvote');
  const starLabel = entry.viewer_has_starred ? t('launchpad.unstar') : t('launchpad.star');

  return createPortal(
    <div
      className="modal-backdrop launchpad-discussion-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        className="detail-modal launchpad-discussion-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="launchpad-dm-header">
          <AppIconFrame size="lg" icon={app.icon} name={app.name} appId={app.id} iconBg={app.icon_bg} />
          <div className="launchpad-dm-heading">
            <div className="launchpad-dm-title">
              <h3 id={titleId}>{app.name}</h3>
              {badgeVariant === 'verified' && <VerifiedBadge size="sm" variant="verified" />}
              {badgeVariant === 'local' && <VerifiedBadge size="sm" variant="local" />}
              {entry.is_pinned && <span className="status-tag">{t('launchpad.spotlight_tag')}</span>}
            </div>
            <div className="launchpad-dm-meta">
              <button
                type="button"
                className="launchpad-maker-link"
                title={t('launchpad.maker_profile', { login: makerLogin })}
                aria-label={t('launchpad.maker_profile', { login: makerLogin })}
                onClick={() => onOpenDeveloper(makerLogin)}
              >
                <CachedAvatar src={entry.maker.avatar_url} login={makerLogin} size={18} />
                <span>@{makerLogin}</span>
              </button>
              {launchedText && <span>· {launchedText}</span>}
              <span>· {getCategoryLabel(app.category, app.category_name, t)}</span>
            </div>
            {note && (
              <p className="launchpad-dm-note" title={note}>
                {note}
              </p>
            )}
            <div className="launchpad-dm-actions">
              <button
                type="button"
                className="btn-fluent btn-primary btn-compact"
                data-testid="launchpad-open-detail"
                onClick={() => onOpenDetail(app.id)}
              >
                <AppWindow size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('launchpad.view_app_detail')}</span>
              </button>
              {isGithub && onToggleStar && (
                <LaunchpadStarButton
                  starred={entry.viewer_has_starred}
                  stars={app.stars}
                  disabled={isStarring}
                  label={starLabel}
                  onClick={() => onToggleStar(entry)}
                />
              )}
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                title={t('launchpad.open_on_github')}
                onClick={openWeb}
              >
                <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('launchpad.open_on_github')}</span>
              </button>
            </div>
          </div>
          <div className="launchpad-dm-side">
            <button
              type="button"
              className="modal-header-btn modal-close-btn"
              title={t('launchpad.close')}
              aria-label={t('launchpad.close')}
              onClick={onClose}
            >
              <X size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`launchpad-vote-box${upvoted ? ' active' : ''}`}
              data-testid="launchpad-discussion-upvote"
              aria-pressed={upvoted}
              disabled={upvoting}
              title={upvoteLabel}
              aria-label={upvoteLabel}
              onClick={handleUpvote}
            >
              <ArrowBigUp
                size={20}
                strokeWidth={1.5}
                fill={upvoted ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
              <span>{upvoteCount}</span>
            </button>
          </div>
        </header>

        <div className="launchpad-dm-body">
          {loading ? (
            <div className="launchpad-dm-skeleton" role="status" aria-label={t('launchpad.loading_discussion')}>
              <span />
              <span />
              <span />
            </div>
          ) : error ? (
            <div className="launchpad-modal-status">
              <p>{t('launchpad.load_failed', { error })}</p>
              <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={openWeb}>
                {t('launchpad.open_on_github')}
              </button>
            </div>
          ) : detail ? (
            <>
              <article className="launchpad-dm-post">
                <div className="launchpad-dm-post-head">
                  <MessageSquare size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>{t('launchpad.post_title')}</span>
                  {detail.created_at && timeLabel(detail.created_at)}
                </div>
                {detail.body ? (
                  <DiscussionMarkdown body={detail.body} className="launchpad-discussion-body" />
                ) : (
                  <div className="launchpad-modal-status">
                    <p>{t('launchpad.read_on_github_hint')}</p>
                    <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={openWeb}>
                      {t('launchpad.open_on_github')}
                    </button>
                  </div>
                )}
                {detail.id && (
                  <div className="launchpad-post-reactions">
                    {renderReactions(detail.id, detail.reaction_groups)}
                  </div>
                )}
              </article>
              <h4 className="launchpad-comments-title">
                <span>{t('launchpad.comments_title')}</span>
                <CountBadge value={detail.comments_total} />
              </h4>
              {detail.comments.length === 0 ? (
                <div className="launchpad-comments-empty">
                  <MessageSquare size={22} strokeWidth={1.25} aria-hidden="true" />
                  <p>{t('launchpad.no_comments')}</p>
                </div>
              ) : (
                <ul className="launchpad-comments">{detail.comments.map((c) => renderComment(c, false))}</ul>
              )}
              {detail.has_next_page && detail.end_cursor && (
                <button
                  type="button"
                  className="btn-fluent btn-secondary btn-compact launchpad-load-more"
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {t('launchpad.load_more_comments')}
                </button>
              )}
            </>
          ) : null}
        </div>

        <footer className="launchpad-dm-footer">
          {detail?.locked ? (
            <p className="launchpad-modal-muted">{t('launchpad.locked_notice')}</p>
          ) : canWrite ? (
            <DiscussionComposer
              draft={draft}
              onDraftChange={setDraft}
              sending={sending}
              onSend={() => void handleSend()}
              viewerLogin={viewerLogin}
              viewerAvatar={oauthUser?.avatar_url ?? undefined}
              replyToLogin={replyTo ? replyTo.targetLogin : null}
              replyKey={replyTo?.seq}
              onCancelReply={() => setReplyTo(null)}
            />
          ) : (
            <div className={`launchpad-login-bar${loginNudge ? ' nudged' : ''}`} data-testid="launchpad-login-bar">
              <span>{t('launchpad.login_bar')}</span>
              <button type="button" className="btn-fluent btn-primary btn-compact" onClick={goLogin}>
                <LogIn size={13} strokeWidth={1.5} aria-hidden="true" />
                <span>{t('launchpad.go_login')}</span>
              </button>
              <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={openWeb}>
                {t('launchpad.join_on_github')}
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>,
    portalTarget(),
  );
};
