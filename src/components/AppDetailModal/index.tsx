import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { AppDetailViewModel, DownloadAssetResult, DownloadProgressPayload, OAuthUser, ReleaseAsset } from '../../types';
import { api } from '../../services/api';
import { getAppDisplayName, getAppDescription, getCategoryLabel, isInstallableAssetKind, isProductAssetName, sortAssetsByRelevance } from '../../utils/appHelper';
import { detectHostArch, detectHostOs } from '../hostEnv';
import { Header } from './Header';
import { InstallActions } from './InstallActions';
import { AssetList } from './AssetList';
import { ReadmeSection } from './ReadmeSection';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface AppDetailModalProps {
  app: AppDetailViewModel;
  isInstalled: boolean;
  isManaged?: boolean;
  isExploreMode?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  isInstallingGlobal?: boolean;
  isUninstallingGlobal?: boolean;
  /** 待确认态（summary 为空且详情尚未落定）：pending-empty 展示骨架占位，已确认-empty 才展示 Other。缺席时沿用旧语义（isLoading 即 pending）。 */
  platformPending?: boolean;
  oauthUser?: OAuthUser | null;
  onClose: () => void;
  onInstall: (id: string, assetName?: string, customInstallDir?: string) => Promise<any>;
  onLaunch: (id: string) => void;
  onUninstall?: (id: string) => Promise<void> | void;
  onUnmanage?: (id: string) => Promise<void> | void;
  onManageApp?: (id: string) => Promise<void> | void;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
  onOpenDeveloperProfile?: (developer: string) => void;
  onOpenAccountSettings?: () => void;
  onRetry?: (id: string) => void;
  onRefresh?: (id: string) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({
  app,
  isInstalled,
  isManaged = true,
  isExploreMode = false,
  isFavorite = false,
  isWatched = false,
  isInstallingGlobal = false,
  isUninstallingGlobal = false,
  platformPending,
  oauthUser = null,
  onClose,
  onInstall,
  onLaunch,
  onUninstall,
  onUnmanage,
  onManageApp,
  onToggleFavorite,
  onToggleWatch,
  onOpenDeveloperProfile,
  onOpenAccountSettings,
  onRetry,
  onRefresh,
}) => {
  const { t, i18n } = useTranslation();
  const displayName = getAppDisplayName(app);
  const displayDesc = getAppDescription(app, i18n.language);
  const displayCategory = getCategoryLabel(app.category, app.category_name, t);

  const [showAllAssets, setShowAllAssets] = useState(false);
  const [selectedAssetName, setSelectedAssetName] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressPayload | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isDownloadingOnly, setIsDownloadingOnly] = useState(false);
  const [downloadedFile, setDownloadedFile] = useState<DownloadAssetResult | null>(null);
  const [isRevealingFolder, setIsRevealingFolder] = useState(false);
  const effectiveIsInstalling = isInstalling || isInstallingGlobal;
  const effectiveIsBusy = effectiveIsInstalling || isDownloadingOnly;

  useEffect(() => {
    setSelectedAssetName(null);
    setInstallError(null);
    setDownloadProgress(null);
    setDownloadedFile(null);
    setIsDownloadingOnly(false);
  }, [app.id]);

  // 切换选用包时清空上一包的下载结果，避免“打开文件夹”指向旧文件
  useEffect(() => {
    setDownloadedFile(null);
  }, [selectedAssetName]);

  // 智能防抖防闪烁：若数据在 120ms 内极速返回（如命中 SQLite 缓存），不突兀显示大面积骨架屏跳变
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    if (app.isLoading) {
      const timer = setTimeout(() => {
        setShowSkeleton(true);
      }, 120);
      return () => clearTimeout(timer);
    } else {
      setShowSkeleton(false);
    }
  }, [app.isLoading]);

  // 监听实时下载进度事件
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let isMounted = true;
    api.onDownloadProgress((payload) => {
      if (!isMounted) return;
      // 任务隔离：仅消费归属当前应用的事件
      if (payload.task_id && payload.task_id.toLowerCase() !== app.id.toLowerCase()) {
        return;
      }
      setDownloadProgress(payload);
      if (payload.state === 'verified' || payload.state === 'completed_unverified') {
        setTimeout(() => {
          if (isMounted) setDownloadProgress(null);
        }, 3500);
      } else if (payload.state === 'error' || payload.state === 'tampered') {
        setTimeout(() => {
          if (isMounted) setDownloadProgress(null);
        }, 6000);
      }
    }).then((fn) => {
      if (!isMounted) {
        fn();
      } else {
        cleanup = fn;
      }
    });

    return () => {
      isMounted = false;
      if (cleanup) cleanup();
    };
  }, [app.id]);

  const currentOs = useMemo(() => detectHostOs(), []);
  const currentArch = useMemo(() => detectHostArch(), []);

  // 资产抽屉仅展示真实产物：过滤签名（.sig/.asc）、校验和与汇总文件、元数据（latest.json 等），
  // 并按宿主相关度（系统/架构/类型档位）降序，宿主最相关的排最前
  const releases = useMemo(() => {
    const products = Array.isArray(app.releases) ? app.releases.filter((r) => isProductAssetName(r?.name)) : [];
    return sortAssetsByRelevance(products, currentOs, currentArch);
  }, [app.releases, currentOs, currentArch]);

  const hasNoReleases = !releases || releases.length === 0;
  const isAuthExpired = Boolean(
    oauthUser?.is_expired ||
    app.changelog?.includes('401') ||
    app.changelog?.includes('凭据已失效') ||
    app.changelog?.includes('授权已失效')
  );

  const primaryAsset: ReleaseAsset | undefined = useMemo(() => {
    if (selectedAssetName) {
      const found = releases.find((r) => r.name === selectedAssetName);
      if (found) return found;
    }
    // 1. 优先：宿主系统与 CPU 架构精准完全一致 (例如 x86_64 宿主必须精准匹配 x86_64，绝不混入 32 位包)
    const exactArchMatch = releases.find(
      (r) => (r.os === currentOs || r.os === 'all') && r.arch === currentArch
    );
    if (exactArchMatch) return exactArchMatch;

    // 2. 次优：通用架构 (universal)
    const universalMatch = releases.find(
      (r) => (r.os === currentOs || r.os === 'all') && r.arch === 'universal'
    );
    if (universalMatch) return universalMatch;

    // 3. 兼容降级：x86_64 宿主向下兼容 32 位 x86 程序
    if (currentArch === 'x86_64') {
      const x86Match = releases.find(
        (r) => (r.os === currentOs || r.os === 'all') && r.arch === 'x86'
      );
      if (x86Match) return x86Match;
    }

    // 4. 排除相异架构（例如 Windows x86_64 宿主排除 aarch64）
    const oppositeArch = currentArch === 'x86_64' ? 'aarch64' : 'x86_64';
    const osWithoutOppositeArch = releases.find(
      (r) => (r.os === currentOs || r.os === 'all') && r.arch !== oppositeArch
    );
    if (osWithoutOppositeArch) return osWithoutOppositeArch;

    // 3. 兜底匹配系统
    const osMatch = releases.find((r) => r.os === currentOs || r.os === 'all');
    if (osMatch) return osMatch;

    return releases[0];
  }, [releases, selectedAssetName, currentOs, currentArch]);

  // 主按钮分流：宿主原生可装（Windows 下 msi/exe/便携 zip，本平台 tar.gz）走安装，其余走应用内仅下载（进度条 + 落盘，不调用安装）
  // tar 类便携包额外传入资产 os 做本平台门控：跨平台 tar 返回 false => 只显示下载按钮
  const canInstallPrimary = Boolean(primaryAsset && isInstallableAssetKind(primaryAsset.kind, currentOs, primaryAsset.os));

  // 应用内仅下载：复用安装通道的下载进度事件，完成后保留文件路径供“打开所在文件夹”
  const handleDownloadPrimary = async () => {
    if (!primaryAsset || isDownloadingOnly) return;
    // 浏览器预览无 Tauri 下载通道，回退到系统浏览器直链
    if (!isTauri) {
      api.openUrl(primaryAsset.download_url);
      return;
    }
    setInstallError(null);
    setDownloadedFile(null);
    setIsDownloadingOnly(true);
    try {
      const res = await api.downloadAsset(app.id, primaryAsset.name);
      setDownloadedFile(res);
    } catch (e) {
      setInstallError(String(e));
      setTimeout(() => {
        setInstallError(null);
      }, 5000);
    } finally {
      setIsDownloadingOnly(false);
    }
  };

  const handleRevealDownload = async () => {
    if (!downloadedFile || isRevealingFolder || !isTauri) return;
    setIsRevealingFolder(true);
    try {
      await api.showFileInFolder(downloadedFile.file_path);
    } catch (e) {
      setInstallError(String(e));
      setTimeout(() => {
        setInstallError(null);
      }, 5000);
    } finally {
      setIsRevealingFolder(false);
    }
  };

  const handleAction = async () => {
    if (isInstalled) {
      onLaunch(app.id);
      return;
    }

    setInstallError(null);
    try {
      setIsInstalling(true);
      let customInstallDir: string | undefined = undefined;
      // 如果目标是免安装便携版 (PortableZip / PortableTarball)，调用系统原生文件夹选择器让用户自主指定安装/解压位置
      const portableKind = (primaryAsset?.kind || '').toLowerCase();
      if (portableKind === 'portable_zip' || portableKind === 'portable_tarball') {
        const picked = await api.selectFolder();
        if (!picked) {
          // 用户主动取消了文件夹选择，优雅中止安装
          setIsInstalling(false);
          return;
        }
        customInstallDir = picked;
      }
      await onInstall(app.id, primaryAsset?.name, customInstallDir);
    } catch (e) {
      setInstallError(String(e));
      setTimeout(() => {
        setInstallError(null);
      }, 5000);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleOpenExternal = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    api.openUrl(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 顶部概览横幅 */}
        <Header
          app={app}
          displayName={displayName}
          displayDesc={displayDesc}
          displayCategory={displayCategory}
          primaryAsset={primaryAsset}
          platformPending={platformPending}
          oauthUser={oauthUser}
          isFavorite={isFavorite}
          isWatched={isWatched}
          onClose={onClose}
          onRefresh={onRefresh}
          onToggleFavorite={onToggleFavorite}
          onToggleWatch={onToggleWatch}
          onOpenDeveloperProfile={onOpenDeveloperProfile}
        />

        {/* 弹窗主体内容区 */}
        <div className="modal-body">
          {/* 操作交互卡片 */}
          <InstallActions
            app={app}
            displayName={displayName}
            releases={releases}
            primaryAsset={primaryAsset}
            hasNoReleases={hasNoReleases}
            isAuthExpired={isAuthExpired}
            canInstallPrimary={canInstallPrimary}
            currentOs={currentOs}
            currentArch={currentArch}
            selectedAssetName={selectedAssetName}
            showSkeleton={showSkeleton}
            downloadProgress={downloadProgress}
            installError={installError}
            showAllAssets={showAllAssets}
            onToggleShowAllAssets={() => setShowAllAssets((prev) => !prev)}
            isInstalled={isInstalled}
            isManaged={isManaged}
            isExploreMode={isExploreMode}
            isUninstallingGlobal={isUninstallingGlobal}
            downloadedFile={downloadedFile}
            isRevealingFolder={isRevealingFolder}
            isDownloadingOnly={isDownloadingOnly}
            effectiveIsInstalling={effectiveIsInstalling}
            effectiveIsBusy={effectiveIsBusy}
            onLaunch={onLaunch}
            onUninstall={onUninstall}
            onUnmanage={onUnmanage}
            onManageApp={onManageApp}
            onOpenAccountSettings={onOpenAccountSettings}
            onClose={onClose}
            onRevealDownload={handleRevealDownload}
            onDownloadPrimary={handleDownloadPrimary}
            onAction={handleAction}
          />

          {/* 完整发布产物抽屉列表（按宿主相关度排序；列表区独立滚动最多展示 3 行，标题常驻） */}
          <AssetList
            showAllAssets={showAllAssets}
            releases={releases}
            primaryAsset={primaryAsset}
            currentOs={currentOs}
            currentArch={currentArch}
            effectiveIsBusy={effectiveIsBusy}
            onSelectAsset={setSelectedAssetName}
            onOpenExternal={handleOpenExternal}
          />

          {/* 自述文档区块 */}
          <ReadmeSection
            app={app}
            displayDesc={displayDesc}
            showSkeleton={showSkeleton}
            onRetry={onRetry}
          />
        </div>
      </div>
    </div>
  );
};

export { Header } from './Header';
export { AssetList } from './AssetList';
export { InstallActions } from './InstallActions';
export { ReadmeSection } from './ReadmeSection';
export { IconLevelBadge } from './IconLevelBadge';
