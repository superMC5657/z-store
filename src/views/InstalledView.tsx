import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { CountBadge } from '../components/CountBadge';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpDown,
  Check,
  CheckCircle2,
  Copy,
  DownloadCloud,
  EyeOff,
  FolderOpen,
  Lock,
  Package,
  RotateCcw,
  ScanLine,
  Search,
  Shield,
} from 'lucide-react';
import {
  AppSummary,
  InstalledApp,
  UpdateCheckProgressPayload,
  UpdateItem,
  UpdateRule,
} from '../types';
import { EmptyState } from '../components/EmptyState';
import { FilterEmptyState, ViewShell, resolvePlatformReset } from './ViewShell';
import type { PlatformId } from '../lib/platformFilter';
import { selectPlatformCounts, type InstalledPlatformRow } from '../app/selectors';
import {
  copyTextToClipboard,
  formatAppDate,
  resolveAppIconInfo,
  resolveInstalledAppName,
} from '../utils/appHelper';
import { InstalledItemActions, type RowUpdateActions } from './InstalledView/InstalledItemActions';
import { PathText } from './InstalledView/PathText';
import { CheckProgressBanner } from './InstalledView/CheckProgressBanner';
import { ChangelogDrawer } from './InstalledView/ChangelogDrawer';
import { queueAssembledRowIcons } from '../services/iconStore';
import { AppIconFrame } from '../components/AppIconFrame';
import { ManageHeader } from './manage/ManageHeader';
import { ManageFilterBar, type ManageFilterTab } from './manage/ManageFilterBar';
import {
  buildCatalogLookup,
  buildRulesMap,
  buildUpdatesMap,
  computeInstalledStats,
  selectUpdatableInstalled,
  filterAndSortInstalledApps,
  formatInstallMethodLabel,
  matchesInstalledSearch,
  type InstalledFilterTabId,
  type InstalledSortOrder,
} from './manage/manageModel';

const EMPTY_RESOLVED_IDS: ReadonlySet<string> = new Set<string>();

interface InstalledViewProps {
  /** 一次性落点请求：为 true 时切到「有更新」签并清空搜索，随后调用 onFocusConsumed。 */
  focusUpdates?: boolean;
  onFocusConsumed?: () => void;
  installedApps: InstalledApp[];
  apps?: AppSummary[];
  uninstallingAppIds?: Set<string>;
  /** 可用更新快照（读库或手动检查结果）；命中的已装行就地呈现版本差与更新动作。 */
  updates?: UpdateItem[];
  isChecking?: boolean;
  checkProgress?: UpdateCheckProgressPayload | null;
  /** 联网检查更新：本页唯一的网络入口。 */
  onCheckUpdates?: () => Promise<void>;
  onApplyUpdate?: (id: string) => Promise<void>;
  /** 批量更新：参数为当前「有更新」口径下的全部目标（不含被平台筛选或隐藏规则排除的项）。 */
  onBatchUpdateAll?: (targets: UpdateItem[]) => Promise<void>;
  onSkipVersion?: (id: string, version: string) => Promise<void>;
  onOpenDetail?: (id: string) => void;
  onLaunch: (id: string) => void;
  onUninstall: (id: string) => void;
  onUnmanage?: (id: string) => void;
  onScanSystemApps?: () => void;
  updateRules?: UpdateRule[];
  /** 规则按钮角标；缺席时按 `updateRules.length` 计。 */
  updateRulesCount?: number;
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  onOpenRules?: () => void;
  /** 初始加载错误（非空且列表为空时呈现错误卡，与空态区分）；重试经 onRetryLoad。 */
  loadError?: string | null;
  onRetryLoad?: () => void;
  /** 平台筛选前的已装总数：大于 0 而 `installedApps` 为空即「被平台筛空」，与真正未安装区分。 */
  totalInstalledCount?: number;
  /** 全部已装应用（未过平台筛选）的平台行，供侧栏平台分布上报。 */
  installedPlatformRows?: readonly InstalledPlatformRow[];
  /** 已确认 Other 的 id 集：目录空平台行据此区分 Other 与加载中（加载中暂不计数）。 */
  platformResolvedOtherIds?: ReadonlySet<string>;
  onResetPlatformFilter?: () => void;
  /** 上报侧栏平台分布：「已隐藏」签为隐藏的已装应用，其余签为未隐藏的已装应用；卸载时上报 null。 */
  onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;
}

export const InstalledView: React.FC<InstalledViewProps> = ({
  focusUpdates = false,
  onFocusConsumed,
  installedApps,
  apps = [],
  uninstallingAppIds,
  updates = [],
  isChecking = false,
  checkProgress,
  onCheckUpdates,
  onApplyUpdate,
  onBatchUpdateAll,
  onSkipVersion,
  onOpenDetail,
  onLaunch,
  onUninstall,
  onUnmanage,
  onScanSystemApps,
  updateRules = [],
  updateRulesCount,
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onOpenRules,
  loadError = null,
  onRetryLoad,
  totalInstalledCount,
  installedPlatformRows,
  platformResolvedOtherIds = EMPTY_RESOLVED_IDS,
  onResetPlatformFilter,
  onDisplayPlatformCounts,
}) => {
  const { t, i18n } = useTranslation();
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [confirmingUnmanageId, setConfirmingUnmanageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InstalledFilterTabId>(focusUpdates ? 'updatable' : 'all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<InstalledSortOrder>('recent');
  const [expandedChangelogId, setExpandedChangelogId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);

  const catalogById = useMemo(() => buildCatalogLookup(apps), [apps]);

  // 组装落盘补齐：已装列表展示图标入队本地缓存。
  useEffect(() => {
    if (installedApps.length === 0) return;
    queueAssembledRowIcons(
      installedApps.map((a) => ({
        id: a.app_id,
        icon: a.icon || catalogById.get(a.app_id.toLowerCase())?.icon || '',
      })),
    );
  }, [installedApps, catalogById]);

  useEffect(() => {
    if (!focusUpdates) return;
    setActiveTab('updatable');
    setSearchQuery('');
    onFocusConsumed?.();
  }, [focusUpdates, onFocusConsumed]);

  const rulesByAppId = useMemo(() => buildRulesMap(updateRules), [updateRules]);
  const updatesById = useMemo(() => buildUpdatesMap(updates), [updates]);
  // 筛选签计数按页内搜索词同步收窄，任一签上的数字恒等于切到该签时的可见行数。
  const searchMatchedApps = useMemo(
    () => installedApps.filter((a) => matchesInstalledSearch(a, apps, searchQuery)),
    [installedApps, apps, searchQuery],
  );
  const stats = useMemo(
    () => computeInstalledStats(searchMatchedApps, rulesByAppId, updatesById),
    [searchMatchedApps, rulesByAppId, updatesById],
  );
  // 「全部更新」目标不受页内搜索词裁剪。
  const updatableItems = useMemo(
    () => selectUpdatableInstalled(installedApps, rulesByAppId, updatesById),
    [installedApps, rulesByAppId, updatesById],
  );
  const hasUpdates = updatableItems.length > 0;

  const visibleApps = useMemo(
    () =>
      filterAndSortInstalledApps(
        installedApps,
        apps,
        rulesByAppId,
        activeTab,
        searchQuery,
        sortOrder,
        updatesById,
      ),
    [installedApps, apps, rulesByAppId, activeTab, searchQuery, sortOrder, updatesById],
  );

  const showHiddenSpread = activeTab === 'hidden';
  const displayPlatformCounts = useMemo(() => {
    if (!installedPlatformRows) return null;
    const rows = installedPlatformRows.filter(
      (row) => Boolean(rulesByAppId.get(row.id.toLowerCase())?.is_hidden) === showHiddenSpread,
    );
    return selectPlatformCounts(rows, platformResolvedOtherIds);
  }, [installedPlatformRows, rulesByAppId, showHiddenSpread, platformResolvedOtherIds]);

  useLayoutEffect(() => {
    if (displayPlatformCounts) onDisplayPlatformCounts?.(displayPlatformCounts);
  }, [displayPlatformCounts, onDisplayPlatformCounts]);

  useLayoutEffect(() => {
    return () => onDisplayPlatformCounts?.(null);
  }, [onDisplayPlatformCounts]);

  const isPlatformFilteredEmpty = installedApps.length === 0 && (totalInstalledCount ?? 0) > 0;

  const handleApplyUpdate = async (id: string) => {
    if (!onApplyUpdate) return;
    try {
      setUpdatingId(id);
      await onApplyUpdate(id);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdateAll = async () => {
    if (!onBatchUpdateAll) return;
    try {
      setIsUpdatingAll(true);
      await onBatchUpdateAll(updatableItems);
    } finally {
      setIsUpdatingAll(false);
    }
  };

  const handleTriggerUninstall = (id: string) => {
    if (uninstallingAppIds?.has(id)) return;
    if (confirmingUninstallId === id) {
      onUninstall(id);
      setConfirmingUninstallId(null);
    } else {
      setConfirmingUninstallId(id);
      setConfirmingUnmanageId(null);
      setTimeout(() => {
        setConfirmingUninstallId((prev) => (prev === id ? null : prev));
      }, 4000);
    }
  };

  const handleTriggerUnmanage = (id: string) => {
    if (confirmingUnmanageId === id) {
      if (onUnmanage) {
        onUnmanage(id);
      } else {
        onUninstall(id);
      }
      setConfirmingUnmanageId(null);
    } else {
      setConfirmingUnmanageId(id);
      setConfirmingUninstallId(null);
      setTimeout(() => {
        setConfirmingUnmanageId((prev) => (prev === id ? null : prev));
      }, 4000);
    }
  };

  const handleCopyPath = async (id: string, path: string) => {
    const ok = await copyTextToClipboard(path);
    if (!ok) return;
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 2000);
  };

  const filterTabs: ManageFilterTab<InstalledFilterTabId>[] = [
    { id: 'all', label: t('installed.filter_all'), count: stats.allCount },
    { id: 'updatable', label: t('installed.filter_updatable'), count: stats.updatableCount },
    { id: 'frozen', label: t('installed.filter_frozen'), count: stats.frozenCount },
    { id: 'hidden', label: t('installed.filter_hidden'), count: stats.hiddenCount },
  ];

  return (
    <ViewShell viewClass="installed-view manage-view">
      <ManageHeader
        icon={<Package size={16} strokeWidth={1.5} />}
        title={t('installed.title_label')}
        actions={
          <>
            {onOpenRules && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={onOpenRules}
                title={t('installed.rules_tooltip')}
              >
                <Shield size={13} strokeWidth={1.5} />
                <span>{t('installed.rules')}</span>
                <CountBadge value={updateRulesCount ?? updateRules.length} hideZero />
              </button>
            )}

            {onScanSystemApps && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={onScanSystemApps}
                title={t('installed.scan_local_tooltip')}
              >
                <ScanLine size={13} strokeWidth={1.5} />
                <span>{t('installed.scan_local_apps')}</span>
              </button>
            )}

            {onCheckUpdates && (
              <button
                type="button"
                // 有可用更新时主色让给「全部更新」，顶栏同时只有一个主按钮。
                className={`btn-fluent btn-compact ${hasUpdates && onBatchUpdateAll ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => void onCheckUpdates()}
                disabled={isChecking || isUpdatingAll}
                title={t('installed.check_tooltip')}
              >
                <RotateCcw size={13} strokeWidth={1.5} className={isChecking ? 'icon-spin' : ''} />
                <span>{isChecking ? t('installed.checking') : t('installed.check_updates')}</span>
              </button>
            )}

            {hasUpdates && onBatchUpdateAll && (
              <button
                type="button"
                className="btn-fluent btn-primary btn-compact"
                onClick={() => void handleUpdateAll()}
                disabled={isUpdatingAll || isChecking}
                title={t('installed.update_all')}
              >
                <DownloadCloud size={13} strokeWidth={1.5} />
                <span>{isUpdatingAll ? t('installed.updating_all') : t('installed.update_all')}</span>
              </button>
            )}
          </>
        }
      />

      {isChecking && <CheckProgressBanner progress={checkProgress} />}

      {(installedApps.length > 0 || isPlatformFilteredEmpty) && (
        <ManageFilterBar<InstalledFilterTabId>
          tabs={filterTabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabsAriaLabel={t('installed.filter_tabs_aria')}
          search={{
            query: searchQuery,
            onChange: setSearchQuery,
            placeholder: t('installed.search_placeholder'),
            clearLabel: t('installed.clear_search'),
          }}
          rightExtra={
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact"
              onClick={() => setSortOrder((prev) => (prev === 'recent' ? 'name' : 'recent'))}
              title={`${t('installed.sort_tooltip')} · ${
                sortOrder === 'recent' ? t('installed.sort_recent') : t('installed.sort_name')
              }`}
            >
              <ArrowUpDown size={13} strokeWidth={1.5} />
              <span className="manage-sort-label">
                {sortOrder === 'recent' ? t('installed.sort_recent') : t('installed.sort_name')}
              </span>
            </button>
          }
        />
      )}

      {installedApps.length === 0 && loadError ? (
        <EmptyState
          icon={<AlertTriangle size={40} strokeWidth={1.5} />}
          title={t('installed.load_failed_title')}
          description={t('installed.load_failed_desc', { error: loadError })}
          action={
            onRetryLoad && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                onClick={onRetryLoad}
              >
                <RotateCcw size={14} strokeWidth={1.5} />
                <span>{t('installed.retry_load')}</span>
              </button>
            )
          }
        />
      ) : isPlatformFilteredEmpty ? (
        <FilterEmptyState
          icon={<Package size={40} strokeWidth={1.5} />}
          title={t('installed.filter_empty_title')}
          description={t('installed.filter_empty_desc')}
          resetLabel={t('installed.reset_device_filter')}
          onReset={resolvePlatformReset(onResetPlatformFilter)}
        />
      ) : installedApps.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={40} strokeWidth={1.5} />}
          title={t('installed.empty_title')}
          description={t('installed.empty_desc')}
          action={
            onScanSystemApps && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                onClick={onScanSystemApps}
              >
                <ScanLine size={14} strokeWidth={1.5} />
                <span>{t('installed.scan_local_apps')}</span>
              </button>
            )
          }
        />
      ) : visibleApps.length === 0 && activeTab === 'updatable' && searchQuery.trim() === '' ? (
        isChecking ? (
          <EmptyState
            icon={
              <div
                className="spinner-icon"
                style={{ width: '36px', height: '36px', borderWidth: '3px' }}
              />
            }
            title={t('installed.stream_checking_title')}
            description={t('installed.stream_checking_desc')}
          />
        ) : (
          <EmptyState
            icon={<CheckCircle2 size={40} strokeWidth={1.5} style={{ color: 'var(--status-success)' }} />}
            title={t('installed.all_latest_title')}
            description={t('installed.all_latest_desc')}
          />
        )
      ) : visibleApps.length === 0 ? (
        <EmptyState
          icon={<Search size={36} strokeWidth={1.5} />}
          title={t('installed.no_match_title')}
          description={t('installed.no_match_desc')}
          action={
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact"
              onClick={() => {
                setActiveTab('all');
                setSearchQuery('');
              }}
            >
              {t('installed.reset_filters')}
            </button>
          }
        />
      ) : (
        <div className="installed-list-container manage-panel">
          {visibleApps.map((app) => {
            const rule = rulesByAppId.get(app.app_id.toLowerCase());
            const isFrozen = Boolean(rule?.is_frozen);
            const isHidden = Boolean(rule?.is_hidden);
            const update = updatesById.get(app.app_id.toLowerCase());
            const isChangelogOpen = Boolean(update) && expandedChangelogId === app.app_id;
            const isMenuOpen = activeMenuId === app.app_id;
            const isCopied = copiedId === app.app_id;
            const updateActions: RowUpdateActions | undefined =
              update && onApplyUpdate
                ? {
                    item: update,
                    isUpdating: updatingId === app.app_id,
                    isBlocked: isUpdatingAll || isChecking,
                    isChangelogOpen,
                    onToggleChangelog: () =>
                      setExpandedChangelogId((prev) => (prev === app.app_id ? null : app.app_id)),
                    onApply: () => void handleApplyUpdate(app.app_id),
                    onSkip: onSkipVersion
                      ? () => onSkipVersion(app.app_id, update.latest_version)
                      : undefined,
                  }
                : undefined;
            const iconInfo = resolveAppIconInfo(app.app_id, apps, app.icon, app.icon_bg);
            const appDisplayName = resolveInstalledAppName(app, apps);
            const methodLabel = formatInstallMethodLabel(app.install_method);

            return (
              <div
                key={app.app_id}
                className={`installed-list-row manage-row ${isMenuOpen ? 'is-menu-open' : ''}`.trim()}
              >
                <div className="manage-row-main">
                  <div className="manage-identity">
                    <AppIconFrame
                      size="md"
                      icon={iconInfo.icon}
                      name={appDisplayName}
                      appId={app.app_id}
                      iconBg={iconInfo.iconBg}
                      onClick={onOpenDetail ? () => onOpenDetail(app.app_id) : undefined}
                      title={onOpenDetail ? t('app.view_details') : undefined}
                    />

                    <div className="manage-identity-text">
                      <div className="manage-title-line">
                        <span
                          className={`manage-app-name ${onOpenDetail ? 'is-clickable' : ''}`.trim()}
                          onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                          title={onOpenDetail ? t('app.view_details') : undefined}
                        >
                          {appDisplayName}
                        </span>
                        {update ? (
                          <span
                            className="manage-version-inline-diff"
                            aria-label={t('installed.update_available')}
                          >
                            <span
                              className="manage-version-chip is-neutral"
                              title={t('installed.current_version', { version: update.current_version })}
                            >
                              {update.current_version}
                            </span>
                            <ArrowRight
                              size={12}
                              strokeWidth={1.5}
                              className="manage-version-arrow"
                              aria-hidden="true"
                            />
                            <span
                              className="manage-version-chip is-target"
                              title={t('installed.latest_version', { version: update.latest_version })}
                            >
                              {update.latest_version}
                            </span>
                          </span>
                        ) : (
                          <span className="manage-version-chip is-neutral">
                            {app.version.trim() || t('installed.version_unknown')}
                          </span>
                        )}
                        {methodLabel && <span className="manage-micro-tag is-method">{methodLabel}</span>}
                        {isFrozen && (
                          <span className="app-tag app-tag-locked" title={t('installed.locked')}>
                            <Lock size={10} strokeWidth={1.5} />
                            <span>{t('installed.locked')}</span>
                          </span>
                        )}
                        {isHidden && (
                          <span className="app-tag app-tag-hidden" title={t('installed.hidden')}>
                            <EyeOff size={10} strokeWidth={1.5} />
                            <span>{t('installed.hidden')}</span>
                          </span>
                        )}
                      </div>

                      <div className="manage-meta-line">
                        <span className="manage-date-text">
                          {t('installed.installed_date', {
                            date: formatAppDate(app.installed_at, i18n.language),
                          })}
                        </span>
                        {app.install_path && (
                          <>
                            <span className="manage-meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <button
                              type="button"
                              className={`manage-path-chip ${isCopied ? 'is-copied' : ''}`.trim()}
                              onClick={() => void handleCopyPath(app.app_id, app.install_path)}
                              title={`${app.install_path} — ${t('installed.copy_path_tooltip')}`}
                              aria-label={t('installed.copy_path_tooltip')}
                            >
                              <PathText path={app.install_path} />
                              <span className="manage-path-copy-badge">
                                {isCopied ? (
                                  <>
                                    <Check size={11} strokeWidth={1.75} />
                                    <span>{t('installed.copied_short')}</span>
                                  </>
                                ) : (
                                  <Copy size={11} strokeWidth={1.5} />
                                )}
                              </span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="manage-row-actions">
                    <InstalledItemActions
                      app={app}
                      isFrozen={isFrozen}
                      isHidden={isHidden}
                      isMenuOpen={isMenuOpen}
                      isUninstallingLoading={uninstallingAppIds?.has(app.app_id)}
                      confirmingUninstallId={confirmingUninstallId}
                      confirmingUnmanageId={confirmingUnmanageId}
                      onTriggerUninstall={handleTriggerUninstall}
                      onTriggerUnmanage={handleTriggerUnmanage}
                      onCancelConfirm={() => {
                        setConfirmingUninstallId(null);
                        setConfirmingUnmanageId(null);
                      }}
                      onLaunch={onLaunch}
                      onOpenDetail={onOpenDetail}
                      onCopyPath={(id, path) => void handleCopyPath(id, path)}
                      onToggleMenu={(id, e) => {
                        e.stopPropagation();
                        setActiveMenuId(activeMenuId === id ? null : id);
                      }}
                      onCloseMenu={() => setActiveMenuId(null)}
                      onToggleRuleFrozen={onToggleRuleFrozen}
                      onToggleRuleHidden={onToggleRuleHidden}
                      updateActions={updateActions}
                    />
                  </div>
                </div>

                {update && isChangelogOpen && (
                  <ChangelogDrawer
                    update={update}
                    onOpenDetail={onOpenDetail ? () => onOpenDetail(app.app_id) : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ViewShell>
  );
};
