import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { marked } from 'marked';
import { ArrowBigUp, ExternalLink, LogIn, Reply, X } from 'lucide-react';
import type {
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
  OAuthUser,
} from '../../types';
import { tauriApi } from '../../services/api';
import { sanitizeHtml } from '../../utils/sanitize';
import { notifyToast } from '../../useToasts';
import { AppIconFrame } from '../../components/AppIconFrame';
import { CachedAvatar } from '../../components/CachedAvatar';
import { makerNoteFor } from './LaunchpadCard';

export interface LaunchpadDiscussionDrawerProps {
  entry: LaunchpadEntry;
  oauthUser: OAuthUser | null;
  /** 已知的本人顶帖态（卡片上顶过即带入）。 */
  initialUpvoted?: boolean;
  onClose: () => void;
  onOpenDeveloper: (login: string) => void;
  onOpenAccount: () => void;
  onUpvoteChange: (entryId: string, count: number, upvoted: boolean) => void;
  onCommentAdded: (entryId: string) => void;
}

/** Markdown → 净化 HTML（统一经 `sanitizeHtml` 白名单）。 */
export function renderDiscussionMarkdown(body: string): string {
  const text = body?.trim();
  if (!text) return '';
  return sanitizeHtml(marked.parse(text, { async: false }) as string);
}

const MarkdownBody: React.FC<{ body: string; className?: string }> = ({ body, className }) => {
  const html = useMemo(() => renderDiscussionMarkdown(body), [body]);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) void tauriApi.openUrl(href);
  };
  if (!html) return null;
  return (
    <div
      className={`readme-markdown-body launchpad-markdown ${className ?? ''}`.trim()}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

function mergeComments(
  prev: LaunchpadDiscussionComment[],
  next: LaunchpadDiscussionComment[],
): LaunchpadDiscussionComment[] {
  const seen = new Set(prev.map((c) => c.id));
  return [...prev, ...next.filter((c) => !seen.has(c.id))];
}

export const LaunchpadDiscussionDrawer: React.FC<LaunchpadDiscussionDrawerProps> = ({
  entry,
  oauthUser,
  initialUpvoted = false,
  onClose,
  onOpenDeveloper,
  onOpenAccount,
  onUpvoteChange,
  onCommentAdded,
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
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<LaunchpadDiscussionComment | null>(null);
  const [loginNudge, setLoginNudge] = useState(false);

  const app = entry.summary;
  const makerLogin = (entry.maker.login || app.owner).toLowerCase();
  const loggedIn = Boolean(oauthUser && !oauthUser.is_expired);
  const canWrite = loggedIn && detail !== null && !detail.auth_required_for_write;
  const webUrl = detail?.url || entry.discussion_url;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    tauriApi
      .getLaunchpadDiscussion(entry.discussion_repo, entry.discussion_number)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        // 匿名空壳无计数口径，保留卡片上的展示值。
        if (d.id) setUpvoteCount(d.upvote_count);
        if (!d.auth_required_for_write) setUpvoted(d.viewer_has_upvoted);
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
  }, [entry.discussion_repo, entry.discussion_number]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const openWeb = () => {
    if (webUrl) void tauriApi.openUrl(webUrl);
  };

  const handleUpvote = async () => {
    if (!canWrite) {
      setLoginNudge(true);
      notifyToast(t('launchpad.login_required'), 'info');
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
      onUpvoteChange(app.id, res.upvote_count, res.viewer_has_upvoted);
    } catch (e) {
      notifyToast(t('launchpad.upvote_failed', { error: String(e) }), 'error');
    } finally {
      setUpvoting(false);
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
        replyToId: replyTo?.id,
      });
      setDetail((prev) => {
        if (!prev) return prev;
        if (replyTo) {
          return {
            ...prev,
            comments: prev.comments.map((c) =>
              c.id === replyTo.id ? { ...c, replies: [...c.replies, created] } : c,
            ),
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

  const renderAuthor = (author: LaunchpadDiscussionComment['author'], size: number) => {
    if (!author) {
      return <span className="launchpad-comment-author">{t('launchpad.ghost_user')}</span>;
    }
    const label = t('launchpad.maker_profile', { login: author.login });
    return (
      <button
        type="button"
        className="launchpad-maker-link launchpad-comment-author"
        title={label}
        aria-label={label}
        onClick={() => onOpenDeveloper(author.login)}
      >
        <CachedAvatar src={author.avatar_url} login={author.login} size={size} />
        <span>@{author.login}</span>
      </button>
    );
  };

  const renderComment = (c: LaunchpadDiscussionComment, isReply: boolean) => (
    <li key={c.id} className={`launchpad-comment${isReply ? ' launchpad-comment-reply' : ''}`} data-testid={`launchpad-comment-${c.id}`}>
      <div className="launchpad-comment-head">
        {renderAuthor(c.author, isReply ? 20 : 24)}
        {c.author && c.author.login.toLowerCase() === makerLogin && (
          <span className="status-tag">{t('launchpad.maker_tag')}</span>
        )}
        {c.created_at && (
          <span className="launchpad-comment-time">{new Date(c.created_at).toLocaleDateString(i18n.language)}</span>
        )}
        {!isReply && canWrite && !detail?.locked && (
          <button
            type="button"
            className="btn-fluent btn-ghost btn-compact"
            onClick={() => setReplyTo(c)}
            aria-label={t('launchpad.reply_to', { login: c.author?.login ?? '' })}
          >
            <Reply size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{t('launchpad.reply')}</span>
          </button>
        )}
      </div>
      <MarkdownBody body={c.body} />
      {c.replies.length > 0 && (
        <ul className="launchpad-replies">{c.replies.map((r) => renderComment(r, true))}</ul>
      )}
    </li>
  );

  // 挂到 body：视图入场动画的 transform 会把 fixed 定位困在内容区里。
  return createPortal(
    <div className="launchpad-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="launchpad-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="launchpad-drawer-header">
          <AppIconFrame size="md" icon={app.icon} name={app.name} appId={app.id} iconBg={app.icon_bg} />
          <div className="launchpad-drawer-title">
            <h3 id={titleId}>{app.name}</h3>
            <p title={makerNoteFor(entry, i18n.language)}>{makerNoteFor(entry, i18n.language)}</p>
          </div>
          <div className="launchpad-drawer-header-actions">
            <button
              type="button"
              className={`btn-fluent btn-secondary btn-compact launchpad-action${upvoted ? ' active' : ''}`}
              data-testid="launchpad-drawer-upvote"
              aria-pressed={upvoted}
              disabled={upvoting}
              title={upvoted ? t('launchpad.upvoted') : t('launchpad.upvote')}
              aria-label={upvoted ? t('launchpad.upvoted') : t('launchpad.upvote')}
              onClick={handleUpvote}
            >
              <ArrowBigUp size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>{upvoteCount}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact btn-icon-only"
              title={t('launchpad.open_on_github')}
              aria-label={t('launchpad.open_on_github')}
              onClick={openWeb}
            >
              <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-fluent btn-ghost btn-compact btn-icon-only"
              title={t('launchpad.close')}
              aria-label={t('launchpad.close')}
              onClick={onClose}
            >
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="launchpad-drawer-body">
          {loading ? (
            <div className="launchpad-drawer-status" role="status">{t('launchpad.loading_discussion')}</div>
          ) : error ? (
            <div className="launchpad-drawer-status">
              <p>{t('launchpad.load_failed', { error })}</p>
              <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={openWeb}>
                {t('launchpad.open_on_github')}
              </button>
            </div>
          ) : detail ? (
            <>
              {detail.body ? (
                <MarkdownBody body={detail.body} className="launchpad-discussion-body" />
              ) : (
                <div className="launchpad-drawer-status">
                  <p>{t('launchpad.read_on_github_hint')}</p>
                  <button type="button" className="btn-fluent btn-secondary btn-compact" onClick={openWeb}>
                    {t('launchpad.open_on_github')}
                  </button>
                </div>
              )}
              <h4 className="launchpad-comments-title">{t('launchpad.comments_title')}</h4>
              {detail.comments.length === 0 ? (
                <p className="launchpad-drawer-muted">{t('launchpad.no_comments')}</p>
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

        <footer className="launchpad-drawer-footer">
          {detail?.locked ? (
            <p className="launchpad-drawer-muted">{t('launchpad.locked_notice')}</p>
          ) : canWrite ? (
            <div className="launchpad-composer">
              {replyTo && (
                <div className="launchpad-replying">
                  <span>{t('launchpad.replying_to', { login: replyTo.author?.login ?? '' })}</span>
                  <button
                    type="button"
                    className="btn-fluent btn-ghost btn-compact btn-icon-only"
                    aria-label={t('launchpad.cancel_reply')}
                    title={t('launchpad.cancel_reply')}
                    onClick={() => setReplyTo(null)}
                  >
                    <X size={12} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>
              )}
              <textarea
                className="launchpad-composer-input"
                data-testid="launchpad-comment-input"
                value={draft}
                maxLength={10000}
                placeholder={t('launchpad.comment_placeholder')}
                aria-label={t('launchpad.comment_placeholder')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                type="button"
                className="btn-fluent btn-primary btn-compact"
                data-testid="launchpad-comment-send"
                disabled={sending || !draft.trim()}
                onClick={() => void handleSend()}
              >
                {t('launchpad.send_comment')}
              </button>
            </div>
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
    document.body,
  );
};
