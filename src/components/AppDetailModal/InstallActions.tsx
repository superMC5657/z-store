import React from 'react';
import {
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  Play,
  KeyRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppDetailViewModel, DownloadAssetResult, DownloadProgressPayload, ReleaseAsset } from '../../types';
import { InlineConfirmButton } from '../InlineConfirmButton';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface InstallActionsProps {
  app: AppDetailViewModel;
  displayName: string;
  releases: ReleaseAsset[];
  primaryAsset?: ReleaseAsset;
  hasNoReleases: boolean;
  isAuthExpired: boolean;
  canInstallPrimary: boolean;
  currentOs: string;
  currentArch: string;
  selectedAssetName: string | null;
  showSkeleton: boolean;
  downloadProgress: DownloadProgressPayload | null;
  installError: string | null;
  showAllAssets: boolean;
  onToggleShowAllAssets: () => void;
  isInstalled: boolean;
  isExploreMode: boolean;
  /** 已纳管。显式 `null` = managed 列表尚未加载（未知）：中性占位。 */
  isManaged: boolean | null;
  isUninstallingGlobal: boolean;
  downloadedFile: DownloadAssetResult | null;
  isRevealingFolder: boolean;
  isDownloadingOnly: boolean;
  effectiveIsInstalling: boolean;
  effectiveIsBusy: boolean;
  onLaunch: (id: string) => void;
  onUninstall?: (id: string) => Promise<void> | void;
  onUnmanage?: (id: string) => Promise<void> | void;
  onOpenAccountSettings?: () => void;
  onClose: () => void;
  onRevealDownload: () => void;
  onDownloadPrimary: () => void;
  onAction: () => void;
}

export const InstallActions: React.FC<InstallActionsProps> = ({
  app,
  displayName,
  releases,
  primaryAsset,
  hasNoReleases,
  isAuthExpired,
  canInstallPrimary,
  currentOs,
  currentArch,
  selectedAssetName,
  showSkeleton,
  downloadProgress,
  installError,
  showAllAssets,
  onToggleShowAllAssets,
  isInstalled,
  isExploreMode,
  isManaged,
  isUninstallingGlobal,
  downloadedFile,
  isRevealingFolder,
  isDownloadingOnly,
  effectiveIsInstalling,
  effectiveIsBusy,
  onLaunch,
  onUninstall,
  onUnmanage,
  onOpenAccountSettings,
  onClose,
  onRevealDownload,
  onDownloadPrimary,
  onAction,
}) => {
  const { t } = useTranslation();
  // 已纳管绿已安装；未纳管走获取安装。
  // 三态：isManaged===null（未知）+ 已安装 = 未知，中性占位。
  const isUnknown = isInstalled && isManaged === null;

  const statusLabel =
    app.isLoading && hasNoReleases
      ? t('detail.install.fetching_releases')
      : hasNoReleases && isAuthExpired
      ? t('detail.install.credentials_expired')
      : hasNoReleases
      ? t('detail.install.no_matching_asset')
      : isInstalled
      ? isExploreMode
        ? t('detail.install.status_installed')
        : isUnknown
        ? t('detail.install.confirming_status')
        : t('detail.install.ready')
      : selectedAssetName
      ? canInstallPrimary
        ? t('detail.install.selected_package', { os: primaryAsset?.os || '', arch: primaryAsset?.arch || '' })
        : t('detail.install.selected_file_download_only', { os: primaryAsset?.os || '', arch: primaryAsset?.arch || '' })
      : canInstallPrimary
      ? t('detail.install.recommended_version', { os: currentOs === 'windows' ? 'Windows' : currentOs, arch: currentArch })
      : t('detail.install.download_version', { os: currentOs === 'windows' ? 'Windows' : currentOs, arch: currentArch });
  const statusTitle = statusLabel;
  const statusText = statusLabel;
  const statusBadge = isUnknown ? 'unknown' : isInstalled && isManaged ? 'managed' : 'none';

  return (
    <div className="install-action-bar">
      <div className="install-action-left">
        <div
          className="install-asset-label"
          data-badge={statusBadge}
          title={statusTitle}
        >
          {statusText}
        </div>
        <div
          className="install-asset-name"
          title={primaryAsset ? primaryAsset.name : t('detail.install.latest_package', { name: displayName })}
        >
          {app.isLoading && (!releases || releases.length === 0) && showSkeleton ? (
            <div className="skeleton-box" style={{ width: '240px', height: '18px', margin: '4px 0' }} />
          ) : primaryAsset ? (
            primaryAsset.name
          ) : (
            t('detail.install.latest_package', { name: displayName })
          )}
        </div>

        {downloadProgress && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {downloadProgress.state === 'downloading' && (
                  <>
                    <RotateCcw size={12} className="icon-spin" style={{ color: 'var(--brand-primary)' }} />
                    <span>{downloadProgress.message || t('detail.install.downloading')}</span>
                  </>
                )}
                {downloadProgress.state === 'verified' && (
                  <>
                    <CheckCircle2 size={12} style={{ color: '#10b981' }} />
                    <span>{t('detail.install.hash_verified')}</span>
                  </>
                )}
                {downloadProgress.state === 'completed_unverified' && (
                  <>
                    <CheckCircle2 size={12} style={{ color: '#10b981' }} />
                    <span>{canInstallPrimary ? t('detail.install.download_ready_install') : t('detail.install.download_complete_saved')}</span>
                  </>
                )}
                {downloadProgress.state === 'tampered' && (
                  <>
                    <AlertTriangle size={12} style={{ color: '#ef4444' }} />
                    <span>{t('detail.install.tamper_blocked')}</span>
                  </>
                )}
                {downloadProgress.state === 'error' && (
                  <>
                    <AlertTriangle size={12} style={{ color: '#ef4444' }} />
                    <span>{downloadProgress.message || t('detail.install.download_aborted')}</span>
                  </>
                )}
              </span>
              <span>
                {downloadProgress.state === 'error'
                  ? t('detail.install.aborted')
                  : `${(downloadProgress.speed_bytes_per_sec / 1024 / 1024).toFixed(1)} MB/s`}
              </span>
            </div>
            <div className="install-progress-bar-container">
              <div
                className={`install-progress-bar ${downloadProgress.state === 'error' ? 'install-progress-bar-error' : ''}`}
                style={{
                  width: downloadProgress.total_bytes
                    ? `${Math.min(100, (downloadProgress.downloaded_bytes / downloadProgress.total_bytes) * 100)}%`
                    : '75%',
                  backgroundColor: downloadProgress.state === 'error' ? '#ef4444' : undefined,
                }}
              />
            </div>
            {downloadProgress.state === 'error' && downloadProgress.message && (
              <div style={{ fontSize: 'var(--font-xs)', color: '#ef4444', marginTop: '4px' }}>
                {downloadProgress.message}
              </div>
            )}
          </div>
        )}

        {installError && !downloadProgress && (
          <div style={{ marginTop: '8px', fontSize: 'var(--font-sm)', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={12} />
            <span>{canInstallPrimary ? t('detail.install.install_error_prefix') : t('detail.install.download_error_prefix')}{installError}</span>
          </div>
        )}
      </div>

      <div className="install-action-buttons">
        {releases && releases.length > 1 && (
          <button
            type="button"
            className="btn-fluent btn-secondary"
            onClick={onToggleShowAllAssets}
          >
            {showAllAssets ? t('detail.install.collapse_assets') : t('detail.install.all_assets', { count: releases.length })}
          </button>
        )}

        {isInstalled ? (
          <>
            {isExploreMode ? (
              // 发现与探索模式：纯粹的应用商店体验，不展示任何管理相关操作
              <>
                {onUninstall && (
                  <InlineConfirmButton
                    variant="danger"
                    confirmVariant="danger"
                    confirmText={t('detail.install.confirm_uninstall')}
                    cancelTitle={t('detail.install.cancel_action')}
                    onConfirm={() => onUninstall(app.id)}
                    disabled={isUninstallingGlobal}
                    title={t('detail.install.uninstall_title')}
                    timeoutMs={4000}
                  >
                    {isUninstallingGlobal ? (
                      t('detail.install.uninstalling')
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Trash2 size={13} />
                        <span>{t('detail.install.uninstall_btn')}</span>
                      </span>
                    )}
                  </InlineConfirmButton>
                )}
              </>
            ) : isUnknown ? (
              // 未知态中性占位（单色骨架，不可交互）
              <button
                type="button"
                className="btn-fluent btn-secondary"
                disabled
                data-badge="unknown"
                title={t('detail.install.confirming_status')}
                aria-label={t('detail.install.confirming_status')}
                style={{ opacity: 0.65, cursor: 'default' }}
              >
                <span
                  aria-hidden="true"
                  className="skeleton-box"
                  style={{ width: '64px', height: '12px', borderRadius: '3px', display: 'inline-block' }}
                />
              </button>
            ) : (
              <>
                {onUnmanage && (
                  <InlineConfirmButton
                    variant="secondary"
                    confirmVariant="danger"
                    confirmText={t('detail.install.confirm_unmanage')}
                    cancelTitle={t('detail.install.cancel_action')}
                    onConfirm={() => onUnmanage(app.id)}
                    disabled={isUninstallingGlobal}
                    title={t('detail.install.unmanage_title')}
                    timeoutMs={4000}
                  >
                    <span>{t('detail.install.unmanage_btn')}</span>
                  </InlineConfirmButton>
                )}

                {onUninstall && (
                  <InlineConfirmButton
                    variant="danger"
                    confirmVariant="danger"
                    confirmText={t('detail.install.confirm_uninstall')}
                    cancelTitle={t('detail.install.cancel_action')}
                    onConfirm={() => onUninstall(app.id)}
                    disabled={isUninstallingGlobal}
                    title={t('detail.install.uninstall_title')}
                    timeoutMs={4000}
                  >
                    {isUninstallingGlobal ? (
                      t('detail.install.uninstalling')
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Trash2 size={13} />
                        <span>{t('detail.install.uninstall_btn')}</span>
                      </span>
                    )}
                  </InlineConfirmButton>
                )}
              </>
            )}

            <button
              type="button"
              className="btn-fluent btn-primary"
              disabled={isUninstallingGlobal || isUnknown}
              onClick={() => onLaunch(app.id)}
              style={isUnknown ? { display: 'none' } : undefined}
            >
              <Play size={13} strokeWidth={1.5} />
              <span>{t('app.launch')}</span>
            </button>
          </>
        ) : hasNoReleases && !app.isLoading ? (
          isAuthExpired && onOpenAccountSettings ? (
            <button
              type="button"
              className="btn-fluent btn-warning"
              onClick={() => {
                onClose();
                onOpenAccountSettings();
              }}
              style={{ minWidth: '120px' }}
              title={t('detail.install.reauth_title')}
            >
              <KeyRound size={13} strokeWidth={1.5} />
              <span>{t('detail.install.reauth_btn')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn-fluent btn-secondary"
              disabled
              style={{ minWidth: '120px', opacity: 0.6 }}
            >
              {t('detail.install.no_assets_available')}
            </button>
          )
        ) : !canInstallPrimary && primaryAsset ? (
          <>
            {downloadedFile && isTauri && (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                onClick={onRevealDownload}
                disabled={isRevealingFolder || isDownloadingOnly}
                title={t('detail.install.reveal_folder_title')}
              >
                {isRevealingFolder ? t('detail.install.opening_folder') : t('detail.install.open_folder')}
              </button>
            )}
            <button
              type="button"
              className="btn-fluent btn-primary"
              onClick={onDownloadPrimary}
              disabled={effectiveIsBusy}
              style={{ minWidth: '120px' }}
              title={t('detail.install.download_only_title')}
            >
              {isDownloadingOnly ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span className="spinner-icon" style={{ width: '13px', height: '13px', borderWidth: '2px' }} />
                  <span>{t('detail.install.downloading_btn')}</span>
                </span>
              ) : downloadedFile ? (
                t('detail.install.redownload')
              ) : (
                t('detail.install.download')
              )}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn-fluent btn-primary"
            onClick={onAction}
            disabled={effectiveIsBusy || Boolean(app.isLoading && hasNoReleases)}
            style={{ minWidth: '120px', opacity: app.isLoading && hasNoReleases ? 0.75 : 1 }}
          >
            {app.isLoading && hasNoReleases ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span className="spinner-icon" />
                <span>{t('detail.install.inspecting_version')}</span>
              </span>
            ) : effectiveIsInstalling ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span className="spinner-icon" style={{ width: '13px', height: '13px', borderWidth: '2px' }} />
                <span>{t('detail.install.installing')}</span>
              </span>
            ) : (
              t('detail.install.install')
            )}
          </button>
        )}
      </div>
    </div>
  );
};
