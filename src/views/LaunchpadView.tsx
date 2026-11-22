import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { BookOpen, FilePlus, Megaphone, Pin, Plus, RefreshCw, Rocket, SearchCheck, WifiOff } from 'lucide-react';
import { useReportPlatformCounts } from '../app/hooks/useReportPlatformCounts';
import { tauriApi } from '../services/api';
import { CountBadge } from '../components/CountBadge';
import { SegmentedControl } from '../components/SegmentedControl';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { ShareBadgeModal } from '../components/ShareBadgeModal';
import { EMPTY_IDS, FilterEmptyState, ViewShell, noopAction, resolvePlatformReset } from './ViewShell';
import { useAppContextProps, type AppContextProps } from '../app/AppContext';
import { LaunchpadCard } from './LaunchpadView/LaunchpadCard';
import { LaunchpadSubmitModal } from './LaunchpadView/LaunchpadSubmitModal';
import { lazyNamed } from '../lib/lazyNamed';
import { sortLaunchpadItems } from './LaunchpadView/sortLaunchpad';
import {
  matchPlatformSetWithLoading,
  isPlatformLoading,
  PLATFORM_IDS,
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
import type { LaunchpadEntry, LaunchpadSortMode } from '../types';
import { hasDiscussion, useLaunchpadFeed } from './LaunchpadView/useLaunchpadFeed';
import { scrollBehavior } from '../lib/motion';

export interface LaunchpadViewProps extends AppContextProps {
  /** 深链定位的新品 id（高亮并滚动到卡片后经 `onFocusConsumed` 清除）。 */
  focusAppId?: string | null;
  onFocusConsumed?: () => void;
  /** 向侧栏上报广场全量条目（置顶 ∪ 新品流）的平台分布；卸载时上报 `null`。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
}

// 讨论弹窗连同 Markdown 渲染（marked）单独分块，打开讨论时才加载。
const LaunchpadDiscussionModal = lazyNamed(
  () => import('./LaunchpadView/LaunchpadDiscussionModal'),
  'LaunchpadDiscussionModal',
);
/** 未提供全局平台选择时视为全选。 */
const ALL_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

export const LaunchpadView: React.FC<LaunchpadViewProps> = (props) => {
  const {
    selectedPlatforms = ALL_PLATFORMS,
    platformResolvedOtherIds = EMPTY_IDS,
    installedIds = EMPTY_IDS,
    installingIds,
    managedIds = null,
    customIds,
    oauthUser = null,
    focusAppId,
    onFocusConsumed,
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onOpenDeveloper = noopAction,
    onOpenAccount = noopAction,
    onResetPlatformFilter,
    onDisplayPlatformCounts,
  } = useAppContextProps(props);
  const { t } = useTranslation();
  const [sortMode, setSortMode] = useState<LaunchpadSortMode>('recommended');
  const [openSubmitMenu, setOpenSubmitMenu] = useState<'header' | 'empty' | null>(null);
  const [submitWizardOpen, setSubmitWizardOpen] = useState(false);
  const [shareEntry, setShareEntry] = useState<LaunchpadEntry | null>(null);
  const [discussionAppId, setDiscussionAppId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const { isMovingIn, handleMoveIn } = useMoveInToDraft();

  const loggedIn = Boolean(oauthUser && !oauthUser.is_expired);
  const authKey = loggedIn ? `1:${oauthUser?.login ?? ''}` : '0';
  const launchpad = useLaunchpadFeed({ loggedIn, authKey, onRequireLogin: onOpenAccount });
  const { feed, allEntries, loading, error, load } = launchpad;

  const discussionEntry = useMemo(
    () =>
      discussionAppId
        ? allEntries.find((e) => e.summary.id.toLowerCase() === discussionAppId) ?? null
        : null,
    [allEntries, discussionAppId],
  );

  useEffect(() => {
    queueAssembledRowIcons(allEntries.map((e) => e.summary));
  }, [allEntries]);

  // 侧栏平台芯片：广场全量条目分布（不随平台勾选变化），离开视图恢复全库分布。
  const platformCounts = useMemo(
    () => (feed ? selectPlatformCounts(allEntries.map((e) => e.summary), platformResolvedOtherIds) : null),
    [feed, allEntries, platformResolvedOtherIds],
  );
  useReportPlatformCounts(platformCounts, onDisplayPlatformCounts);

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
      el?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' });
    }, 60);
    const clear = window.setTimeout(() => setHighlightId(null), 4000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [focusAppId, feed, onFocusConsumed]);

  const closeDiscussion = useCallback(() => setDiscussionAppId(null), []);

  const handleOpenDiscussion = (entry: LaunchpadEntry) => {
    if (hasDiscussion(entry)) setDiscussionAppId(entry.summary.id.toLowerCase());
    else if (entry.discussion_url) void tauriApi.openUrl(entry.discussion_url);
  };

  // 卡片主点击：有绑定讨论时打开讨论弹窗（详情从讨论内跳转），否则直接打开应用详情。
  const handleOpenCard = (entry: LaunchpadEntry) => {
    if (hasDiscussion(entry)) setDiscussionAppId(entry.summary.id.toLowerCase());
    else onOpenDetail(entry.summary.id);
  };

  const handleUpvote = (entry: LaunchpadEntry) => {
    // 未登录或无讨论绑定：打开讨论弹窗（含登录引导），不发写请求。
    if (!loggedIn || !hasDiscussion(entry)) {
      handleOpenDiscussion(entry);
      return;
    }
    void launchpad.upvote(entry);
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
    setOpenSubmitMenu(null);
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
        isStarring={launchpad.isStarring(id)}
        isUpvoting={launchpad.isUpvoting(id)}
        upvoted={Boolean(entry.viewer_has_upvoted)}
        isMovingIn={isMovingIn(id)}
        isCustomExisting={hasIdAliasMatch(entry.summary, customIds)}
        onOpen={handleOpenCard}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onOpenMaker={handleOpenMaker}
        onToggleStar={launchpad.toggleStar}
        onUpvote={handleUpvote}
        onOpenDiscussion={handleOpenDiscussion}
        onOpenSource={handleOpenSource}
        onMoveInApp={handleMoveIn}
        onShareBadge={setShareEntry}
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

  const submitButton = (
    slot: 'header' | 'empty',
    variant: 'secondary' | 'primary',
    align: 'right' | 'center',
  ) => {
    const isOpen = openSubmitMenu === slot;
    return (
      <span className="launchpad-submit">
        <button
          type="button"
          className={`btn-fluent btn-${variant} btn-compact`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          onClick={() => setOpenSubmitMenu((v) => (v === slot ? null : slot))}
        >
          <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('launchpad.submit')}</span>
        </button>
        <FlyoutMenu isOpen={isOpen} onClose={() => setOpenSubmitMenu(null)} align={align} width={280}>
          <button
            type="button"
            role="menuitem"
            className="flyout-item"
            onClick={() => {
              setOpenSubmitMenu(null);
              setSubmitWizardOpen(true);
            }}
          >
            <span className="flyout-item-icon"><SearchCheck size={14} strokeWidth={1.5} /></span>
            <span className="flyout-item-content">
              <span className="flyout-item-title"><span>{t('launchpad.submit_wizard')}</span></span>
            </span>
          </button>
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
  };

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
            <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" className={loading ? 'icon-spin' : ''} />
          </button>
          {submitButton('header', 'secondary', 'right')}
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
      ) : feed === null ? null : filteredOut ? (
        <FilterEmptyState
          title={t('launchpad.filter_empty_title')}
          description={t('launchpad.filter_empty_desc')}
          resetLabel={t('launchpad.reset_device_filter')}
          onReset={resolvePlatformReset(onResetPlatformFilter)}
        />
      ) : rawEmpty ? (
        <div className="empty-state-card launchpad-empty">
          <Rocket size={32} aria-hidden="true" />
          <h4>{t('launchpad.empty_title')}</h4>
          <p>{t('launchpad.empty_desc')}</p>
          {submitButton('empty', 'primary', 'center')}
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
        <React.Suspense fallback={null}>
          <LaunchpadDiscussionModal
            entry={discussionEntry}
            oauthUser={oauthUser}
            actions={launchpad}
            onClose={closeDiscussion}
            onOpenDetail={onOpenDetail}
            onOpenDeveloper={onOpenDeveloper}
            onOpenAccount={onOpenAccount}
          />
        </React.Suspense>
      )}

      {submitWizardOpen && (
        <LaunchpadSubmitModal
          submitIssueUrl={submitIssueUrl}
          oauthUser={oauthUser}
          onClose={() => setSubmitWizardOpen(false)}
        />
      )}

      {shareEntry && (
        <ShareBadgeModal
          id={shareEntry.summary.id}
          name={shareEntry.summary.name}
          kind="launchpad"
          layer="base"
          onClose={() => setShareEntry(null)}
        />
      )}
    </ViewShell>
  );
};
