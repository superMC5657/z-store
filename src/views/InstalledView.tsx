import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  RotateCcw,
  Shield,
  Download,
  Search,
  ScanLine,
  FolderOpen,
  Lock,
  EyeOff,
  Package,
} from 'lucide-react';
import { AppSummary, InstalledApp, UpdateRule } from '../types';
import { AppIcon } from '../components/AppIcon';
import { EmptyState } from '../components/EmptyState';
import { ViewShell } from './ViewShell';
import { formatAppDate, resolveInstalledIconInfo, resolveInstalledAppName } from '../utils/appHelper';

interface InstalledViewProps {
  installedApps: InstalledApp[];
  apps?: AppSummary[];
  uninstallingAppIds?: Set<string>;
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
}

import { InstalledItemActions } from './InstalledView/InstalledItemActions';

export const InstalledView: React.FC<InstalledViewProps> = ({
  installedApps,
  apps = [],
  uninstallingAppIds,
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
}) => {
  const { t, i18n } = useTranslation();
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [confirmingUnmanageId, setConfirmingUnmanageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

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

  const handleCopyPath = (id: string, path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 2000);
  };

  return (
    <ViewShell viewClass="installed-view">
      <div className="section-header">
        <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Package size={16} strokeWidth={1.5} style={{ color: 'var(--brand-primary)' }} />
          <span>{t('installed.title', { count: installedApps.length })}</span>
        </h3>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {onScanSystemApps && (
            <button
              className="btn-fluent btn-primary btn-sm"
              onClick={onScanSystemApps}
              title={t('installed.scan_local_tooltip')}
            >
              <ScanLine size={14} strokeWidth={1.5} />
              <span>{t('installed.scan_local_apps')}</span>
            </button>
          )}

          {onRefresh && (
            <button
              className="btn-fluent btn-secondary btn-sm"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('installed.refresh_status_tooltip')}
            >
              <RotateCcw size={14} strokeWidth={1.5} className={isRefreshing ? 'icon-spin' : ''} />
              <span>{isRefreshing ? t('installed.refreshing') : t('installed.refresh_status')}</span>
            </button>
          )}

          {onOpenRules && (
            <button
              className="btn-fluent btn-secondary btn-sm"
              onClick={onOpenRules}
              title={t('installed.rules_tooltip')}
            >
              <Shield size={14} strokeWidth={1.5} />
              <span>{t('installed.rules')}</span>
              {updateRules.length > 0 && (
                <span className="badge-capsule">
                  {updateRules.length}
                </span>
              )}
            </button>
          )}

          {onExportAppsJson && (
            <button
              className="btn-fluent btn-secondary btn-sm"
              onClick={onExportAppsJson}
              title={t('installed.export_list_tooltip')}
              disabled={installedApps.length === 0}
            >
              <Download size={14} strokeWidth={1.5} />
              <span>{t('installed.export_list')}</span>
            </button>
          )}
        </div>
      </div>

      {installedApps.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={40} strokeWidth={1.5} />}
          title={t('installed.empty_title')}
          description={t('installed.empty_desc')}
          action={onRefresh && (
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ padding: '6px 16px', fontSize: 'var(--font-base)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RotateCcw size={14} strokeWidth={1.5} className={isRefreshing ? 'icon-spin' : ''} />
              <span>{isRefreshing ? t('installed.refreshing_list') : t('installed.refresh_list')}</span>
            </button>
          )}
        />
      ) : (
        <div className="installed-list-container">
          {installedApps.map((app) => {
            const rule = updateRules.find((r) => r.app_id.toLowerCase() === app.app_id.toLowerCase());
            const isFrozen = Boolean(rule?.is_frozen);
            const isHidden = Boolean(rule?.is_hidden);
            const isMenuOpen = activeMenuId === app.app_id;
            const iconInfo = resolveInstalledIconInfo(app, apps);
            const appDisplayName = resolveInstalledAppName(app, apps);

            return (
              <div
                key={app.app_id}
                className="installed-list-row fluent-list-row"
                style={{
                  zIndex: isMenuOpen ? 50 : 1,
                }}
              >
                <div
                  style={{ cursor: onOpenDetail ? 'pointer' : 'default', flexShrink: 0, display: 'flex', alignItems: 'center' }}
                  onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                  title={onOpenDetail ? t('app.view_details') : undefined}
                >
                  <AppIcon
                    icon={iconInfo.icon}
                    name={appDisplayName}
                    appId={app.app_id}
                    iconBg={iconInfo.iconBg}
                    className="app-icon"
                    size={32}
                  />
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontWeight: 590,
                        fontSize: 'var(--font-md)',
                        cursor: onOpenDetail ? 'pointer' : 'default',
                        color: 'var(--text-primary)',
                        letterSpacing: '-0.015em',
                      }}
                      onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                      title={onOpenDetail ? t('app.view_details') : undefined}
                    >
                      {appDisplayName}
                    </span>
                    <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', flexShrink: 0 }}>{app.version}</span>
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
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <span
                      className="text-mono"
                      style={{
                        minWidth: 0,
                      }}
                      title={
                        app.install_path
                          ? `${t('installed.path_prefix', { path: app.install_path })} · ${t('installed.installed_date', { date: formatAppDate(app.installed_at, i18n.language) })}`
                          : undefined
                      }
                    >
                      {app.install_path
                        ? t('installed.path_prefix', { path: app.install_path })
                        : t('installed.path_not_detected_hint')}{' '}
                      · {t('installed.installed_date', { date: formatAppDate(app.installed_at, i18n.language) })}
                    </span>
                    {app.install_path ? (
                      <button
                        onClick={() => handleCopyPath(app.app_id, app.install_path)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--brand-primary)',
                          cursor: 'pointer',
                          fontSize: 'var(--font-xs)',
                          padding: '0 4px',
                          flexShrink: 0,
                        }}
                      >
                        {copiedId === app.app_id ? t('installed.copied') : t('installed.copy')}
                      </button>
                    ) : (
                      onScanSystemApps && (
                        <button
                          onClick={() => onScanSystemApps()}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--brand-primary)',
                            cursor: 'pointer',
                            fontSize: 'var(--font-xs)',
                            padding: '0 4px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                            flexShrink: 0,
                          }}
                        >
                          <Search size={10} />
                          <span>{t('installed.rescan')}</span>
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
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
                    onToggleMenu={(id, e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === id ? null : id);
                    }}
                    onCloseMenu={() => setActiveMenuId(null)}
                    onToggleRuleFrozen={onToggleRuleFrozen}
                    onToggleRuleHidden={onToggleRuleHidden}
                    compact={true}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ViewShell>
  );
};
