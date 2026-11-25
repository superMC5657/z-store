import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Lock,
  MinusCircle,
  MoreHorizontal,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
  Unlock,
} from 'lucide-react';
import type { InstalledApp, UpdateItem } from '../../types';
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
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<boolean | void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<boolean | void>;
  /** 该行有可用更新时传入：主按钮由「启动」换为「更新」，「启动」收进更多菜单。 */
  updateActions?: RowUpdateActions;
}

/** 有可用更新的行的更新状态与动作（已绑定到该行）。 */
export interface RowUpdateActions {
  item: UpdateItem;
  isUpdating: boolean;
  /** 批量更新或检查进行中，行内更新按钮暂不可点。 */
  isBlocked: boolean;
  isChangelogOpen: boolean;
  onToggleChangelog: () => void;
  onApply: () => void;
  onSkip?: () => Promise<boolean | void>;
}

/** 卸载 / 取消管理二次确认的按钮样式与文案键。 */
const CONFIRM_VARIANTS = {
  uninstall: {
    className: 'btn-confirm-danger',
    label: 'installed.confirm_uninstall',
    tooltip: 'installed.confirm_uninstall_tooltip',
  },
  unmanage: {
    className: 'btn-confirm-warning',
    label: 'installed.confirm_unmanage',
    tooltip: 'installed.confirm_unmanage_tooltip',
  },
} as const;

/** 已装行固定宽度的动作簇，支持就地展开卸载/取消管理的二次确认。 */
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
  updateActions,
}) => {
  const { t } = useTranslation();
  const confirming =
    confirmingUninstallId === app.app_id
      ? 'uninstall'
      : confirmingUnmanageId === app.app_id
        ? 'unmanage'
        : null;

  if (isUninstallingLoading) {
    return (
      <div className="installed-actions-group">
        <button
          type="button"
          className="installed-action-btn btn-loading"
          disabled
          title={t('installed.uninstalling_tooltip')}
        >
          {t('installed.uninstalling')}
        </button>
      </div>
    );
  }

  if (confirming) {
    const variant = CONFIRM_VARIANTS[confirming];
    const onConfirm = confirming === 'uninstall' ? onTriggerUninstall : onTriggerUnmanage;
    return (
      <div className="installed-actions-group" role="group" aria-live="polite">
        <button
          type="button"
          className={`installed-action-btn ${variant.className}`}
          onClick={() => onConfirm(app.app_id)}
          title={t(variant.tooltip)}
        >
          {t(variant.label)}
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
    );
  }

  const u = updateActions;
  const changelogLabel = u?.isChangelogOpen
    ? t('installed.collapse_changelog')
    : t('installed.view_changelog');
  const hasNavItems = Boolean(u) || Boolean(onOpenDetail) || Boolean(app.install_path && onCopyPath);
  const hasRuleItems = Boolean(onToggleRuleFrozen) || Boolean(onToggleRuleHidden) || Boolean(u?.onSkip);

  return (
    <div className="installed-actions-group">
      {u && (
        <button
          type="button"
          className={`manage-btn-icon ${u.isChangelogOpen ? 'active' : ''}`.trim()}
          aria-expanded={u.isChangelogOpen}
          aria-label={changelogLabel}
          title={changelogLabel}
          onClick={u.onToggleChangelog}
        >
          <FileText size={14} strokeWidth={1.5} />
        </button>
      )}

      {u ? (
        <button
          type="button"
          className="manage-btn-action is-update"
          disabled={u.isUpdating || u.isBlocked}
          onClick={u.onApply}
          title={t('installed.latest_version', { version: u.item.latest_version })}
        >
          {u.isUpdating ? (
            <RotateCcw size={13} strokeWidth={1.5} className="icon-spin" aria-hidden="true" />
          ) : (
            <Download size={13} strokeWidth={1.5} aria-hidden="true" />
          )}
          <span>{u.isUpdating ? t('installed.updating') : t('installed.update_now')}</span>
        </button>
      ) : (
        <button
          type="button"
          className="manage-btn-action"
          onClick={() => onLaunch(app.app_id)}
          title={t('installed.launch_tooltip')}
        >
          <Play size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('installed.launch')}</span>
        </button>
      )}

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className={`manage-btn-icon ${isMenuOpen ? 'active' : ''}`.trim()}
          onClick={(e) => onToggleMenu(app.app_id, e)}
          title={t('installed.more_options_tooltip')}
          aria-label={t('installed.more_options')}
        >
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>

        <FlyoutMenu isOpen={isMenuOpen} onClose={onCloseMenu} align="right" width={210}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' }}>
            {u && (
              <ManageMenuItem
                icon={<Play size={13} strokeWidth={1.5} />}
                label={t('installed.launch')}
                title={t('installed.launch_tooltip')}
                onClick={() => {
                  onCloseMenu();
                  onLaunch(app.app_id);
                }}
              />
            )}

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

            {hasNavItems && hasRuleItems && <div className="flyout-divider" />}

            {u?.onSkip && (
              <ManageMenuItem
                icon={<SkipForward size={13} strokeWidth={1.5} />}
                label={t('installed.skip_version')}
                title={t('installed.skip_version_tooltip')}
                onClick={async () => {
                  onCloseMenu();
                  await u.onSkip?.();
                }}
              />
            )}

            {onToggleRuleFrozen && (
              <ManageMenuItem
                icon={isFrozen ? <Unlock size={13} strokeWidth={1.5} /> : <Lock size={13} strokeWidth={1.5} />}
                label={isFrozen ? t('installed.unlock_version') : t('installed.lock_version')}
                badge={isFrozen ? t('installed.locked') : undefined}
                title={isFrozen ? t('installed.unlock_version_tooltip') : t('installed.lock_version_tooltip')}
                onClick={async () => {
                  onCloseMenu();
                  await onToggleRuleFrozen(app.app_id, !isFrozen);
                }}
              />
            )}

            {onToggleRuleHidden && (
              <ManageMenuItem
                icon={isHidden ? <Eye size={13} strokeWidth={1.5} /> : <EyeOff size={13} strokeWidth={1.5} />}
                label={isHidden ? t('installed.unhide_app') : t('installed.hide_app')}
                badge={isHidden ? t('installed.hidden') : undefined}
                title={isHidden ? t('installed.unhide_app_tooltip') : t('installed.hide_app_tooltip')}
                onClick={async () => {
                  onCloseMenu();
                  await onToggleRuleHidden(app.app_id, !isHidden);
                }}
              />
            )}

            <div className="flyout-divider" />

            <ManageMenuItem
              icon={<Trash2 size={13} strokeWidth={1.5} />}
              label={t('installed.uninstall')}
              danger
              title={t('installed.uninstall_tooltip')}
              onClick={() => {
                onCloseMenu();
                onTriggerUninstall(app.app_id);
              }}
            />

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
  );
};
