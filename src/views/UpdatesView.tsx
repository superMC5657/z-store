import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { marked } from 'marked';
import {
  ArrowRight,
  BellOff,
  CheckCircle2,
  ChevronDown,
  Download,
  DownloadCloud,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Lock,
  MoreHorizontal,
  RotateCcw,
  Search,
  Shield,
  SkipForward,
} from 'lucide-react';
import { AppSummary, UpdateCheckProgressPayload, UpdateItem, WatchUpdatedPayload } from '../types';
import { sanitizeHtml } from '../utils/sanitize';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { EmptyState } from '../components/EmptyState';
import { ForgeIcon } from '../components/icons/PlatformIcons';
import { ViewShell } from './ViewShell';
import { resolveAppIconInfo } from '../utils/appHelper';
import { queueAssembledRowIcons } from '../services/iconStore';
import { ManageAppIcon } from './manage/ManageAppIcon';
import { ManageHeader } from './manage/ManageHeader';
import { ManageFilterBar, type ManageFilterTab } from './manage/ManageFilterBar';
import { ManageMenuItem } from './manage/ManageMenuItem';
import {
  buildCatalogLookup,
  filterUpdates,
  type UpdatesFilterTabId,
} from './manage/manageModel';

interface UpdatesViewProps {
  updates: UpdateItem[];
  apps?: AppSummary[];
  isChecking?: boolean;
  checkProgress?: UpdateCheckProgressPayload | null;
  onApplyUpdate: (id: string) => Promise<void>;
  onBatchUpdateAll: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onIgnoreUpdate?: (id: string) => void;
  onSkipVersion?: (id: string, version: string) => Promise<void>;
  onFreezeVersion?: (id: string) => Promise<void>;
  onHideApp?: (id: string) => Promise<void>;
  updateRulesCount?: number;
  onOpenRules?: () => void;
  // 关注应用的新版本应用内提醒（经 zstore://watch-updated 事件聚合）
  watchNotifications?: WatchUpdatedPayload[];
  onOpenWatchedApp?: (id: string) => void;
  onDismissWatch?: (appId: string) => void;
  // 切签进入更新中心即读一次 DB 快照（父层经 tauriApi.getCachedUpdates 供给，零网络；
  // 缺席即空列表，等手动 Refresh；网络仅经检查更新按钮）。
  onEnterUpdatesTab?: () => void;
}

export const UpdatesView: React.FC<UpdatesViewProps> = ({
  updates,
  apps = [],
  isChecking: propIsChecking,
  checkProgress,
  onApplyUpdate,
  onBatchUpdateAll,
  onCheckUpdates,
  onIgnoreUpdate,
  onSkipVersion,
  onFreezeVersion,
  onHideApp,
  updateRulesCount,
  onOpenRules,
  watchNotifications = [],
  onOpenWatchedApp,
  onDismissWatch,
  onEnterUpdatesTab,
}) => {
  const { t } = useTranslation();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [localChecking, setLocalChecking] = useState(false);
  const isChecking = propIsChecking !== undefined ? propIsChecking : localChecking;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<UpdatesFilterTabId>('all');

  const catalogById = useMemo(() => buildCatalogLookup(apps), [apps]);

  // 切签挂载读一次 DB 快照；此处不触发任何网络检查。
  const onEnterRef = useRef(onEnterUpdatesTab);
  onEnterRef.current = onEnterUpdatesTab;
  useEffect(() => {
    onEnterRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 组装落盘补齐：更新列表 + 关注动态展示图标入队本地缓存。
  useEffect(() => {
    if (updates.length === 0 && watchNotifications.length === 0) return;
    if (updates.length > 0) {
      queueAssembledRowIcons(
        updates.map((u) => ({
          id: u.app_id,
          icon: u.icon || catalogById.get(u.app_id.toLowerCase())?.icon || '',
        })),
      );
    }
    if (watchNotifications.length > 0) {
      queueAssembledRowIcons(
        watchNotifications.map((n) => ({
          id: n.app_id,
          icon: catalogById.get(n.app_id.toLowerCase())?.icon || '',
        })),
      );
    }
  }, [updates, watchNotifications, catalogById]);

  // 关注动态清空后若停留在 watched 标签则自动回到 all
  useEffect(() => {
    if (activeTab === 'watched' && watchNotifications.length === 0) {
      setActiveTab('all');
    }
  }, [activeTab, watchNotifications.length]);

  const filteredUpdates = useMemo(
    () => filterUpdates(updates, catalogById, searchQuery),
    [updates, catalogById, searchQuery],
  );

  const filteredWatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return watchNotifications;
    return watchNotifications.filter(
      (n) =>
        (n.app_name && n.app_name.toLowerCase().includes(q)) ||
        n.app_id.toLowerCase().includes(q),
    );
  }, [watchNotifications, searchQuery]);

  const handleUpdate = async (id: string) => {
    try {
      setUpdatingId(id);
      await onApplyUpdate(id);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdateAll = async () => {
    try {
      setIsUpdatingAll(true);
      await onBatchUpdateAll();
    } finally {
      setIsUpdatingAll(false);
    }
  };

  const triggerAnimatedAction = (id: string, action: () => Promise<void> | void) => {
    setActiveMenuId(null);
    setFadingIds((prev) => new Set(prev).add(id));
    setTimeout(async () => {
      await action();
      setFadingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 240);
  };

  const progressPct =
    checkProgress && checkProgress.total > 0
      ? Math.min(100, Math.round((checkProgress.checked / checkProgress.total) * 100))
      : 0;

  const filterTabs: ManageFilterTab<UpdatesFilterTabId>[] | undefined =
    watchNotifications.length > 0
      ? [
          {
            id: 'all',
            label: t('updates.filter_all'),
            count: updates.length + watchNotifications.length,
          },
          {
            id: 'updates',
            label: t('updates.filter_updates'),
            count: updates.length,
          },
          {
            id: 'watched',
            label: t('updates.filter_watched'),
            count: watchNotifications.length,
          },
        ]
      : undefined;

  const showControlsBar = updates.length > 0 || watchNotifications.length > 0;
  const isSearchFilteredOut =
    searchQuery.trim() !== '' &&
    ((activeTab === 'all' && filteredUpdates.length === 0 && filteredWatches.length === 0) ||
      (activeTab === 'updates' && updates.length > 0 && filteredUpdates.length === 0) ||
      (activeTab === 'watched' && filteredWatches.length === 0));

  const showWatchSection =
    !isSearchFilteredOut &&
    (activeTab === 'all' || activeTab === 'watched') &&
    filteredWatches.length > 0;
  const showUpdatesSection =
    !isSearchFilteredOut && (activeTab === 'all' || activeTab === 'updates');

  const rulesCount = updateRulesCount ?? 0;
  const subtitle =
    updates.length > 0
      ? t('updates.subtitle_summary', { count: updates.length, rules: rulesCount })
      : t('updates.subtitle_all_latest', { rules: rulesCount });

  return (
    <ViewShell viewClass="updates-view manage-view">
      <ManageHeader
        icon={<RotateCcw size={16} strokeWidth={1.5} />}
        title={t('updates.title_label')}
        count={updates.length}
        subtitle={subtitle}
        actions={
          <>
            {onOpenRules && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={onOpenRules}
                title={t('updates.rules_tooltip')}
              >
                <Shield size={13} strokeWidth={1.5} />
                <span>{t('updates.rules_btn')}</span>
                {typeof updateRulesCount === 'number' && updateRulesCount > 0 && (
                  <span className="badge-capsule">{updateRulesCount}</span>
                )}
              </button>
            )}
            {onCheckUpdates && (
              <button
                type="button"
                className={`btn-fluent btn-compact ${updates.length === 0 ? 'btn-primary' : 'btn-secondary'}`}
                onClick={async () => {
                  setLocalChecking(true);
                  try {
                    await onCheckUpdates();
                  } finally {
                    setLocalChecking(false);
                  }
                }}
                disabled={isChecking || isUpdatingAll}
                title={t('updates.check_tooltip')}
              >
                {isChecking ? (
                  <>
                    <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
                    <span>{t('updates.checking')}</span>
                  </>
                ) : (
                  <>
                    <Search size={13} strokeWidth={1.5} />
                    <span>{t('updates.check_updates')}</span>
                  </>
                )}
              </button>
            )}
            {updates.length > 0 && (
              <button
                type="button"
                className="btn-fluent btn-primary btn-compact"
                onClick={handleUpdateAll}
                disabled={isUpdatingAll || isChecking}
              >
                <DownloadCloud size={13} strokeWidth={1.5} />
                <span>
                  {isUpdatingAll
                    ? t('updates.updating_all')
                    : t('updates.update_all', { count: updates.length })}
                </span>
              </button>
            )}
          </>
        }
      />

      {isChecking && (
        <div className="manage-progress-banner" role="status" aria-live="polite">
          <div className="manage-progress-left">
            <span className="spinner-icon" aria-hidden="true" />
            <span>
              <strong>{t('updates.progress_title')}</strong>
              {checkProgress && checkProgress.total > 0 ? (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {' '}
                  {t('updates.progress_checked', {
                    checked: checkProgress.checked,
                    total: checkProgress.total,
                    current: checkProgress.app_name
                      ? t('updates.progress_comparing', { name: checkProgress.app_name })
                      : '',
                  })}
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('updates.progress_hint')}
                </span>
              )}
            </span>
          </div>
          {checkProgress && checkProgress.total > 0 && (
            <span className="manage-progress-meta">{progressPct}%</span>
          )}
          <div className="manage-progress-track">
            <div className="manage-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      {showControlsBar && (
        <ManageFilterBar<UpdatesFilterTabId>
          tabs={filterTabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabsAriaLabel={t('updates.filter_tabs_aria')}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder={t('updates.search_placeholder')}
          clearSearchLabel={t('updates.clear_search')}
        />
      )}

      {isSearchFilteredOut && (
        <EmptyState
          icon={<Search size={36} strokeWidth={1.5} />}
          title={t('updates.no_match_title')}
          description={t('updates.no_match_desc')}
          action={
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              onClick={() => {
                setSearchQuery('');
                setActiveTab('all');
              }}
            >
              {t('updates.reset_filters')}
            </button>
          }
        />
      )}

      {showWatchSection && (
        <section
          className="manage-section"
          aria-label={t('updates.watch_updates_title', { count: filteredWatches.length })}
        >
          <div className="manage-section-eyebrow">
            <span className="manage-section-eyebrow-title">
              <Eye size={13} strokeWidth={1.5} />
              <span>{t('updates.watch_updates_title', { count: filteredWatches.length })}</span>
            </span>
          </div>
          <div className="manage-panel">
            {filteredWatches.map((n) => {
              const iconInfo = resolveAppIconInfo(n.app_id, apps);
              const displayName = n.app_name || n.app_id;
              return (
                <div key={n.app_id} className="manage-row">
                  <div className="manage-row-main">
                    <div className="manage-identity">
                      <ManageAppIcon
                        size="sm"
                        icon={iconInfo.icon}
                        name={displayName}
                        appId={n.app_id}
                        iconBg={iconInfo.iconBg}
                        onClick={onOpenWatchedApp ? () => onOpenWatchedApp(n.app_id) : undefined}
                        title={onOpenWatchedApp ? t('app.view_details') : undefined}
                      />
                      <div className="manage-identity-text">
                        <div className="manage-title-line">
                          <span
                            className={`manage-app-name ${onOpenWatchedApp ? 'is-clickable' : ''}`.trim()}
                            onClick={() => onOpenWatchedApp && onOpenWatchedApp(n.app_id)}
                            title={onOpenWatchedApp ? t('app.view_details') : undefined}
                          >
                            {displayName}
                          </span>
                          <span className="manage-version-chip is-target">{n.version}</span>
                        </div>
                        <div className="manage-meta-line">
                          <span>{t('updates.watch_released', { name: displayName, version: n.version })}</span>
                        </div>
                      </div>
                    </div>

                    <div className="manage-row-actions">
                      {onOpenWatchedApp && (
                        <button
                          type="button"
                          className="manage-btn-action"
                          onClick={() => onOpenWatchedApp(n.app_id)}
                        >
                          {t('updates.view_details')}
                        </button>
                      )}
                      {onDismissWatch && (
                        <button
                          type="button"
                          className="btn-fluent btn-ghost btn-compact"
                          onClick={() => onDismissWatch(n.app_id)}
                        >
                          {t('updates.dismiss_watch')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {showUpdatesSection && (
        <section className="manage-section">
          {updates.length === 0 ? (
            isChecking ? (
              <EmptyState
                icon={
                  <div
                    className="spinner-icon"
                    style={{ width: '36px', height: '36px', borderWidth: '3px' }}
                  />
                }
                title={t('updates.stream_checking_title')}
                description={t('updates.stream_checking_desc')}
              />
            ) : (
              <EmptyState
                icon={<CheckCircle2 size={40} strokeWidth={1.5} style={{ color: 'var(--status-success)' }} />}
                title={t('updates.all_latest_title')}
                description={t('updates.all_latest_desc')}
              />
            )
          ) : (
            <div className="manage-panel">
              {filteredUpdates.map((item) => {
                const isExpanded = expandedId === item.app_id;
                const isThisUpdating = updatingId === item.app_id;
                const isMenuOpen = activeMenuId === item.app_id;
                const isFading = fadingIds.has(item.app_id);
                const iconInfo = resolveAppIconInfo(item.app_id, apps, item.icon, item.icon_bg);
                const catalogEntry = catalogById.get(item.app_id.toLowerCase());
                const hasChangelog = Boolean(item.changelog && item.changelog.trim());

                const rowClasses = [
                  'manage-row',
                  'update-item-entrance',
                  isMenuOpen ? 'is-menu-open' : '',
                  isFading ? 'is-fading' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={item.app_id} className={rowClasses}>
                    <div className="manage-row-main">
                      <div className="manage-identity">
                        <ManageAppIcon
                          size="md"
                          icon={iconInfo.icon}
                          name={item.app_name}
                          appId={item.app_id}
                          iconBg={iconInfo.iconBg}
                          onClick={onOpenWatchedApp ? () => onOpenWatchedApp(item.app_id) : undefined}
                          title={onOpenWatchedApp ? t('app.view_details') : undefined}
                        />
                        <div className="manage-identity-text">
                          <div className="manage-title-line">
                            <span
                              className={`manage-app-name ${onOpenWatchedApp ? 'is-clickable' : ''}`.trim()}
                              onClick={() => onOpenWatchedApp && onOpenWatchedApp(item.app_id)}
                              title={onOpenWatchedApp ? t('app.view_details') : undefined}
                            >
                              {item.app_name}
                            </span>
                            {catalogEntry?.forge && catalogEntry.forge !== 'github' && (
                              <span
                                className="manage-micro-tag"
                                title={`${t('app.code_source')}: ${catalogEntry.forge_host || catalogEntry.forge}`}
                              >
                                <ForgeIcon forge={catalogEntry.forge} size={11} />
                                <span>{catalogEntry.forge_host || catalogEntry.forge}</span>
                              </span>
                            )}
                          </div>
                          <div className="manage-meta-line">
                            <span className="manage-repo-slug" title={item.app_id}>
                              {item.app_id}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="manage-version-diff">
                        <span
                          className="manage-version-chip is-neutral"
                          title={t('updates.current_version', { version: item.current_version })}
                        >
                          {item.current_version}
                        </span>
                        <ArrowRight
                          size={12}
                          strokeWidth={1.5}
                          className="manage-version-arrow"
                          aria-hidden="true"
                        />
                        <span
                          className="manage-version-chip is-target"
                          title={t('updates.latest_version', { version: item.latest_version })}
                        >
                          {item.latest_version}
                        </span>
                      </div>

                      <div className="manage-row-actions">
                        <button
                          type="button"
                          className="btn-fluent btn-ghost btn-compact"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedId(isExpanded ? null : item.app_id)}
                        >
                          <FileText size={13} strokeWidth={1.5} />
                          <span>
                            {isExpanded ? t('updates.collapse_changelog') : t('updates.view_changelog')}
                          </span>
                          <ChevronDown
                            size={13}
                            strokeWidth={1.5}
                            className={`manage-chevron-rotate ${isExpanded ? 'is-expanded' : ''}`.trim()}
                          />
                        </button>

                        <button
                          type="button"
                          className="manage-btn-action"
                          disabled={isThisUpdating || isUpdatingAll}
                          onClick={() => handleUpdate(item.app_id)}
                        >
                          {isThisUpdating ? (
                            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" />
                          ) : (
                            <Download size={13} strokeWidth={1.5} />
                          )}
                          <span>{isThisUpdating ? t('updates.updating') : t('updates.update_now')}</span>
                        </button>

                        <div style={{ position: 'relative' }}>
                          <button
                            type="button"
                            className={`manage-btn-icon ${isMenuOpen ? 'active' : ''}`.trim()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuId(isMenuOpen ? null : item.app_id);
                            }}
                            title={t('updates.more_rules_tooltip')}
                            aria-label={t('installed.more_options')}
                          >
                            <MoreHorizontal size={14} strokeWidth={1.5} />
                          </button>

                          <FlyoutMenu
                            isOpen={isMenuOpen}
                            onClose={() => setActiveMenuId(null)}
                            width={210}
                          >
                            {onIgnoreUpdate && (
                              <ManageMenuItem
                                icon={<BellOff size={13} strokeWidth={1.5} />}
                                label={t('updates.ignore_once')}
                                onClick={() =>
                                  triggerAnimatedAction(item.app_id, () => onIgnoreUpdate(item.app_id))
                                }
                              />
                            )}

                            {onSkipVersion && (
                              <ManageMenuItem
                                icon={<SkipForward size={13} strokeWidth={1.5} />}
                                label={t('updates.skip_version')}
                                onClick={() =>
                                  triggerAnimatedAction(item.app_id, () =>
                                    onSkipVersion(item.app_id, item.latest_version),
                                  )
                                }
                              />
                            )}

                            {onFreezeVersion && (
                              <ManageMenuItem
                                icon={<Lock size={13} strokeWidth={1.5} />}
                                label={t('updates.lock_version')}
                                onClick={() =>
                                  triggerAnimatedAction(item.app_id, () => onFreezeVersion(item.app_id))
                                }
                              />
                            )}

                            {onHideApp && (
                              <ManageMenuItem
                                icon={<EyeOff size={13} strokeWidth={1.5} />}
                                label={t('updates.hide_app')}
                                danger
                                onClick={() =>
                                  triggerAnimatedAction(item.app_id, () => onHideApp(item.app_id))
                                }
                              />
                            )}
                          </FlyoutMenu>
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="manage-changelog-drawer">
                        <div className="manage-changelog-header">
                          <span>
                            {t('updates.changelog_header', {
                              current: item.current_version,
                              latest: item.latest_version,
                            })}
                          </span>
                          {onOpenWatchedApp && (
                            <button
                              type="button"
                              className="manage-inline-link-btn"
                              onClick={() => onOpenWatchedApp(item.app_id)}
                            >
                              <ExternalLink size={11} strokeWidth={1.5} />
                              <span>{t('updates.open_app_detail')}</span>
                            </button>
                          )}
                        </div>
                        {hasChangelog ? (
                          <div className="manage-changelog-scroll">
                            <div
                              className="readme-markdown-body"
                              dangerouslySetInnerHTML={{
                                __html: sanitizeHtml(marked.parse(item.changelog, { async: false }) as string),
                              }}
                            />
                          </div>
                        ) : (
                          <div className="manage-changelog-empty">
                            <span>{t('updates.changelog_empty')}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </ViewShell>
  );
};
