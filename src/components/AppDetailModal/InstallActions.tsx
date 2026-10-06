import React, { useState } from 'react';
import {
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  PlusCircle,
  Play,
  KeyRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppDetailViewModel, DownloadAssetResult, DownloadProgressPayload, ReleaseAsset } from '../../types';
import { InlineConfirmButton } from '../InlineConfirmButton';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface InstallActionsProps {
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
  isManaged: boolean;
  isUninstallingGlobal: boolean;
  downloadedFile: DownloadAssetResult | null;
  isRevealingFolder: boolean;
  isDownloadingOnly: boolean;
  effectiveIsInstalling: boolean;
  effectiveIsBusy: boolean;
  onLaunch: (id: string) => void;
  onUninstall?: (id: string) => Promise<void> | void;
  onUnmanage?: (id: string) => Promise<void> | void;
  onManageApp?: (id: string) => Promise<void> | void;
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
  onManageApp,
  onOpenAccountSettings,
  onClose,
  onRevealDownload,
  onDownloadPrimary,
  onAction,
}) => {
  const { t } = useTranslation();
  const [isManaging, setIsManaging] = useState(false);

  return (
    <div className="install-action-bar">
      <div className="install-action-left">
        <div
          className="install-asset-label"
          title={
            app.isLoading && hasNoReleases
              ? '正在获取最新发布版本...'
              : hasNoReleases && isAuthExpired
              ? 'GitHub 登录凭据已失效 · 请重新登录'
              : hasNoReleases
              ? '暂无匹配的安装包'
              : isInstalled
              ? isExploreMode
                ? '已安装'
                : isManaged
                ? '已安装就绪'
                : '本地已安装'
              : selectedAssetName
              ? canInstallPrimary
                ? `已选安装包 · ${primaryAsset?.os || ''} ${primaryAsset?.arch || ''}`
                : `已选文件 · ${primaryAsset?.os || ''} ${primaryAsset?.arch || ''}（仅下载）`
              : canInstallPrimary
              ? `推荐版本 · ${currentOs === 'windows' ? 'Windows' : currentOs} ${currentArch}`
              : `下载版本 · ${currentOs === 'windows' ? 'Windows' : currentOs} ${currentArch}`
          }
        >
          {app.isLoading && hasNoReleases
            ? '正在获取最新发布版本...'
            : hasNoReleases && isAuthExpired
            ? 'GitHub 登录凭据已失效 · 请重新登录'
            : hasNoReleases
            ? '暂无匹配的安装包'
            : isInstalled
            ? isExploreMode
              ? '已安装'
              : isManaged
              ? '已安装就绪'
              : '本地已安装'
            : selectedAssetName
            ? canInstallPrimary
              ? `已选安装包 · ${primaryAsset?.os || ''} ${primaryAsset?.arch || ''}`
              : `已选文件 · ${primaryAsset?.os || ''} ${primaryAsset?.arch || ''}（仅下载）`
            : canInstallPrimary
            ? `推荐版本 · ${currentOs === 'windows' ? 'Windows' : currentOs} ${currentArch}`
            : `下载版本 · ${currentOs === 'windows' ? 'Windows' : currentOs} ${currentArch}`}
        </div>
        <div
          className="install-asset-name"
          title={primaryAsset ? primaryAsset.name : `${displayName} 最新发布包`}
        >
          {app.isLoading && (!releases || releases.length === 0) && showSkeleton ? (
            <div className="skeleton-box" style={{ width: '240px', height: '18px', margin: '4px 0' }} />
          ) : primaryAsset ? (
            primaryAsset.name
          ) : (
            `${displayName} 最新发布包`
          )}
        </div>

        {downloadProgress && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {downloadProgress.state === 'downloading' && (
                  <>
                    <RotateCcw size={12} className="icon-spin" style={{ color: 'var(--brand-primary)' }} />
                    <span>{downloadProgress.message || '正在下载...'}</span>
                  </>
                )}
                {downloadProgress.state === 'verified' && (
                  <>
                    <CheckCircle2 size={12} style={{ color: '#10b981' }} />
                    <span>哈希匹配，防篡改校验通过</span>
                  </>
                )}
                {downloadProgress.state === 'completed_unverified' && (
                  <>
                    <CheckCircle2 size={12} style={{ color: '#10b981' }} />
                    <span>{canInstallPrimary ? '下载就绪，准备调用安装' : '下载完成，文件已保存到本地'}</span>
                  </>
                )}
                {downloadProgress.state === 'tampered' && (
                  <>
                    <AlertTriangle size={12} style={{ color: '#ef4444' }} />
                    <span>警告：文件篡改已拦截</span>
                  </>
                )}
                {downloadProgress.state === 'error' && (
                  <>
                    <AlertTriangle size={12} style={{ color: '#ef4444' }} />
                    <span>{downloadProgress.message || '下载异常中断'}</span>
                  </>
                )}
              </span>
              <span>
                {downloadProgress.state === 'error'
                  ? '中断'
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
            <span>{canInstallPrimary ? '安装异常：' : '下载异常：'}{installError}</span>
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
            {showAllAssets ? '收起资产' : `全部资产 (${releases.length})`}
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
                    confirmText="确认卸载？"
                    cancelTitle="取消操作"
                    onConfirm={() => onUninstall(app.id)}
                    disabled={isUninstallingGlobal}
                    title="彻底卸载应用"
                    timeoutMs={4000}
                  >
                    {isUninstallingGlobal ? (
                      '正在卸载...'
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Trash2 size={13} />
                        <span>卸载应用</span>
                      </span>
                    )}
                  </InlineConfirmButton>
                )}
              </>
            ) : !isManaged ? (
              <>
                {onManageApp && (
                  <button
                    type="button"
                    className="btn-fluent btn-secondary"
                    style={{
                      fontWeight: 510,
                      color: 'var(--brand-primary)',
                      borderColor: 'var(--border-nav-active)',
                    }}
                    disabled={isManaging}
                    onClick={async () => {
                      if (isManaging) return;
                      setIsManaging(true);
                      try {
                        await onManageApp(app.id);
                      } finally {
                        setIsManaging(false);
                      }
                    }}
                    title="加入管理：将本地已安装应用加入列表，支持版本检测与快捷更新"
                  >
                    {isManaging ? '正在添加...' : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <PlusCircle size={13} />
                        <span>加入管理</span>
                      </span>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-fluent btn-secondary"
                  onClick={onAction}
                  title="通过 Z-Store 重新下载安装最新版本或覆盖安装"
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <RotateCcw size={13} />
                    <span>覆盖/重装</span>
                  </span>
                </button>
              </>
            ) : (
              <>
                {onUnmanage && (
                  <InlineConfirmButton
                    variant="secondary"
                    confirmVariant="danger"
                    confirmText="确认取消管理？"
                    cancelTitle="取消操作"
                    onConfirm={() => onUnmanage(app.id)}
                    disabled={isUninstallingGlobal}
                    title="取消管理：仅从列表中移除管理记录，保留本机应用与数据"
                    timeoutMs={4000}
                  >
                    <span>取消管理</span>
                  </InlineConfirmButton>
                )}

                {onUninstall && (
                  <InlineConfirmButton
                    variant="danger"
                    confirmVariant="danger"
                    confirmText="确认卸载？"
                    cancelTitle="取消操作"
                    onConfirm={() => onUninstall(app.id)}
                    disabled={isUninstallingGlobal}
                    title="彻底卸载应用"
                    timeoutMs={4000}
                  >
                    {isUninstallingGlobal ? (
                      '正在卸载...'
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Trash2 size={13} />
                        <span>卸载应用</span>
                      </span>
                    )}
                  </InlineConfirmButton>
                )}
              </>
            )}

            <button
              type="button"
              className="btn-fluent btn-primary"
              disabled={isUninstallingGlobal}
              onClick={() => onLaunch(app.id)}
              style={{ fontWeight: 510, display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Play size={13} strokeWidth={1.5} />
              <span>{t('app.launch')}</span>
            </button>
          </>
        ) : hasNoReleases && !app.isLoading ? (
          isAuthExpired && onOpenAccountSettings ? (
            <button
              type="button"
              className="btn-fluent btn-secondary"
              onClick={() => {
                onClose();
                onOpenAccountSettings();
              }}
              style={{ minWidth: '120px', fontWeight: 510, color: '#eab308', borderColor: 'rgba(234, 179, 8, 0.4)' }}
              title="前往设置重新授权登录 GitHub"
            >
              <KeyRound size={13} strokeWidth={1.5} style={{ marginRight: '4px' }} />
              <span>重新登录 GitHub</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn-fluent btn-secondary"
              disabled
              style={{ minWidth: '120px', fontWeight: 510, opacity: 0.6 }}
            >
              暂无可用安装包
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
                title="在系统文件管理器中定位已下载的文件"
              >
                {isRevealingFolder ? '正在打开…' : '打开文件夹'}
              </button>
            )}
            <button
              type="button"
              className="btn-fluent btn-primary"
              onClick={onDownloadPrimary}
              disabled={effectiveIsBusy}
              style={{ minWidth: '120px', fontWeight: 510 }}
              title="通过应用内下载通道保存该文件到下载目录，不调用安装"
            >
              {isDownloadingOnly ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span className="spinner-icon" style={{ width: '13px', height: '13px', borderWidth: '2px' }} />
                  <span>下载中...</span>
                </span>
              ) : downloadedFile ? (
                '重新下载'
              ) : (
                '下载'
              )}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn-fluent btn-primary"
            onClick={onAction}
            disabled={effectiveIsBusy || Boolean(app.isLoading && hasNoReleases)}
            style={{ minWidth: '120px', fontWeight: 510, opacity: app.isLoading && hasNoReleases ? 0.75 : 1 }}
          >
            {app.isLoading && hasNoReleases ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span className="spinner-icon" />
                <span>检索版本中...</span>
              </span>
            ) : effectiveIsInstalling ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span className="spinner-icon" style={{ width: '13px', height: '13px', borderWidth: '2px' }} />
                <span>向导运行中 / 正在安装...</span>
              </span>
            ) : (
              '安装'
            )}
          </button>
        )}
      </div>
    </div>
  );
};
