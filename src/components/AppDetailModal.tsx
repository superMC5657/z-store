import React, { useEffect, useMemo, useState } from 'react';
import {
  User,
  Bug,
  Monitor,
  Clock,
  AlertTriangle,
  Trash2,
  PlusCircle,
  RotateCcw,
  RefreshCw,
  Play,
  CheckCircle2,
  KeyRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppDetailViewModel, DownloadAssetResult, DownloadProgressPayload, OAuthUser, ReleaseAsset } from '../types';
import { api, type AppIconCycleResult } from '../services/api';
import { AppIcon, invalidateIconCache } from './AppIcon';
import { notifyToast } from '../utils/notify';
import { VerifiedBadge } from './VerifiedBadge';
import { InlineConfirmButton } from './InlineConfirmButton';
import { formatBytes, getAppDisplayName, getAppDescription, getCategoryLabel, isInstallableAssetKind, isProductAssetName, sortAssetsByRelevance } from '../utils/appHelper';
import { PlatformIcon, ForgeIcon } from './icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import { detectHostArch, detectHostOs } from './hostEnv';
import { useDetailStarVerify } from './useDetailStarVerify';
import { useDetailReadme } from './useDetailReadme';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface AppDetailModalProps {
  app: AppDetailViewModel;
  isInstalled: boolean;
  isManaged?: boolean;
  isExploreMode?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  isInstallingGlobal?: boolean;
  isUninstallingGlobal?: boolean;
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

const ICON_LEVEL_NAMES: Record<number, string> = {
  1: '收录官方',
  2: '品牌库',
  3: '仓库文件',
  4: '文档Logo',
  5: '首字母',
};

export const AppDetailModal: React.FC<AppDetailModalProps> = ({
  app,
  isInstalled,
  isManaged = true,
  isExploreMode = false,
  isFavorite = false,
  isWatched = false,
  isInstallingGlobal = false,
  isUninstallingGlobal = false,
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
  const [isManaging, setIsManaging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccessNotice, setRefreshSuccessNotice] = useState(false);
  const [refreshErrorNotice, setRefreshErrorNotice] = useState<string | null>(null);

  // 图标轮换态（T3 刷新图标）
  const [iconCycle, setIconCycle] = useState<AppIconCycleResult | null>(null);
  const [isCyclingIcon, setIsCyclingIcon] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setIconCycle(null);
    if (!isTauri || !app.id) return;

    api
      .getAppIconCycle(app.id)
      .then((data) => {
        if (isMounted && data) {
          setIconCycle(data);
        }
      })
      .catch(() => {
        // 降级不崩
      });

    return () => {
      isMounted = false;
    };
  }, [app.id]);

  const isCataloged = Boolean(
    iconCycle?.is_cataloged ??
    iconCycle?.isCataloged ??
    (app.category && app.category !== 'external')
  );

  const totalLevels = iconCycle?.total_levels ?? iconCycle?.totalLevels ?? 5;
  const currentLevel = iconCycle?.level ?? 1;
  const nextLevel = currentLevel >= totalLevels ? 1 : currentLevel + 1;
  const nextLevelName = ICON_LEVEL_NAMES[nextLevel] || `L${nextLevel}`;
  const nextLevelTitle = `下一档：L${nextLevel}${nextLevelName} (${nextLevel}/${totalLevels})`;

  const effectiveIconOverride = useMemo(() => {
    if (!iconCycle) return undefined;
    if (iconCycle.level === 5 || iconCycle.is_fallback || iconCycle.isFallback) {
      return iconCycle.url || '';
    }
    return iconCycle.url;
  }, [iconCycle]);

  const handleCycleIcon = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isCyclingIcon || !isTauri || !app.id || isCataloged) return;
    setIsCyclingIcon(true);
    try {
      const res = await api.cycleAppIcon(app.id);
      if (res) {
        setIconCycle(res);
        invalidateIconCache(app.id);
        window.dispatchEvent(
          new CustomEvent('zstore:icon-changed', {
            detail: { appId: app.id, icon: res.url },
          })
        );
        const total = res.total_levels ?? res.totalLevels ?? 5;
        const name = ICON_LEVEL_NAMES[res.level] || '';
        notifyToast(`图标已切换为 L${res.level}${name} (${res.level}/${total})`, 'success');
      }
    } catch (err) {
      notifyToast(`切换图标失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setIsCyclingIcon(false);
    }
  };

  // FR-7: GitHub 标星（见 useDetailStarVerify）；已认证蓝标由 catalog 驱动展示（is_verified + VerifiedBadge）
  const {
    isStarred,
    isStarring,
    handleToggleStar,
  } = useDetailStarVerify({
    appId: app.id,
    owner: app.owner,
    repo: app.repo,
    appName: app.name,
    oauthLogin: oauthUser?.login,
    onRefresh,
  });

  // FR-7.3: 问题反馈 → 预填标题与正文直达仓库 Issues 新建页（复用 openUrl 外链通道）
  const handleOpenIssueFeedback = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = app.forge_host || 'github.com';
    const title = encodeURIComponent(`【反馈】${displayName} ${app.latest_version}`);
    const body = encodeURIComponent(
      `## 环境\n- Z-Store 客户端版本：桌面端\n- 应用版本：${app.latest_version}\n- 系统：${navigator.platform}\n\n## 问题描述\n\n## 复现步骤\n1. \n2. \n`
    );
    api.openUrl(`https://${host}/${app.owner}/${app.repo}/issues/new?title=${title}&body=${body}`);
  };

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

  const effectiveRefreshing = Boolean(isRefreshing || app.isRefreshing);

  const handleTriggerRefresh = async () => {
    if (!onRefresh || effectiveRefreshing) return;
    setIsRefreshing(true);
    setRefreshSuccessNotice(false);
    setRefreshErrorNotice(null);

    try {
      await onRefresh(app.id);
      setRefreshSuccessNotice(true);
      setTimeout(() => {
        setRefreshSuccessNotice(false);
      }, 2800);
    } catch (err) {
      setRefreshErrorNotice(String(err));
      setTimeout(() => {
        setRefreshErrorNotice(null);
      }, 3500);
    } finally {
      setIsRefreshing(false);
    }
  };

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

  // 主按钮分流：宿主原生可装（Windows 下 msi/exe/便携 zip）走安装，其余走应用内仅下载（进度条 + 落盘，不调用安装）
  const canInstallPrimary = Boolean(primaryAsset && isInstallableAssetKind(primaryAsset.kind, currentOs));

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
      // 如果目标是免安装便携版 (PortableZip)，调用系统原生文件夹选择器让用户自主指定安装/解压位置
      if (primaryAsset?.kind === 'portable_zip') {
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


  // README 文档渲染（见 useDetailReadme，含 zh-CN / en-US 变体局部切换）
  // AppDetail 若已带 readme_variants 则直接复用，不重调 getReadmeVariants；语言切换只切 activeMarkdown
  const {
    readmeHtml,
    handleReadmeClick,
    handleReadmeImageErrorCapture,
    readmeLang,
    setReadmeLang,
    hasZhVariant,
    hasEnVariant,
    isVariantsLoading,
  } = useDetailReadme({
    readmeMarkdown: app.readme_markdown,
    owner: app.owner,
    repo: app.repo,
    forgeHost: app.forge_host,
    appId: app.id,
    readmeVariants: (app as unknown as { readme_variants?: import('../services/api').ReadmeVariant[] }).readme_variants,
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 顶部概览横幅 */}
        <div className="modal-header">
          <div className="modal-actions-header" style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 10 }}>
            {onRefresh && (
              <button
                className={`modal-header-btn ${effectiveRefreshing ? 'btn-refreshing' : ''}`}
                onClick={handleTriggerRefresh}
                disabled={effectiveRefreshing}
                aria-label="强制从远端刷新应用信息与最新发布"
                title={effectiveRefreshing ? '正在从远端重新同步数据...' : '强制从远端刷新 (穿透本地缓存)'}
                style={{ color: effectiveRefreshing ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
              >
                <svg
                  className={effectiveRefreshing ? 'icon-spin' : ''}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
            )}
            {onToggleFavorite && (
              <button
                className="modal-header-btn"
                onClick={() => onToggleFavorite(app.id)}
                aria-label={isFavorite ? '取消应用内收藏' : '加入应用内收藏'}
                style={{ color: isFavorite ? '#eab308' : 'var(--text-secondary)' }}
                title={isFavorite ? '已加入应用内收藏（存入本地数据库 · 点击取消）' : '应用内收藏：保存至本机数据库，离线随时可用'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
            {onToggleWatch && (
              <button
                className="modal-header-btn"
                onClick={() => onToggleWatch(app.id)}
                aria-label={isWatched ? '取消关注 Release 更新' : '关注 Release 更新'}
                style={{ color: isWatched ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
                title={isWatched ? '已关注该应用的新版本动态（新 Release 发布时在应用内提醒 · 点击取消）' : '关注 Release 更新：该应用发布新版本时在应用内提醒'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
            <button
              className="modal-header-btn"
              onClick={handleToggleStar}
              disabled={isStarring}
              aria-label={isStarred ? '取消 GitHub 收藏' : 'GitHub 收藏 (Star)'}
              style={{
                color: isStarred ? '#eab308' : 'var(--text-secondary)',
                opacity: 1,
              }}
              title={
                isStarred
                  ? '已在 GitHub 标星并存入 z-store-list 列表（点击取消 GitHub 收藏）'
                  : oauthUser
                  ? oauthUser.has_list_scope
                    ? 'GitHub 收藏：在 GitHub 标星该仓库并存入 z-store-list 列表'
                    : 'GitHub 收藏：在 GitHub 标星（当前令牌缺少 user 权限，建议在设置中重新授权以同步至清单）'
                  : 'GitHub 收藏：在 GitHub 标星该仓库并存入列表（需在设置中登录或配置令牌）'
              }
            >
              {isStarring ? (
                <svg className="icon-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill={isStarred ? '#eab308' : 'none'} stroke={isStarred ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              )}
            </button>
            <button
              className="modal-close-btn"
              onClick={onClose}
              aria-label="关闭详情弹窗"
              style={{ position: 'relative', top: 'auto', right: 'auto' }}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>


          <AppIcon
            key={`${app.id}-${iconCycle?.level ?? 1}`}
            icon={app.icon}
            iconOverride={effectiveIconOverride}
            name={displayName}
            appId={app.id}
            iconBg={app.icon_bg}
            className="modal-app-icon"
          />

          <div className="modal-header-info">
            <div className="modal-app-title">
              <span>{displayName}</span>
              {app.is_verified && <VerifiedBadge size="md" />}
            </div>
            <div className="modal-app-repo" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {onOpenDeveloperProfile ? (
                <button
                  type="button"
                  onClick={() => onOpenDeveloperProfile(app.owner)}
                  className="btn-fluent btn-secondary"
                  style={{
                    padding: '2px 8px',
                    fontSize: 'var(--font-sm)',
                    fontWeight: 510,
                    borderRadius: 'var(--radius-xs)',
                    color: 'var(--brand-primary)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    lineHeight: '1.4',
                  }}
                  title={`查看 ${app.owner} 开发者全景与开源项目`}
                >
                  <User size={12} strokeWidth={1.5} />
                  <span>{app.owner}</span>
                </button>
              ) : (
                <span>{app.owner}</span>
              )}
              <span>/</span>
              <a
                href={app.forge_host ? `https://${app.forge_host}/${app.owner}/${app.repo}` : `https://github.com/${app.owner}/${app.repo}`}
                onClick={(e) => handleOpenExternal(e, app.forge_host ? `https://${app.forge_host}/${app.owner}/${app.repo}` : `https://github.com/${app.owner}/${app.repo}`)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontWeight: 510, color: 'inherit', textDecoration: 'none' }}
                title="在浏览器中查看开源仓库"
              >
                {app.repo} ↗
              </a>
              <span>·</span>
              <span>最新发布 {app.latest_version}</span>
              <span>·</span>
              <a
                href={`https://${app.forge_host || 'github.com'}/${app.owner}/${app.repo}/issues/new`}
                onClick={handleOpenIssueFeedback}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontWeight: 510, color: 'var(--brand-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                title="前往开源仓库提交问题反馈（自动预填版本信息）"
              >
                <Bug size={12} strokeWidth={1.5} />
                <span>问题反馈</span>
              </a>
              {isTauri && !isCataloged && (
                <button
                  type="button"
                  className="modal-icon-cycle-btn"
                  onClick={handleCycleIcon}
                  disabled={isCyclingIcon}
                  title={nextLevelTitle}
                  aria-label={nextLevelTitle}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--bg-card, #1e293b)',
                    border: '1px solid var(--border-color, rgba(255, 255, 255, 0.2))',
                    color: 'var(--text-secondary, #94a3b8)',
                    cursor: isCyclingIcon ? 'not-allowed' : 'pointer',
                    padding: 0,
                    flexShrink: 0,
                    transition: 'all 0.15s ease',
                    opacity: isCyclingIcon ? 0.6 : 1,
                  }}
                >
                  <RefreshCw
                    size={11}
                    className={isCyclingIcon ? 'icon-spin' : ''}
                  />
                </button>
              )}
            </div>
            {displayDesc && (
              <p
                className="modal-app-desc"
                style={{
                  fontSize: 'var(--font-base)',
                  color: 'var(--text-secondary)',
                  margin: '4px 0 10px 0',
                  lineHeight: '1.5',
                }}
              >
                {displayDesc}
              </p>
            )}
            <div className="modal-tags">
              <span className="modal-tag">★ {((app.stars || 0) / 1000).toFixed(1)}k</span>
              <span className="modal-tag">{app.license}</span>
              <span className="modal-tag">{displayCategory}</span>
              {app.platforms && app.platforms.length > 0 && (
                <span
                  className="modal-tag"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  title={`支持设备: ${app.platforms.map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p).join(', ')}`}
                >
                  <Monitor size={12} />
                  <span>支持端:</span>
                  {app.platforms.map((p) => (
                    <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                      <PlatformIcon platform={p} size={11} />
                      <span>{PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p}</span>
                    </span>
                  ))}
                </span>
              )}
              {app.forge && app.forge !== 'github' && (
                <span
                  className="modal-tag"
                  style={{
                    background: 'var(--brand-subtle)',
                    color: 'var(--brand-primary)',
                    border: '1px solid var(--border-nav-active)',
                    fontWeight: 510,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <ForgeIcon forge={app.forge} size={12} />
                  <span>{app.forge === 'codeberg' ? 'Codeberg 源' : app.forge === 'gitea' ? 'Gitea 源' : `${app.forge_host || app.forge}`}</span>
                </span>
              )}
              {primaryAsset && (
                <span className="modal-tag">大小 {formatBytes(primaryAsset.size_bytes)}</span>
              )}
              {app.is_stale && (
                <span
                  className="modal-tag"
                  style={{
                    background: 'rgba(245, 158, 11, 0.15)',
                    color: '#f59e0b',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    fontWeight: 510,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                  title="网络不可用或请求受限，当前正在呈现本地历史数据"
                >
                  <AlertTriangle size={11} strokeWidth={1.5} />
                  <span>离线缓存</span>
                </span>
              )}

              {/* 刷新状态与微动效反馈 */}
              {refreshSuccessNotice ? (
                <span
                  className="modal-tag modal-tag-success tag-spring-in"
                  title="已成功同步最新版本与文档数据"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已同步最新数据</span>
                </span>
              ) : refreshErrorNotice ? (
                <span
                  className="modal-tag modal-tag-error tag-spring-in"
                  title={`远端拉取失败: ${refreshErrorNotice}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <AlertTriangle size={11} />
                  <span>同步异常，请重试</span>
                </span>
              ) : effectiveRefreshing ? (
                <span className="modal-tag modal-tag-refreshing tag-spring-in">
                  <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} />
                  <span>正在同步最新数据...</span>
                </span>
              ) : (
                app.cached_at && !app.is_stale && (
                  <span
                    className="modal-tag"
                    style={{ fontSize: 'var(--font-xs)', opacity: 0.8, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    title={`最后缓存时间：${new Date(app.cached_at * 1000).toLocaleString()}`}
                  >
                    <Clock size={11} />
                    <span>{new Date(app.cached_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 缓存</span>
                  </span>
                )
              )}
            </div>
          </div>
        </div>

        {/* 弹窗主体内容区 */}
        <div className="modal-body">
          {/* 操作交互卡片 */}
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
                  onClick={() => setShowAllAssets(!showAllAssets)}
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
                        onClick={handleAction}
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
                      onClick={handleRevealDownload}
                      disabled={isRevealingFolder || isDownloadingOnly}
                      title="在系统文件管理器中定位已下载的文件"
                    >
                      {isRevealingFolder ? '正在打开…' : '打开文件夹'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-fluent btn-primary"
                    onClick={handleDownloadPrimary}
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
                  onClick={handleAction}
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

          {/* 完整发布产物抽屉列表（按宿主相关度排序；列表区独立滚动最多展示 3 行，标题常驻） */}
          {showAllAssets && (
            <div className="settings-group" style={{ marginBottom: 0 }}>
              <div className="settings-group-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>GitHub Release 原生构建设施产物</span>
                <span style={{ fontSize: 'var(--font-sm)', fontWeight: 'normal', color: 'var(--text-tertiary)' }}>
                  宿主环境匹配: {currentOs} ({currentArch})
                </span>
              </div>
              <div className="asset-list-scroll">
              {releases.map((asset) => {
                const isSelected = asset.name === primaryAsset?.name;
                return (
                  <div key={asset.name} className="settings-row" style={{ padding: '12px 20px' }}>
                    <div>
                      <div style={{ fontWeight: 510, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{asset.name}</span>
                        {isSelected && (
                          <span
                            className="modal-tag modal-tag-success"
                            style={{ fontSize: 'calc(10px * var(--font-scale))', padding: '1px 6px' }}
                          >
                            当前目标
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                        目标平台: {asset.os} ({asset.arch}) · 类型: {asset.kind} · 体积: {formatBytes(asset.size_bytes)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {asset.sha256 && (
                        <span
                          className="trust-hash text-mono"
                          title={`官方校验值: ${asset.sha256}`}
                          style={{ maxWidth: '120px' }}
                        >
                          SHA-256: {asset.sha256.slice(0, 10)}...
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedAssetName(asset.name)}
                        className={`btn-fluent ${isSelected ? 'btn-primary' : 'btn-secondary'} detail-asset-btn`}
                        disabled={effectiveIsBusy}
                        title={isSelected ? '当前正在使用该版本安装' : '将此包选为当前安装目标'}
                      >
                        {isSelected ? '✓ 已选用' : '选用此包'}
                      </button>
                      <a
                        href={asset.download_url}
                        onClick={(e) => handleOpenExternal(e, asset.download_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-fluent btn-secondary detail-asset-btn"
                        title="在浏览器中直接下载"
                      >
                        直链
                      </a>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* 自述文档区块 */}
          <div className="readme-preview">
            {app.loadError ? (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 'calc(15px * var(--font-scale))', color: 'var(--status-warning)', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <AlertTriangle size={15} />
                  <span>获取详情失败: {app.loadError}</span>
                </div>
                {onRetry && (
                  <button
                    className="btn-fluent btn-secondary"
                    onClick={() => onRetry(app.id)}
                    style={{ padding: '6px 18px', fontSize: 'var(--font-base)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <RotateCcw size={12} />
                    <span>重试加载</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  className="readme-lang-header"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    flexWrap: 'wrap',
                    marginBottom: '12px',
                  }}
                >
                  <div
                    style={{
                      flex: '1 1 160px',
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <h4
                      style={{
                        margin: 0,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      README
                    </h4>
                  </div>
                  <div
                    role="group"
                    aria-label={t('readme.lang_switch_label')}
                    title={t('readme.lang_switch_label')}
                    style={{
                      display: 'flex',
                      gap: '4px',
                      flexShrink: 0,
                      marginLeft: 'auto',
                    }}
                  >
                    <button
                      type="button"
                      className={`btn-fluent btn-sm ${readmeLang === 'zh-CN' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setReadmeLang('zh-CN')}
                      disabled={!hasZhVariant || isVariantsLoading}
                      aria-pressed={readmeLang === 'zh-CN'}
                      aria-label={`${t('readme.lang_switch_label')}: ${t('readme.lang_zh')}`}
                      title={t('readme.lang_zh')}
                      style={{ minWidth: '56px' }}
                    >
                      <span>{t('readme.lang_zh')}</span>
                    </button>
                    <button
                      type="button"
                      className={`btn-fluent btn-sm ${readmeLang === 'en-US' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setReadmeLang('en-US')}
                      disabled={!hasEnVariant || isVariantsLoading}
                      aria-pressed={readmeLang === 'en-US'}
                      aria-label={`${t('readme.lang_switch_label')}: ${t('readme.lang_en')}`}
                      title={t('readme.lang_en')}
                      style={{ minWidth: '56px' }}
                    >
                      <span>{t('readme.lang_en')}</span>
                    </button>
                  </div>
                </div>
                {app.isLoading && !readmeHtml ? (
                  showSkeleton ? (
                    <div style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div className="skeleton-box" style={{ width: '38%', height: '24px' }} />
                      <div className="skeleton-box" style={{ width: '95%', height: '14px' }} />
                      <div className="skeleton-box" style={{ width: '82%', height: '14px' }} />
                      <div className="skeleton-box" style={{ width: '88%', height: '14px' }} />
                      <div className="skeleton-box" style={{ width: '60%', height: '14px' }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', color: 'var(--text-tertiary)', fontSize: 'var(--font-base)' }}>
                        <span className="spinner-icon" />
                        <span>正在通过加速通道异步获取软件完整文档与变更日志...</span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: '28px 24px', color: 'var(--text-tertiary)', fontSize: 'var(--font-base)', lineHeight: '1.6' }}>
                      {displayDesc}
                    </div>
                  )
                ) : (
                  <div
                    className="readme-markdown-body"
                    dangerouslySetInnerHTML={{ __html: readmeHtml }}
                    onClick={handleReadmeClick}
                    onErrorCapture={handleReadmeImageErrorCapture}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
