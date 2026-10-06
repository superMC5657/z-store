import React from 'react';
import { useTranslation } from 'react-i18next';
import { Play, MinusCircle } from 'lucide-react';
import type { InstalledApp } from '../../types';
import { FlyoutMenu } from '../../components/FlyoutMenu';

export interface InstalledItemActionsProps {
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

export const InstalledItemActions: React.FC<InstalledItemActionsProps> = ({
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
          <Play size={12} fill="currentColor" style={{ marginRight: '4px' }} />
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
