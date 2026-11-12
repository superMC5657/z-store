import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  MinusCircle,
  MoreHorizontal,
  Play,
  Unlock,
} from 'lucide-react';
import type { InstalledApp } from '../../types';
import { FlyoutMenu } from '../../components/FlyoutMenu';
import { ManageMenuItem } from '../manage/ManageMenuItem';

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
  onOpenDetail?: (id: string) => void;
  onCopyPath?: (id: string, path: string) => void;
  onToggleMenu: (id: string, e: React.MouseEvent) => void;
  onCloseMenu: () => void;
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
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
  onOpenDetail,
  onCopyPath,
  onToggleMenu,
  onCloseMenu,
  onToggleRuleFrozen,
  onToggleRuleHidden,
}) => {
  const { t } = useTranslation();
  const isUnmanaging = confirmingUnmanageId === app.app_id;
  const isUninstalling = confirmingUninstallId === app.app_id;

  return (
    <div className="installed-actions-group">
      {/* 左侧区域：低权重卸载 / 二次确认操作 */}
      <div className="installed-actions-left">
        {isUninstallingLoading ? (
          <button
            type="button"
            className="installed-action-btn btn-installed-uninstall btn-loading"
            disabled
            title={t('installed.uninstalling_tooltip')}
          >
            {t('installed.uninstalling')}
          </button>
        ) : isUnmanaging ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              type="button"
              className="installed-action-btn btn-confirm-warning"
              onClick={() => onTriggerUnmanage(app.app_id)}
              title={t('installed.confirm_unmanage_tooltip')}
            >
              {t('installed.confirm_unmanage')}
            </button>
            <button
              type="button"
              className="installed-action-btn btn-confirm-cancel"
              onClick={onCancelConfirm}
              title={t('installed.cancel_confirm_tooltip')}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : isUninstalling ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              type="button"
              className="installed-action-btn btn-confirm-danger"
              onClick={() => onTriggerUninstall(app.app_id)}
              title={t('installed.confirm_uninstall_tooltip')}
            >
              {t('installed.confirm_uninstall')}
            </button>
            <button
              type="button"
              className="installed-action-btn btn-confirm-cancel"
              onClick={onCancelConfirm}
              title={t('installed.cancel_confirm_tooltip')}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="installed-action-btn btn-installed-uninstall"
            onClick={() => onTriggerUninstall(app.app_id)}
            title={t('installed.uninstall_tooltip')}
          >
            {t('installed.uninstall')}
          </button>
        )}
      </div>

      {/* 右侧区域：Outline [ ▶ 启动 ] + [ ··· 更多操作 ] */}
      <div className="installed-actions-right">
        <button
          type="button"
          className="manage-btn-action"
          disabled={isUninstallingLoading}
          onClick={() => onLaunch(app.app_id)}
          title={t('installed.launch_tooltip')}
        >
          <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          <span>{t('installed.launch')}</span>
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={`manage-btn-icon ${isMenuOpen ? 'active' : ''}`.trim()}
            disabled={isUninstallingLoading}
            onClick={(e) => onToggleMenu(app.app_id, e)}
            title={t('installed.more_options_tooltip')}
            aria-label={t('installed.more_options')}
          >
            <MoreHorizontal size={14} strokeWidth={1.5} />
          </button>

          <FlyoutMenu
            isOpen={isMenuOpen}
            onClose={onCloseMenu}
            align="right"
            width={210}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' }}>
              {onOpenDetail && (
                <ManageMenuItem
                  icon={<ExternalLink size={13} strokeWidth={1.5} />}
                  label={t('installed.view_details')}
                  onClick={() => {
                    onCloseMenu();
                    onOpenDetail(app.app_id);
                  }}
                />
              )}

              {app.install_path && onCopyPath && (
                <ManageMenuItem
                  icon={<Copy size={13} strokeWidth={1.5} />}
                  label={t('installed.copy_path_menu')}
                  onClick={() => {
                    onCloseMenu();
                    onCopyPath(app.app_id, app.install_path);
                  }}
                />
              )}

              {(onOpenDetail || (app.install_path && onCopyPath)) &&
                (onToggleRuleFrozen || onToggleRuleHidden) && <div className="flyout-divider" />}

              {onToggleRuleFrozen && (
                <ManageMenuItem
                  icon={
                    isFrozen ? (
                      <Unlock size={13} strokeWidth={1.5} />
                    ) : (
                      <Lock size={13} strokeWidth={1.5} />
                    )
                  }
                  label={isFrozen ? t('installed.unlock_version') : t('installed.lock_version')}
                  badge={isFrozen ? t('installed.locked') : undefined}
                  title={
                    isFrozen
                      ? t('installed.unlock_version_tooltip')
                      : t('installed.lock_version_tooltip')
                  }
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleFrozen(app.app_id, !isFrozen);
                  }}
                />
              )}

              {onToggleRuleHidden && (
                <ManageMenuItem
                  icon={
                    isHidden ? (
                      <Eye size={13} strokeWidth={1.5} />
                    ) : (
                      <EyeOff size={13} strokeWidth={1.5} />
                    )
                  }
                  label={isHidden ? t('installed.unhide_app') : t('installed.hide_app')}
                  badge={isHidden ? t('installed.hidden') : undefined}
                  title={
                    isHidden ? t('installed.unhide_app_tooltip') : t('installed.hide_app_tooltip')
                  }
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleHidden(app.app_id, !isHidden);
                  }}
                />
              )}

              <div className="flyout-divider" />

              <ManageMenuItem
                icon={<MinusCircle size={13} strokeWidth={1.5} />}
                label={t('installed.unmanage')}
                danger
                title={t('installed.unmanage_tooltip')}
                onClick={() => {
                  onCloseMenu();
                  onTriggerUnmanage(app.app_id);
                }}
              />
            </div>
          </FlyoutMenu>
        </div>
      </div>
    </div>
  );
};
