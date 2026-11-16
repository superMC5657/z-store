import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { BookOpen, FilePlus, Megaphone, Pin, Plus, RefreshCw, Rocket, WifiOff } from 'lucide-react';
import { tauriApi } from '../services/api';
import { notifyToast } from '../useToasts';
import { CountBadge } from '../components/CountBadge';
import { SegmentedControl } from '../components/SegmentedControl';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { FilterEmptyState, ViewShell } from './ViewShell';
import { LaunchpadCard } from './LaunchpadView/LaunchpadCard';
import { LaunchpadDiscussionDrawer } from './LaunchpadView/LaunchpadDiscussionDrawer';
import { sortLaunchpadItems } from './LaunchpadView/sortLaunchpad';
import {
  matchPlatformSetWithLoading,
  isPlatformLoading,
  type PlatformId,
} from '../lib/platformFilter';
import {
  hasIdAliasMatch,
  isInstalled as selectIsInstalled,
  selectManagedState,
  selectPlatformCounts,
} from '../app/selectors';
import { useMoveInToDraft } from '../app/hooks/useMoveInToDraft';
import { queueAssembledRowIcons } from '../services/iconStore';
import type {
  LaunchpadEntry,
  LaunchpadFeedResponse,
  LaunchpadSortMode,
  OAuthUser,
} from '../types';

export interface LaunchpadViewProps {
  selectedPlatforms: ReadonlySet<PlatformId>;
  platformResolvedOtherIds?: ReadonlySet<string>;
  installedIds: Set<string>;
  installingIds?: Set<string>;
  managedIds?: Set<string> | null;
  customIds?: ReadonlySet<string>;
  oauthUser: OAuthUser | null;
  /** 深链定位的新品 id（高亮并滚动到卡片后经 `onFocusConsumed` 清除）。 */
  focusAppId?: string | null;
  onFocusConsumed?: () => void;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onOpenDeveloper: (login: string) => void;
  onOpenAccount: () => void;
  onResetPlatformFilter: () => void;
  /** 向侧栏上报广场全量条目（置顶 ∪ 新品流）的平台分布；卸载时上报 `null`。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function patchEntry(
  feed: LaunchpadFeedResponse | null,
  id: string,
  patch: (e: LaunchpadEntry) => LaunchpadEntry,
): LaunchpadFeedResponse | null {
  if (!feed) return feed;
  const key = id.toLowerCase();
  const apply = (list: LaunchpadEntry[]) =>
    list.map((e) => (e.summary.id.toLowerCase() === key ? patch(e) : e));
  return { ...feed, spotlight: apply(feed.spotlight), items: apply(feed.items) };
}

export const LaunchpadView: React.FC<LaunchpadViewProps> = ({
  selectedPlatforms,
  platformResolvedOtherIds = EMPTY_SET,
  installedIds,
  installingIds,
  managedIds = null,
  customIds,
  oauthUser,
  focusAppId,
  onFocusConsumed,
  onOpenDetail,
  onQuickInstall,
  onOpenDeveloper,
  onOpenAccount,
  onResetPlatformFilter,
  onDisplayPlatformCounts,
}) => {
  const { t } = useTranslation();
  const [feed, setFeed] = useState<LaunchpadFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<LaunchpadSortMode>('recommended');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [starring, setStarring] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [upvoting, setUpvoting] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [upvoted, setUpvoted] = useState<Record<string, boolean>>({});
  const [discussionEntry, setDiscussionEntry] = useState<LaunchpadEntry | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const reqRef = useRef(0);
  const { isMovingIn, handleMoveIn } = useMoveInToDraft();

  const loggedIn = Boolean(oauthUser && !oauthUser.is_expired);

  const load = useCallback((forceRefresh: boolean) => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    tauriApi
      .getLaunchpadFeed(forceRefresh)
      .then((res) => {
        if (reqRef.current !== req) return;
        setFeed(res);
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
  }, [load]);

  const allEntries = useMemo(
    () => (feed ? [...feed.spotlight, ...feed.items] : []),
    [feed],
  );

  useEffect(() => {
    queueAssembledRowIcons(allEntries.map((e) => e.summary));
  }, [allEntries]);

  // 侧栏平台芯片：广场全量条目分布（不随平台勾选变化），离开视图恢复全库分布。
  const platformCounts = useMemo(
    () => (feed ? selectPlatformCounts(allEntries.map((e) => e.summary), platformResolvedOtherIds) : null),
    [feed, allEntries, platformResolvedOtherIds],
  );
  const reportRef = useRef(onDisplayPlatformCounts);
  reportRef.current = onDisplayPlatformCounts;
  useEffect(() => {
    if (platformCounts) reportRef.current?.(platformCounts);
  }, [platformCounts]);
  useEffect(() => () => reportRef.current?.(null), []);

  const matches = useCallback(
    (e: LaunchpadEntry) =>
      matchPlatformSetWithLoading(e.summary, selectedPlatforms as ReadonlySet<string>, platformResolvedOtherIds),
    [selectedPlatforms, platformResolvedOtherIds],
  );
  const visibleSpotlight = useMemo(() => (feed ? feed.spotlight.filter(matches) : []), [feed, matches]);
  const visibleRecent = useMemo(
    () => (feed ? sortLaunchpadItems(feed.items.filter(matches), sortMode) : []),
    [feed, matches, sortMode],
  );

  // 深链定位：数据就绪后高亮并滚动到对应卡片。
  useEffect(() => {
    if (!focusAppId || !feed) return;
    const key = focusAppId.toLowerCase();
    setHighlightId(key);
    onFocusConsumed?.();
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-launchpad-id="${CSS.escape(key)}"]`);
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 60);
    const clear = window.setTimeout(() => setHighlightId(null), 4000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [focusAppId, feed, onFocusConsumed]);

  const addTo = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
  const removeFrom = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    next.delete(id);
    return next;
  };

  const handleToggleStar = async (entry: LaunchpadEntry) => {
    const id = entry.summary.id;
    if (!loggedIn) {
      notifyToast(t('launchpad.login_required'), 'info');
      onOpenAccount();
      return;
    }
    if (starring.has(id)) return;
    setStarring((s) => addTo(s, id));
    const wasStarred = entry.viewer_has_starred;
    try {
      if (wasStarred) await tauriApi.unstarApp(id);
      else {
        const res = await tauriApi.starApp(id);
        if (res?.warning) notifyToast(res.warning, 'warning');
      }
      setFeed((f) =>
        patchEntry(f, id, (e) => ({
          ...e,
          viewer_has_starred: !wasStarred,
          summary: { ...e.summary, stars: Math.max(0, e.summary.stars + (wasStarred ? -1 : 1)) },
        })),
      );
    } catch (e) {
      notifyToast(t('launchpad.star_failed', { error: String(e) }), 'error');
    } finally {
      setStarring((s) => removeFrom(s, id));
    }
  };

  const applyUpvote = useCallback((id: string, count: number, mine: boolean) => {
    setFeed((f) => patchEntry(f, id, (e) => ({ ...e, discussion_upvotes: count })));
    setUpvoted((u) => ({ ...u, [id.toLowerCase()]: mine }));
  }, []);

  const handleCommentAdded = useCallback((id: string) => {
    setFeed((f) =>
      patchEntry(f, id, (e) => ({ ...e, discussion_comments_count: e.discussion_comments_count + 1 })),
    );
  }, []);

  const hasDiscussion = (entry: LaunchpadEntry) =>
    entry.discussion_number > 0 && entry.discussion_repo.trim() !== '';

  const closeDiscussion = useCallback(() => setDiscussionEntry(null), []);

  const handleOpenDiscussion = (entry: LaunchpadEntry) => {
    if (hasDiscussion(entry)) setDiscussionEntry(entry);
    else if (entry.discussion_url) void tauriApi.openUrl(entry.discussion_url);
  };

  const handleUpvote = async (entry: LaunchpadEntry) => {
    const id = entry.summary.id;
    // 未登录或无讨论绑定：打开讨论抽屉（含登录引导），不发写请求。
    if (!loggedIn || !hasDiscussion(entry)) {
      handleOpenDiscussion(entry);
      return;
    }
    if (upvoting.has(id)) return;
    setUpvoting((s) => addTo(s, id));
    try {
      const res = await tauriApi.toggleLaunchpadUpvote({
        discussionRepo: entry.discussion_repo,
        discussionNumber: entry.discussion_number,
        subjectId: entry.discussion_node_id,
        currentlyUpvoted: upvoted[id.toLowerCase()] ?? false,
      });
      applyUpvote(id, res.upvote_count, res.viewer_has_upvoted);
    } catch (e) {
      notifyToast(t('launchpad.upvote_failed', { error: String(e) }), 'error');
    } finally {
      setUpvoting((s) => removeFrom(s, id));
    }
  };

  const handleOpenMaker = (entry: LaunchpadEntry) => {
    const login = entry.maker.login || entry.summary.owner;
    if ((entry.summary.forge || 'github') === 'github') onOpenDeveloper(login);
    else if (entry.maker.html_url) void tauriApi.openUrl(entry.maker.html_url);
  };

  const handleOpenSource = (entry: LaunchpadEntry) => {
    const app = entry.summary;
    const host = app.forge_host || 'github.com';
    void tauriApi.openUrl(`https://${host}/${app.owner}/${app.repo}`);
  };

  const submitIssueUrl = feed?.submit_issue_url;
  const submitWebUrl = feed?.submit_web_url;
  const openSubmit = (url: string | undefined) => {
    setSubmitOpen(false);
    if (url) void tauriApi.openUrl(url);
  };

  const renderCard = (entry: LaunchpadEntry, variant: 'spotlight' | 'recent') => {
    const id = entry.summary.id;
    const key = id.toLowerCase();
    return (
      <LaunchpadCard
        key={key}
        entry={entry}
        variant={variant}
        highlighted={highlightId === key}
        platformLoading={isPlatformLoading(entry.summary, platformResolvedOtherIds)}
        isInstalled={selectIsInstalled(id, installedIds)}
        isManaged={selectManagedState(id, managedIds)}
        isInstalling={installingIds?.has(id) ?? false}
        isStarring={starring.has(id)}
        isUpvoting={upvoting.has(id)}
        upvoted={upvoted[key] ?? false}
        isMovingIn={isMovingIn(id)}
        isCustomExisting={hasIdAliasMatch(entry.summary, customIds)}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onOpenMaker={handleOpenMaker}
        onToggleStar={handleToggleStar}
        onUpvote={handleUpvote}
        onOpenDiscussion={handleOpenDiscussion}
        onOpenSource={handleOpenSource}
        onMoveInApp={handleMoveIn}
      />
    );
  };

  const settled = !loading && !error;
  const rawEmpty = feed !== null && allEntries.length === 0;
  const filteredOut =
    allEntries.length > 0 && visibleSpotlight.length === 0 && visibleRecent.length === 0;

  const sortOptions = [
    { value: 'recommended' as const, label: t('launchpad.sort.recommended') },
    { value: 'latest' as const, label: t('launchpad.sort.latest') },
    { value: 'discussions' as const, label: t('launchpad.sort.discussions') },
  ];

  const submitButton = (variant: 'secondary' | 'primary') => (
    <span className="launchpad-submit">
      <button
        type="button"
        className={`btn-fluent btn-${variant} btn-compact`}
        aria-haspopup="menu"
        aria-expanded={submitOpen}
        onClick={() => setSubmitOpen((v) => !v)}
      >
        <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
        <span>{t('launchpad.submit')}</span>
      </button>
      <FlyoutMenu isOpen={submitOpen} onClose={() => setSubmitOpen(false)} align="right" width={260}>
        <button type="button" role="menuitem" className="flyout-item" onClick={() => openSubmit(submitIssueUrl)}>
          <span className="flyout-item-icon"><FilePlus size={14} strokeWidth={1.5} /></span>
          <span className="flyout-item-content">
            <span className="flyout-item-title"><span>{t('launchpad.submit_issue')}</span></span>
          </span>
        </button>
        <button type="button" role="menuitem" className="flyout-item" onClick={() => openSubmit(submitWebUrl)}>
          <span className="flyout-item-icon"><BookOpen size={14} strokeWidth={1.5} /></span>
          <span className="flyout-item-content">
            <span className="flyout-item-title"><span>{t('launchpad.submit_web')}</span></span>
          </span>
        </button>
      </FlyoutMenu>
    </span>
  );

  return (
    <ViewShell viewClass="launchpad-view">
      <div className="section-header launchpad-header">
        <div>
          <h3 className="section-title">
            <Megaphone size={18} />
            <span>{t('launchpad.title')}</span>
          </h3>
          <p className="launchpad-subtitle">{t('launchpad.subtitle')}</p>
        </div>
        <div className="launchpad-header-actions">
          <button
            type="button"
            className="btn-fluent btn-secondary btn-compact btn-icon-only"
            title={t('launchpad.refresh')}
            aria-label={t('launchpad.refresh')}
            disabled={loading}
            onClick={() => load(true)}
          >
            <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" className={loading ? 'launchpad-refresh-spin' : ''} />
          </button>
          {submitButton('secondary')}
        </div>
      </div>

      {feed?.is_stale && !loading && (
        <div className="launchpad-stale-bar" role="status">
          <WifiOff size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('launchpad.stale_notice')}</span>
          <button type="button" className="btn-fluent btn-ghost btn-compact" onClick={() => load(true)}>
            {t('launchpad.refresh')}
          </button>
        </div>
      )}

      {error && allEntries.length === 0 ? (
        <FilterEmptyState
          className="launchpad-error"
          icon={<WifiOff size={40} strokeWidth={1.5} />}
          title={t('launchpad.error_title')}
          description={t('launchpad.error_desc')}
          resetLabel={t('launchpad.retry')}
          onReset={() => load(true)}
        />
      ) : filteredOut ? (
        <FilterEmptyState
          title={t('launchpad.filter_empty_title')}
          description={t('launchpad.filter_empty_desc')}
          resetLabel={t('launchpad.reset_device_filter')}
          onReset={onResetPlatformFilter}
        />
      ) : rawEmpty && settled ? (
        <div className="empty-state-card launchpad-empty">
          <Rocket size={32} aria-hidden="true" />
          <h4>{t('launchpad.empty_title')}</h4>
          <p>{t('launchpad.empty_desc')}</p>
          {submitButton('primary')}
        </div>
      ) : (
        <>
          {visibleSpotlight.length > 0 && (
            <section className="launchpad-section" aria-labelledby="launchpad-spotlight-title">
              <h3 className="section-title launchpad-section-title" id="launchpad-spotlight-title">
                <Pin size={15} aria-hidden="true" />
                <span>{t('launchpad.spotlight_title')}</span>
                <CountBadge value={visibleSpotlight.length} />
              </h3>
              <div className="launchpad-spotlight-grid">
                {visibleSpotlight.map((e) => renderCard(e, 'spotlight'))}
              </div>
            </section>
          )}
          <section className="launchpad-section" aria-labelledby="launchpad-recent-title">
            <div className="launchpad-section-head">
              <h3 className="section-title launchpad-section-title" id="launchpad-recent-title">
                <span>{t('launchpad.recent_title')}</span>
                {settled && <CountBadge value={visibleRecent.length} />}
              </h3>
              <SegmentedControl<LaunchpadSortMode>
                value={sortMode}
                onChange={setSortMode}
                options={sortOptions}
                size="compact"
                ariaLabel={t('launchpad.sort_aria')}
              />
            </div>
            <div className="app-grid launchpad-grid">
              {visibleRecent.map((e) => renderCard(e, 'recent'))}
            </div>
          </section>
        </>
      )}

      {discussionEntry && (
        <LaunchpadDiscussionDrawer
          entry={discussionEntry}
          oauthUser={oauthUser}
          initialUpvoted={upvoted[discussionEntry.summary.id.toLowerCase()] ?? false}
          onClose={closeDiscussion}
          onOpenDeveloper={onOpenDeveloper}
          onOpenAccount={onOpenAccount}
          onUpvoteChange={applyUpvote}
          onCommentAdded={handleCommentAdded}
        />
      )}
    </ViewShell>
  );
};
