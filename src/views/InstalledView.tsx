import React, { useEffect, useMemo, useState } from 'react';
import { CountBadge } from '../components/CountBadge';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  Copy,
  Download,
  EyeOff,
  FolderOpen,
  Lock,
  Package,
  RotateCcw,
  ScanLine,
  Search,
  Shield,
} from 'lucide-react';
import { AppSummary, InstalledApp, UpdateRule } from '../types';
import { EmptyState } from '../components/EmptyState';
import { ViewShell } from './ViewShell';
import {
  copyTextToClipboard,
  formatAppDate,
  resolveAppIconInfo,
  resolveInstalledAppName,
} from '../utils/appHelper';
import { InstalledItemActions } from './InstalledView/InstalledItemActions';
import { queueAssembledRowIcons } from '../services/iconStore';
import { AppIconFrame } from '../components/AppIconFrame';
import { ManageHeader } from './manage/ManageHeader';
import { ManageFilterBar, type ManageFilterTab } from './manage/ManageFilterBar';
import {
  buildCatalogLookup,
  buildRulesMap,
  computeInstalledStats,
  filterAndSortInstalledApps,
  formatInstallMethodLabel,
  type InstalledFilterTabId,
  type InstalledSortOrder,
} from './manage/manageModel';

interface InstalledViewProps {
  installedApps: InstalledApp[];
  apps?: AppSummary[];
  uninstallingAppIds?: Set<string>;
  /** 存在可用更新的小写规范 app_id 集合，用于展示轻量更新联动徽标。 */
  updatableIds?: ReadonlySet<string>;
  onOpenDetail?: (id: string) => void;
  onLaunch: (id: string) => void;
  onUninstall: (id: string) => void;
  onUnmanage?: (id: string) => void;
  onScanSystemApps?: () => void;
  onExportAppsJson?: () => void;
  updateRules?: UpdateRule[];
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  onOpenRules?: () => void;
  onRefresh?: () => Promise<void> | void;
  isRefreshing?: boolean;
  /** 初始加载错误（非空且列表为空时呈现错误卡，与空态区分）；重试经 onRetryLoad。 */
  loadError?: string | null;
  onRetryLoad?: () => void;
}

export const InstalledView: React.FC<InstalledViewProps> = ({
  installedApps,
  apps = [],
  uninstallingAppIds,
  updatableIds,
  onOpenDetail,
  onLaunch,
  onUninstall,
  onUnmanage,
  onScanSystemApps,
  onExportAppsJson,
  updateRules = [],
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onOpenRules,
  onRefresh,
  isRefreshing = false,
  loadError = null,
  onRetryLoad,
}) => {
  const { t, i18n } = useTranslation();
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [confirmingUnmanageId, setConfirmingUnmanageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InstalledFilterTabId>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<InstalledSortOrder>('recent');

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

  const rulesByAppId = useMemo(() => buildRulesMap(updateRules), [updateRules]);
  const stats = useMemo(
    () => computeInstalledStats(installedApps, rulesByAppId),
    [installedApps, rulesByAppId],
  );

  const visibleApps = useMemo(
    () =>
      filterAndSortInstalledApps(
        installedApps,
        apps,
        rulesByAppId,
        activeTab,
        searchQuery,
        sortOrder,
      ),
    [installedApps, apps, rulesByAppId, activeTab, searchQuery, sortOrder],
  );

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
    { id: 'all', label: t('installed.filter_all'), count: installedApps.length },
    { id: 'frozen', label: t('installed.filter_frozen'), count: stats.frozenCount },
    { id: 'hidden', label: t('installed.filter_hidden'), count: stats.hiddenCount },
    { id: 'missing_path', label: t('installed.filter_missing_path'), count: stats.missingPathCount },
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
                <CountBadge value={updateRules.length} hideZero />
              </button>
            )}

            {onRefresh && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={onRefresh}
                disabled={isRefreshing}
                title={t('installed.refresh_status_tooltip')}
              >
                <RotateCcw size={13} strokeWidth={1.5} className={isRefreshing ? 'icon-spin' : ''} />
                <span>{isRefreshing ? t('installed.refreshing') : t('installed.refresh_status')}</span>
              </button>
            )}

            {onExportAppsJson && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact"
                onClick={onExportAppsJson}
                title={t('installed.export_list_tooltip')}
                disabled={installedApps.length === 0}
              >
                <Download size={13} strokeWidth={1.5} />
                <span>{t('installed.export_list')}</span>
              </button>
            )}

            {onScanSystemApps && (
              <button
                type="button"
                className="btn-fluent btn-primary btn-compact"
                onClick={onScanSystemApps}
                title={t('installed.scan_local_tooltip')}
              >
                <ScanLine size={13} strokeWidth={1.5} />
                <span>{t('installed.scan_local_apps')}</span>
              </button>
            )}
          </>
        }
      />

      {installedApps.length > 0 && (
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
              title={t('installed.sort_tooltip')}
            >
              <ArrowUpDown size={13} strokeWidth={1.5} />
              <span>
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
      ) : installedApps.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={40} strokeWidth={1.5} />}
          title={t('installed.empty_title')}
          description={t('installed.empty_desc')}
          action={
            onRefresh && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                onClick={onRefresh}
                disabled={isRefreshing}
              >
                <RotateCcw size={14} strokeWidth={1.5} className={isRefreshing ? 'icon-spin' : ''} />
                <span>{isRefreshing ? t('installed.refreshing_list') : t('installed.refresh_list')}</span>
              </button>
            )
          }
        />
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
            const isUpdatable = Boolean(updatableIds?.has(app.app_id.toLowerCase()));
            const isMenuOpen = activeMenuId === app.app_id;
            const isCopied = copiedId === app.app_id;
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
                        <span className="manage-version-chip is-neutral">{app.version}</span>
                        {methodLabel && <span className="manage-micro-tag">{methodLabel}</span>}
                        {isUpdatable && (
                          <span className="manage-micro-tag is-updatable">
                            <span
                              className="status-dot"
                              style={{ background: 'var(--brand-primary)' }}
                              aria-hidden="true"
                            />
                            <span>{t('installed.update_available')}</span>
                          </span>
                        )}
                        {isFrozen && (
                          <span className="app-tag app-tag-locked">
                            <Lock size={10} strokeWidth={1.5} />
                            <span>{t('installed.locked')}</span>
                          </span>
                        )}
                        {isHidden && (
                          <span className="app-tag app-tag-hidden">
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
                        <span className="manage-meta-sep" aria-hidden="true">
                          ·
                        </span>
                        {app.install_path ? (
                          <button
                            type="button"
                            className={`manage-path-chip ${isCopied ? 'is-copied' : ''}`.trim()}
                            onClick={() => void handleCopyPath(app.app_id, app.install_path)}
                            title={`${app.install_path} — ${t('installed.copy_path_tooltip')}`}
                            aria-label={t('installed.copy_path_tooltip')}
                          >
                            <span className="manage-path-text">{app.install_path}</span>
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
                        ) : (
                          <span className="manage-path-missing">
                            <span>{t('installed.path_not_detected_hint')}</span>
                            {onScanSystemApps && (
                              <button
                                type="button"
                                className="manage-inline-link-btn"
                                onClick={() => onScanSystemApps()}
                              >
                                <Search size={10} strokeWidth={1.5} />
                                <span>{t('installed.rescan')}</span>
                              </button>
                            )}
                          </span>
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
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ViewShell>
  );
};
