import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { AppDetail, DownloadProgressPayload, OAuthUser, ReleaseAsset } from '../types';
import { api } from '../services/api';
import { AppIcon } from './AppIcon';
import { sanitizeHtml } from '../utils/sanitize';
import { notifyToast } from '../utils/notify';

interface AppDetailModalProps {
  app: AppDetail;
  isInstalled: boolean;
  isManaged?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
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
  onRetry?: (id: string) => void;
  onRefresh?: (id: string) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({
  app,
  isInstalled,
  isManaged = true,
  isFavorite = false,
  isWatched = false,
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
  onRetry,
  onRefresh,
}) => {
  const [showAllAssets, setShowAllAssets] = useState(false);
  const [selectedAssetName, setSelectedAssetName] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressPayload | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isManaging, setIsManaging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccessNotice, setRefreshSuccessNotice] = useState(false);
  const [refreshErrorNotice, setRefreshErrorNotice] = useState<string | null>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [confirmingUnmanage, setConfirmingUnmanage] = useState(false);
  // FR-7: GitHub 标星态（仅登录可见；后端未就绪时一律按未标星降级）
  const [isStarred, setIsStarred] = useState(false);
  const [isStarring, setIsStarring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!oauthUser) {
      setIsStarred(false);
      return;
    }
    api.isStarred(app.id).then((v) => {
      if (!cancelled) setIsStarred(v);
    }).catch(() => {
      if (!cancelled) setIsStarred(false);
    });
    return () => {
      cancelled = true;
    };
  }, [app.id, oauthUser]);

  const handleToggleStar = async () => {
    if (!oauthUser || isStarring) return;
    setIsStarring(true);
    try {
      if (isStarred) {
        await api.unstarApp(app.id);
        setIsStarred(false);
        notifyToast(`已取消对 ${app.name} 的标星`, 'info');
      } else {
        await api.starApp(app.id);
        setIsStarred(true);
        notifyToast(`已在 GitHub 上标星 ${app.name} ★`, 'success');
      }
    } catch (e) {
      notifyToast(`标星操作失败: ${String(e)}`, 'error');
    } finally {
      setIsStarring(false);
    }
  };

  // FR-7.3: 问题反馈 → 预填标题与正文直达仓库 Issues 新建页（复用 openUrl 外链通道）
  const handleOpenIssueFeedback = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = app.forge_host || 'github.com';
    const title = encodeURIComponent(`【反馈】${app.name} ${app.latest_version}`);
    const body = encodeURIComponent(
      `## 环境\n- Z-Store 客户端版本：桌面端\n- 应用版本：${app.latest_version}\n- 系统：${navigator.platform}\n\n## 问题描述\n\n## 复现步骤\n1. \n2. \n`
    );
    api.openUrl(`https://${host}/${app.owner}/${app.repo}/issues/new?title=${title}&body=${body}`);
  };

  useEffect(() => {
    setSelectedAssetName(null);
    setInstallError(null);
    setDownloadProgress(null);
    setConfirmingUninstall(false);
    setConfirmingUnmanage(false);
  }, [app.id]);

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
      if (payload.state === 'completed' || payload.state === 'verified' || payload.state === 'completed_unverified') {
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

  const currentOs = useMemo(() => {
    if (typeof navigator === 'undefined') return 'windows';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'windows';
  }, []);

  const currentArch = useMemo(() => {
    if (typeof navigator === 'undefined') return 'x86_64';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('arm64') || ua.includes('aarch64')) return 'aarch64';
    return 'x86_64';
  }, []);

  const releases = useMemo(() => {
    if (Array.isArray(app.releases)) return app.releases;
    if (Array.isArray(app.assets)) return app.assets;
    return [];
  }, [app.releases, app.assets]);

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

  const formatBytes = (bytes?: number) => {
    if (!bytes || typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i] || 'MB'}`;
  };

  // 避免高频下载进度事件重绘时重复同步解析庞大的 Markdown 文档阻塞渲染主线程，并执行严格 AST 级 XSS 净化
  const readmeHtml = useMemo(() => {
    if (!app.readme_markdown) return '';
    const rawParsed = marked.parse(app.readme_markdown, { async: false }) as string;
    return sanitizeHtml(rawParsed);
  }, [app.readme_markdown]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header Hero */}
        <div className="modal-header">
          <div className="modal-actions-header" style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 10 }}>
            {onRefresh && (
              <button
                className={`modal-close-btn ${effectiveRefreshing ? 'btn-refreshing' : ''}`}
                onClick={handleTriggerRefresh}
                disabled={effectiveRefreshing}
                aria-label="强制从远端刷新应用信息与最新发布"
                title={effectiveRefreshing ? '正在从远端重新同步数据...' : '强制从远端刷新 (穿透本地缓存)'}
                style={{ position: 'relative', top: 'auto', right: 'auto', color: effectiveRefreshing ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
              >
                <svg
                  className={effectiveRefreshing ? 'icon-spin' : ''}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
            )}
            {onToggleFavorite && (
              <button
                className="modal-close-btn"
                onClick={() => onToggleFavorite(app.id)}
                aria-label={isFavorite ? '取消收藏' : '添加收藏'}
                style={{ position: 'relative', top: 'auto', right: 'auto', color: isFavorite ? '#eab308' : 'var(--text-secondary)' }}
                title={isFavorite ? '已收藏（点击取消）' : '加入收藏夹'}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            )}
            {onToggleWatch && (
              <button
                className="modal-close-btn"
                onClick={() => onToggleWatch(app.id)}
                aria-label={isWatched ? '取消关注' : '关注新版本动态'}
                style={{ position: 'relative', top: 'auto', right: 'auto', color: isWatched ? 'var(--brand-primary)' : 'var(--text-secondary)' }}
                title={isWatched ? '已关注该应用的新版本动态（点击取消）' : '关注：新版本发布时在应用内提醒'}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
            {oauthUser && (
              <button
                className="modal-close-btn"
                onClick={handleToggleStar}
                disabled={isStarring}
                aria-label={isStarred ? '取消标星' : '在 GitHub 上标星'}
                style={{ position: 'relative', top: 'auto', right: 'auto', color: isStarred ? '#eab308' : 'var(--text-secondary)' }}
                title={isStarred ? '已在 GitHub 上标星（点击取消）' : '★ 标星该仓库（需 GitHub 账号登录态）'}
              >
                <span style={{ fontSize: '14px', fontWeight: 700, color: isStarred ? '#eab308' : 'inherit' }}>★</span>
              </button>
            )}
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
            icon={app.icon}
            name={app.name}
            appId={app.id}
            owner={app.owner}
            repo={app.repo}
            iconBg={app.icon_bg}
            className="modal-app-icon"
          />

          <div className="modal-header-info">
            <div className="modal-app-title">
              <span>{app.name}</span>
              {app.is_verified && (
                <span className="verified-badge" title="仓库校验码已验证 · 收录库认证">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="var(--brand-primary)" />
                    <path d="m9 12 2 2 4-4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
            </div>
            <div className="modal-app-repo" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {onOpenDeveloperProfile ? (
                <button
                  type="button"
                  onClick={() => onOpenDeveloperProfile(app.owner)}
                  className="btn-fluent btn-secondary"
                  style={{
                    padding: '2px 8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    borderRadius: '12px',
                    color: 'var(--brand-primary)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    lineHeight: '1.4',
                  }}
                  title={`查看 ${app.owner} 开发者全景与开源项目`}
                >
                  👤 {app.owner}
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
                style={{ fontWeight: 600, color: 'inherit', textDecoration: 'none' }}
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
                style={{ fontWeight: 600, color: 'var(--brand-primary)', textDecoration: 'none' }}
                title="前往开源仓库提交问题反馈（自动预填版本信息）"
              >
                🐞 问题反馈
              </a>
            </div>
            <div className="modal-tags">
              <span className="modal-tag">★ {((app.stars || 0) / 1000).toFixed(1)}k</span>
              <span className="modal-tag">{app.license}</span>
              <span className="modal-tag">{app.category_name}</span>
              {app.forge && app.forge !== 'github' && (
                <span
                  className="modal-tag"
                  style={{
                    background: 'var(--brand-subtle)',
                    color: 'var(--brand-primary)',
                    border: '1px solid var(--border-nav-active)',
                    fontWeight: 600,
                  }}
                >
                  {app.forge === 'codeberg' ? '🏔️ Codeberg 源' : app.forge === 'gitea' ? '🍵 Gitea 源' : `🌐 ${app.forge_host || app.forge}`}
                </span>
              )}
              {primaryAsset && (
                <span className="modal-tag">大小 {formatBytes(primaryAsset.size_bytes)}</span>
              )}
              {app.is_stale_fallback && (
                <span
                  className="modal-tag"
                  style={{
                    background: 'rgba(245, 158, 11, 0.15)',
                    color: '#f59e0b',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    fontWeight: 600,
                  }}
                  title="网络不可用或请求受限，当前正在呈现本地历史数据"
                >
                  ⚠️ 离线缓存
                </span>
              )}

              {/* 刷新状态与微动效反馈 */}
              {refreshSuccessNotice ? (
                <span
                  className="modal-tag modal-tag-success tag-spring-in"
                  title="已成功从远端获取最新 README 与 Release 资产并写回本地数据库"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>已从远端同步最新文档与发布</span>
                </span>
              ) : refreshErrorNotice ? (
                <span
                  className="modal-tag modal-tag-error tag-spring-in"
                  title={`远端拉取失败: ${refreshErrorNotice}`}
                >
                  ⚠️ 同步异常，请稍后重试
                </span>
              ) : effectiveRefreshing ? (
                <span className="modal-tag modal-tag-refreshing tag-spring-in">
                  <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} />
                  <span>正在穿透缓存拉取最新数据...</span>
                </span>
              ) : (
                <>
                  {app.cached_at && !app.is_stale_fallback && (
                    <span
                      className="modal-tag"
                      style={{ fontSize: '11px', opacity: 0.8 }}
                      title={`最后缓存时间：${new Date(app.cached_at * 1000).toLocaleString()}`}
                    >
                      🕒 {new Date(app.cached_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 缓存
                    </span>
                  )}
                  {onRefresh && (
                    <button
                      type="button"
                      className="modal-tag modal-tag-action"
                      onClick={handleTriggerRefresh}
                      disabled={effectiveRefreshing}
                      title="穿透本地 SQLite 缓存，强制从远端拉取最新 README.md 与 Release 资产"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                      <span>强制从远端刷新</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="modal-body">
          {/* FR-8: z-store.toml 收录库扩展元数据（全字段可选，缺失时整块隐藏） */}
          {app.store_meta && (
            <div
              className="settings-group"
              style={{ marginBottom: '12px' }}
              title={app.is_verified ? '仓库校验码已验证 · 收录库认证' : undefined}
            >
              <div className="settings-group-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>📦 收录库元数据显示</span>
                {app.is_verified && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--brand-primary)',
                      background: 'var(--brand-subtle)',
                      border: '1px solid var(--border-nav-active)',
                      borderRadius: '10px',
                      padding: '1px 8px',
                    }}
                    title="仓库校验码已验证 · 收录库认证"
                  >
                    🛡️ 所有权勋章
                  </span>
                )}
              </div>
              {(app.store_meta.display_name || app.store_meta.summary) && (
                <div style={{ fontSize: '13px', lineHeight: '1.6', marginBottom: '8px' }}>
                  {app.store_meta.display_name && (
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{app.store_meta.display_name}</div>
                  )}
                  {app.store_meta.summary && (
                    <div style={{ color: 'var(--text-secondary)' }}>{app.store_meta.summary}</div>
                  )}
                </div>
              )}
              {Array.isArray(app.store_meta.aliases) && app.store_meta.aliases.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                  {app.store_meta.aliases.map((alias) => (
                    <span key={alias} className="modal-tag" title={`中文别名：${alias}`}>
                      🏷️ {alias}
                    </span>
                  ))}
                </div>
              )}
              {Array.isArray(app.store_meta.screenshots) && app.store_meta.screenshots.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
                  {app.store_meta.screenshots.map((src) => (
                    <img
                      key={src}
                      src={src}
                      alt={`${app.name} 应用截图`}
                      loading="lazy"
                      style={{
                        height: '96px',
                        borderRadius: '8px',
                        border: '1px solid var(--border-acrylic)',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        api.openUrl(src);
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Action Card */}
          <div className="install-action-bar">
            <div>
              <div className="install-asset-label">
                {app.isLoading && (!releases || releases.length === 0)
                  ? '正在同步 GitHub Release 最新发布产物...'
                  : isInstalled
                  ? isManaged
                    ? '状态：已安装就绪 (Z-Store 已纳管)'
                    : '状态：系统已安装就绪 (未纳入当前管理)'
                  : selectedAssetName
                  ? `用户指定安装包 (${primaryAsset?.os} · ${primaryAsset?.arch})`
                  : `建议安装版本 (${currentOs === 'windows' ? 'Windows' : currentOs} ${currentArch} 自适应匹配)`}
              </div>
              <div className="install-asset-name">
                {app.isLoading && (!releases || releases.length === 0) && showSkeleton ? (
                  <div className="skeleton-box" style={{ width: '240px', height: '18px', margin: '4px 0' }} />
                ) : primaryAsset ? (
                  primaryAsset.name
                ) : (
                  `${app.name} 最新发布包`
                )}
              </div>

              {downloadProgress && (
                <div style={{ marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    <span>
                      {downloadProgress.state === 'downloading' && (downloadProgress.message || '⚡ 正在下载...')}
                      {downloadProgress.state === 'verifying' && '🛡️ 正在进行 SHA-256 完整性比对...'}
                      {downloadProgress.state === 'verified' && '✅ 哈希匹配！官方防篡改认证通过'}
                      {downloadProgress.state === 'completed_unverified' && '✅ 下载就绪，准备调用安装'}
                      {downloadProgress.state === 'tampered' && '❌ 警告：文件篡改已拦截'}
                      {downloadProgress.state === 'error' && `⚠️ ${downloadProgress.message || '下载异常中断'}`}
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
                    <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>
                      {downloadProgress.message}
                    </div>
                  )}
                </div>
              )}

              {installError && !downloadProgress && (
                <div style={{ marginTop: '8px', fontSize: '12px', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>⚠️ 安装异常：{installError}</span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {releases && releases.length > 1 && (
                <button
                  className="btn-fluent btn-secondary"
                  onClick={() => setShowAllAssets(!showAllAssets)}
                  style={{ fontSize: '13px' }}
                >
                  {showAllAssets ? '收起资产' : `全部资产 (${releases.length})`}
                </button>
              )}

              {isInstalled ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {!isManaged ? (
                    <>
                      {onManageApp && (
                        <button
                          type="button"
                          className="btn-fluent btn-secondary"
                          style={{
                            fontSize: '13px',
                            padding: '6px 14px',
                            fontWeight: 600,
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
                          title="纳管：将系统已识别的该软件纳入 Z-Store 统一管理，支持版本追踪与快捷更新"
                        >
                          {isManaging ? '正在纳管...' : '📥 纳管此应用'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: '13px', padding: '6px 12px' }}
                        onClick={handleAction}
                        title="通过 Z-Store 重新下载安装最新版本或覆盖安装"
                      >
                        ⚡ 覆盖/重装
                      </button>
                    </>
                  ) : (
                    <>
                      {onUnmanage && (
                        <button
                          type="button"
                          className={`btn-fluent ${confirmingUnmanage ? 'btn-danger-confirm' : 'btn-secondary'}`}
                          style={{ fontSize: '13px', padding: '6px 12px' }}
                          onClick={async () => {
                            if (confirmingUnmanage) {
                              await onUnmanage(app.id);
                              setConfirmingUnmanage(false);
                            } else {
                              setConfirmingUnmanage(true);
                              setConfirmingUninstall(false);
                              setTimeout(() => setConfirmingUnmanage(false), 4000);
                            }
                          }}
                          title="取消纳管：仅从 Z-Store 列表中移除管理记录，保留本机软件与数据"
                        >
                          {confirmingUnmanage ? '确认取消纳管？' : '取消纳管'}
                        </button>
                      )}

                      {onUninstall && (
                        <button
                          type="button"
                          className={`btn-fluent ${confirmingUninstall ? 'btn-danger-confirm' : 'btn-danger'}`}
                          style={{ fontSize: '13px', padding: '6px 12px' }}
                          onClick={async () => {
                            if (confirmingUninstall) {
                              await onUninstall(app.id);
                              setConfirmingUninstall(false);
                            } else {
                              setConfirmingUninstall(true);
                              setConfirmingUnmanage(false);
                              setTimeout(() => setConfirmingUninstall(false), 4000);
                            }
                          }}
                          title="卸载：调起官方卸载向导或清理本地安装文件彻底卸载应用"
                        >
                          {confirmingUninstall ? '确认卸载？' : '🗑️ 卸载应用'}
                        </button>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    className="btn-fluent btn-primary"
                    onClick={() => onLaunch(app.id)}
                    style={{ minWidth: '110px', fontWeight: 600 }}
                  >
                    🚀 打开应用
                  </button>
                </div>
              ) : (
                <button
                  className="btn-fluent btn-primary"
                  onClick={handleAction}
                  disabled={isInstalling || Boolean(app.isLoading && (!releases || releases.length === 0))}
                  style={{ minWidth: '130px', fontWeight: 600, opacity: app.isLoading && (!releases || releases.length === 0) ? 0.75 : 1 }}
                >
                  {app.isLoading && (!releases || releases.length === 0) ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <span className="spinner-icon" />
                      <span>检索版本中...</span>
                    </span>
                  ) : isInstalling ? (
                    '正在安装...'
                  ) : (
                    '一键获取安装'
                  )}
                </button>
              )}
            </div>
          </div>

          {/* All Assets Drawer */}
          {showAllAssets && (
            <div className="settings-group" style={{ marginBottom: 0 }}>
              <div className="settings-group-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>GitHub Release 原生构建设施产物</span>
                <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-tertiary)' }}>
                  宿主环境匹配: {currentOs} ({currentArch})
                </span>
              </div>
              {releases.map((asset) => {
                const isSelected = asset.name === primaryAsset?.name;
                return (
                  <div key={asset.name} className="settings-row" style={{ padding: '12px 20px' }}>
                    <div>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{asset.name}</span>
                        {isSelected && (
                          <span
                            className="modal-tag modal-tag-success"
                            style={{ fontSize: '10px', padding: '1px 6px' }}
                          >
                            当前目标
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                        目标平台: {asset.os} ({asset.arch}) · 类型: {asset.kind} · 体积: {formatBytes(asset.size_bytes)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {asset.sha256 && (
                        <span
                          className="trust-hash"
                          title={`官方校验值: ${asset.sha256}`}
                          style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          SHA-256: {asset.sha256.slice(0, 10)}...
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedAssetName(asset.name)}
                        className={`btn-fluent ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ fontSize: '12px', padding: '4px 10px' }}
                        disabled={isInstalling}
                        title={isSelected ? '当前正在使用该版本安装' : '将此包选为当前安装目标'}
                      >
                        {isSelected ? '✓ 已选用' : '选用此包'}
                      </button>
                      <a
                        href={asset.download_url}
                        onClick={(e) => handleOpenExternal(e, asset.download_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: '12px', padding: '4px 10px', textDecoration: 'none' }}
                        title="在浏览器中直接下载"
                      >
                        直链
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Trust Box */}
          <div className="trust-box">
            <div className="trust-row">
              <span>🛡️ 供应链防篡改机制</span>
              <span className="trust-hash">
                {app.isLoading && !primaryAsset?.sha256
                  ? '官方动态流式校验 (准备中...)'
                  : primaryAsset?.sha256
                  ? `SHA-256: ${primaryAsset.sha256.slice(0, 20)}...`
                  : '官方动态流式校验'}
              </span>
            </div>
            <div className="trust-row">
              <span>🔑 开发者认证指纹</span>
              <span className="trust-hash">
                {app.signature_fingerprint || (app.isLoading ? '正在查询认证指纹...' : 'GitHub Release Verified')}
              </span>
            </div>
          </div>

          {/* README Section */}
          <div className="readme-preview">
            {app.loadError ? (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', color: 'var(--status-warning)', marginBottom: '12px' }}>
                  ⚠️ 获取详情失败: {app.loadError}
                </div>
                {onRetry && (
                  <button
                    className="btn-fluent btn-secondary"
                    onClick={() => onRetry(app.id)}
                    style={{ padding: '6px 18px', fontSize: '13px', cursor: 'pointer' }}
                  >
                    🔄 重试加载
                  </button>
                )}
              </div>
            ) : app.isLoading && !readmeHtml ? (
              showSkeleton ? (
                <div style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="skeleton-box" style={{ width: '38%', height: '24px' }} />
                  <div className="skeleton-box" style={{ width: '95%', height: '14px' }} />
                  <div className="skeleton-box" style={{ width: '82%', height: '14px' }} />
                  <div className="skeleton-box" style={{ width: '88%', height: '14px' }} />
                  <div className="skeleton-box" style={{ width: '60%', height: '14px' }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
                    <span className="spinner-icon" />
                    <span>正在通过加速通道异步获取软件完整文档与变更日志...</span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '28px 24px', color: 'var(--text-tertiary)', fontSize: '13px', lineHeight: '1.6' }}>
                  {app.description}
                </div>
              )
            ) : (
              <div
                className="readme-markdown-body"
                dangerouslySetInnerHTML={{ __html: readmeHtml }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
