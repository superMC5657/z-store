import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  RotateCcw,
  Shield,
  Download,
  Search,
  ScanLine,
  LayoutGrid,
  List,
  FolderOpen,
  Lock,
  EyeOff,
  MinusCircle,
  Package,
} from 'lucide-react';
import { AppSummary, InstalledApp, UpdateRule } from '../types';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { AppIcon } from '../components/AppIcon';
import { formatAppDate, getMethodBadge, resolveInstalledIconInfo, resolveInstalledAppName } from '../utils/appHelper';

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

interface InstalledItemActionsProps {
  app: InstalledApp;
  isFrozen: boolean;
  isHidden: boolean;
  isMenuOpen: boolean;
  isUninstallingLoading?: boolean;
  confirmingUninstallId: string | null;
  confirmingUnmanageId: string | null;
  onTriggerUninstall: (id: string) => void;
  onTriggerUnmanage: (id: string) => void;
  onCancelConfirm: () => void;
  onLaunch: (id: string) => void;
  onToggleMenu: (id: string, e: React.MouseEvent) => void;
  onCloseMenu: () => void;
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  compact?: boolean;
}

const InstalledItemActions: React.FC<InstalledItemActionsProps> = ({
  app,
  isFrozen,
  isHidden,
  isMenuOpen,
  isUninstallingLoading = false,
  confirmingUninstallId,
  confirmingUnmanageId,
  onTriggerUninstall,
  onTriggerUnmanage,
  onCancelConfirm,
  onLaunch,
  onToggleMenu,
  onCloseMenu,
  onToggleRuleFrozen,
  onToggleRuleHidden,
  compact = false,
}) => {
  const { t } = useTranslation();
  const isUnmanaging = confirmingUnmanageId === app.app_id;
  const isUninstalling = confirmingUninstallId === app.app_id;

  return (
    <div className={`installed-actions-group ${compact ? 'compact' : ''}`}>
      {/* 左侧区域：破坏性/管理操作 (卡片模式在左，紧凑列表模式居右归并) */}
      <div className="installed-actions-left">
        {isUninstallingLoading ? (
          <button
            className={`installed-action-btn btn-installed-uninstall btn-loading ${compact ? 'compact' : ''}`}
            disabled
            title={t('installed.uninstalling_tooltip')}
          >
            {t('installed.uninstalling')}
          </button>
        ) : isUnmanaging ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className={`installed-action-btn btn-confirm-warning ${compact ? 'compact' : ''}`}
              onClick={() => onTriggerUnmanage(app.app_id)}
              title={t('installed.confirm_unmanage_tooltip')}
            >
              {t('installed.confirm_unmanage')}
            </button>
            <button
              className={`installed-action-btn btn-confirm-cancel ${compact ? 'compact' : ''}`}
              onClick={onCancelConfirm}
              title={t('installed.cancel_confirm_tooltip')}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : isUninstalling ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className={`installed-action-btn btn-confirm-danger ${compact ? 'compact' : ''}`}
              onClick={() => onTriggerUninstall(app.app_id)}
              title={t('installed.confirm_uninstall_tooltip')}
            >
              {t('installed.confirm_uninstall')}
            </button>
            <button
              className={`installed-action-btn btn-confirm-cancel ${compact ? 'compact' : ''}`}
              onClick={onCancelConfirm}
              title={t('installed.cancel_confirm_tooltip')}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            className={`installed-action-btn btn-installed-uninstall ${compact ? 'compact' : ''}`}
            onClick={() => onTriggerUninstall(app.app_id)}
            title={t('installed.uninstall_tooltip')}
          >
            {t('installed.uninstall')}
          </button>
        )}
      </div>

      {/* 右侧区域：核心高频行动点 [ ▶ 启动 ] + [ ··· 更多操作 ] */}
      <div className="installed-actions-right">
        <button
          className={`installed-action-btn btn-fluent btn-primary ${compact ? 'compact' : ''}`}
          disabled={isUninstallingLoading}
          onClick={() => onLaunch(app.app_id)}
          title={t('installed.launch_tooltip')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '4px' }}>
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>{t('installed.launch')}</span>
        </button>

        <div style={{ position: 'relative' }}>
          <button
            className={`installed-action-btn btn-fluent btn-secondary btn-icon-only ${compact ? 'compact' : ''} ${isMenuOpen ? 'active' : ''}`}
            disabled={isUninstallingLoading}
            onClick={(e) => onToggleMenu(app.app_id, e)}
            title={t('installed.more_options_tooltip')}
            aria-label={t('installed.more_options')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>

          <FlyoutMenu
            isOpen={isMenuOpen}
            onClose={onCloseMenu}
            align="right"
            width={210}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' }}>
              {/* 版本锁定 */}
              {onToggleRuleFrozen && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleFrozen(app.app_id, !isFrozen);
                  }}
                  title={isFrozen ? t('installed.unlock_version_tooltip') : t('installed.lock_version_tooltip')}
                >
                  <div className="flyout-item-icon">
                    {isFrozen ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                  </div>
                  <div className="flyout-item-content">
                    <div className="flyout-item-title">
                      <span>{isFrozen ? t('installed.unlock_version') : t('installed.lock_version')}</span>
                      {isFrozen && <span className="flyout-item-badge badge-blue">{t('installed.locked')}</span>}
                    </div>
                  </div>
                </button>
              )}

              {/* 隐藏应用 */}
              {onToggleRuleHidden && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleHidden(app.app_id, !isHidden);
                  }}
                  title={isHidden ? t('installed.unhide_app_tooltip') : t('installed.hide_app_tooltip')}
                >
                  <div className="flyout-item-icon">
                    {isHidden ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    )}
                  </div>
                  <div className="flyout-item-content">
                    <div className="flyout-item-title">
                      <span>{isHidden ? t('installed.unhide_app') : t('installed.hide_app')}</span>
                      {isHidden && <span className="flyout-item-badge badge-red">{t('installed.hidden')}</span>}
                    </div>
                  </div>
                </button>
              )}

              <div className="flyout-divider" />

              {/* 取消管理 */}
              <button
                className="flyout-item flyout-item-danger"
                onClick={() => {
                  onCloseMenu();
                  onTriggerUnmanage(app.app_id);
                }}
                title={t('installed.unmanage_tooltip')}
              >
                <div className="flyout-item-icon">
                  <MinusCircle size={13} />
                </div>
                <div className="flyout-item-content">
                  <div className="flyout-item-title">{t('installed.unmanage')}</div>
                </div>
              </button>
            </div>
          </FlyoutMenu>
        </div>
      </div>
    </div>
  );
};

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
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
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
    <div className="installed-view view-entrance">
      <div className="section-header">
        <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Package size={18} style={{ color: 'var(--brand-primary)' }} />
          <span>{t('installed.title', { count: installedApps.length })}</span>
        </h3>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {onScanSystemApps && (
            <button
              className="btn-fluent btn-sm btn-primary"
              style={{ height: '30px', padding: '0 12px', fontSize: '12px', gap: '6px', fontWeight: 600 }}
              onClick={onScanSystemApps}
              title={t('installed.scan_local_tooltip')}
            >
              <ScanLine size={13} />
              <span>{t('installed.scan_local_apps')}</span>
            </button>
          )}

          {onRefresh && (
            <button
              className="btn-fluent btn-sm btn-secondary"
              style={{ height: '30px', padding: '0 10px', fontSize: '12px', gap: '5px' }}
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('installed.refresh_status_tooltip')}
            >
              <RotateCcw size={13} className={isRefreshing ? 'icon-spin' : ''} />
              <span>{isRefreshing ? t('installed.refreshing') : t('installed.refresh_status')}</span>
            </button>
          )}

          {onOpenRules && (
            <button
              className="btn-fluent btn-sm btn-secondary"
              style={{ height: '30px', padding: '0 10px', fontSize: '12px', gap: '5px' }}
              onClick={onOpenRules}
              title={t('installed.rules_tooltip')}
            >
              <Shield size={13} />
              <span>{t('installed.rules')}</span>
              {updateRules.length > 0 && (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '0 5px',
                    borderRadius: '8px',
                    background: 'var(--brand-primary)',
                    color: '#fff',
                    fontWeight: 700,
                    lineHeight: '14px',
                  }}
                >
                  {updateRules.length}
                </span>
              )}
            </button>
          )}

          {onExportAppsJson && (
            <button
              className="btn-fluent btn-sm btn-secondary"
              style={{ height: '30px', padding: '0 10px', fontSize: '12px', gap: '5px' }}
              onClick={onExportAppsJson}
              title={t('installed.export_list_tooltip')}
              disabled={installedApps.length === 0}
            >
              <Download size={13} />
              <span>{t('installed.export_list')}</span>
            </button>
          )}

          <div
            style={{
              width: '1px',
              height: '16px',
              background: 'var(--border-acrylic)',
              margin: '0 2px',
              opacity: 0.7,
            }}
          />

          <div className="segmented-group" style={{ height: '30px', padding: '2px', boxSizing: 'border-box' }}>
            <button
              className={`segmented-item ${viewMode === 'card' ? 'active' : ''}`}
              style={{ height: '24px', minHeight: '24px', padding: '0 8px', fontSize: '11.5px', gap: '4px' }}
              onClick={() => setViewMode('card')}
              title={t('installed.view_card_tooltip')}
            >
              <LayoutGrid size={12} />
              <span>{t('installed.view_card')}</span>
            </button>
            <button
              className={`segmented-item ${viewMode === 'list' ? 'active' : ''}`}
              style={{ height: '24px', minHeight: '24px', padding: '0 8px', fontSize: '11.5px', gap: '4px' }}
              onClick={() => setViewMode('list')}
              title={t('installed.view_list_tooltip')}
            >
              <List size={12} />
              <span>{t('installed.view_list')}</span>
            </button>
          </div>
        </div>
      </div>

      {installedApps.length === 0 ? (
        <div className="empty-state-card">
          <FolderOpen size={44} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', margin: '0 auto 12px' }} />
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{t('installed.empty_title')}</h4>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: '0 0 16px 0' }}>
            {t('installed.empty_desc')}
          </p>
          {onRefresh && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '6px 16px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RotateCcw size={13} className={isRefreshing ? 'icon-spin' : ''} />
              <span>{isRefreshing ? t('installed.refreshing_list') : t('installed.refresh_list')}</span>
            </button>
          )}
        </div>
      ) : viewMode === 'card' ? (
        <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {installedApps.map((app) => {
            const badge = getMethodBadge(app.install_method, t);
            const rule = updateRules.find((r) => r.app_id.toLowerCase() === app.app_id.toLowerCase());
            const isFrozen = Boolean(rule?.is_frozen);
            const isHidden = Boolean(rule?.is_hidden);
            const isMenuOpen = activeMenuId === app.app_id;
            const iconInfo = resolveInstalledIconInfo(app, apps);
            const appDisplayName = resolveInstalledAppName(app, apps);

            return (
              <div key={app.app_id} className="app-card" style={{ padding: '18px', zIndex: isMenuOpen ? 50 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                    <div
                      style={{ cursor: onOpenDetail ? 'pointer' : 'default', flexShrink: 0 }}
                      onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                      title={onOpenDetail ? t('app.view_details') : undefined}
                    >
                      <AppIcon
                        icon={iconInfo.icon}
                        name={appDisplayName}
                        appId={app.app_id}
                        iconBg={iconInfo.iconBg}
                        className="app-icon"
                        size={46}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h4
                        style={{
                          margin: '0 0 4px 0',
                          fontSize: '15px',
                          cursor: onOpenDetail ? 'pointer' : 'default',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                        title={onOpenDetail ? t('app.view_details') : undefined}
                      >
                        {appDisplayName}
                      </h4>
                      <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {t('installed.version_and_date', { version: app.version, date: formatAppDate(app.installed_at, i18n.language) })}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                    {isFrozen && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '2px 7px',
                          borderRadius: '10px',
                          background: 'rgba(59, 130, 246, 0.15)',
                          color: '#60a5fa',
                          fontWeight: 600,
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                        }}
                        title={t('installed.locked_tooltip')}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                          <Lock size={10} />
                          <span>{t('installed.locked')}</span>
                        </span>
                      </span>
                    )}
                    {isHidden && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '2px 7px',
                          borderRadius: '10px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#f87171',
                          fontWeight: 600,
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                        }}
                        title={t('installed.hidden_tooltip')}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                          <EyeOff size={10} />
                          <span>{t('installed.hidden')}</span>
                        </span>
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: 'var(--brand-subtle)',
                        color: badge.color,
                        fontWeight: 500,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                </div>

                <div style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="text"
                      readOnly
                      value={app.install_path}
                      placeholder={t('installed.path_not_detected')}
                      style={{
                        flex: 1,
                        height: '28px',
                        boxSizing: 'border-box',
                        fontSize: '11.5px',
                        padding: '0 8px',
                        background: 'var(--bg-acrylic-input, rgba(0, 0, 0, 0.25))',
                        border: '1px solid var(--border-acrylic)',
                        borderRadius: 'var(--radius-sm)',
                        color: app.install_path ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                        fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                        outline: 'none',
                        cursor: 'text',
                        userSelect: 'all',
                      }}
                      title={app.install_path || t('installed.path_not_detected')}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    {app.install_path ? (
                      <button
                        className="btn-fluent btn-secondary"
                        style={{
                          height: '28px',
                          boxSizing: 'border-box',
                          padding: '0 10px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: copiedId === app.app_id ? '#4ade80' : 'var(--text-secondary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onClick={() => handleCopyPath(app.app_id, app.install_path)}
                        title={t('installed.copy_path')}
                      >
                        {copiedId === app.app_id ? t('installed.copied') : t('installed.copy_path')}
                      </button>
                    ) : (
                      <button
                        className="btn-fluent btn-secondary"
                        style={{
                          height: '28px',
                          boxSizing: 'border-box',
                          padding: '0 10px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: 'var(--brand-primary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          justifyContent: 'center',
                        }}
                        onClick={() => onScanSystemApps && onScanSystemApps()}
                        title={t('installed.rescan_tooltip')}
                      >
                        <Search size={11} />
                        <span>{t('installed.rescan')}</span>
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ marginTop: '16px', width: '100%' }}>
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
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="installed-list-container">
          {installedApps.map((app) => {
            const badge = getMethodBadge(app.install_method, t);
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
                    size={40}
                  />
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: '14px',
                        cursor: onOpenDetail ? 'pointer' : 'default',
                        color: 'var(--text-primary)',
                      }}
                      onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                      title={onOpenDetail ? t('app.view_details') : undefined}
                    >
                      {appDisplayName}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0 }}>{app.version}</span>
                    {isFrozen && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'rgba(59, 130, 246, 0.15)',
                          border: '1px solid rgba(59, 130, 246, 0.35)',
                          color: 'var(--brand-primary)',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          flexShrink: 0,
                        }}
                      >
                        <Lock size={10} />
                        <span>{t('installed.locked')}</span>
                      </span>
                    )}
                    {isHidden && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          border: '1px solid rgba(239, 68, 68, 0.35)',
                          color: '#ef4444',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          flexShrink: 0,
                        }}
                      >
                        <EyeOff size={10} />
                        <span>{t('installed.hidden')}</span>
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: 'var(--brand-subtle)',
                        color: badge.color,
                        flexShrink: 0,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                      title={
                        app.install_path
                          ? `${t('installed.path_prefix', { path: app.install_path })} · ${t('installed.version_and_date', { version: app.version, date: formatAppDate(app.installed_at, i18n.language) })}`
                          : undefined
                      }
                    >
                      {app.install_path
                        ? t('installed.path_prefix', { path: app.install_path })
                        : t('installed.path_not_detected_hint')}{' '}
                      · {t('installed.version_and_date', { version: app.version, date: formatAppDate(app.installed_at, i18n.language) })}
                    </span>
                    {app.install_path ? (
                      <button
                        onClick={() => handleCopyPath(app.app_id, app.install_path)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--brand-primary)',
                          cursor: 'pointer',
                          fontSize: '11px',
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
                            fontSize: '11px',
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
    </div>
  );
};
