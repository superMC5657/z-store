import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { AppDetail, DownloadProgressPayload, ReleaseAsset } from '../types';
import { api } from '../services/api';
import { AppIcon } from './AppIcon';

interface AppDetailModalProps {
  app: AppDetail;
  isInstalled: boolean;
  isFavorite?: boolean;
  onClose: () => void;
  onInstall: (id: string) => Promise<void>;
  onLaunch: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onOpenDeveloperProfile?: (developer: string) => void;
  onRetry?: (id: string) => void;
  onRefresh?: (id: string) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({
  app,
  isInstalled,
  isFavorite = false,
  onClose,
  onInstall,
  onLaunch,
  onToggleFavorite,
  onOpenDeveloperProfile,
  onRetry,
  onRefresh,
}) => {
  const [showAllAssets, setShowAllAssets] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressPayload | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);

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
    api.onDownloadProgress((payload) => {
      setDownloadProgress(payload);
      if (payload.state === 'completed' || payload.state === 'error' || payload.state === 'tampered') {
        setTimeout(() => setDownloadProgress(null), 3500);
      }
    }).then((fn) => {
      cleanup = fn;
    });

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const primaryAsset: ReleaseAsset | undefined =
    app.releases.find((r) => r.os === 'windows') || app.releases[0];

  const handleAction = async () => {
    if (isInstalled) {
      onLaunch(app.id);
      return;
    }

    try {
      setIsInstalling(true);
      await onInstall(app.id);
    } finally {
      setIsInstalling(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  // 避免高频下载进度事件重绘时重复同步解析庞大的 Markdown 文档阻塞渲染主线程
  const readmeHtml = useMemo(() => {
    if (!app.readme_markdown) return '';
    return marked.parse(app.readme_markdown, { async: false }) as string;
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
          <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 10 }}>
            {onRefresh && (
              <button
                className="modal-close-btn"
                onClick={() => onRefresh(app.id)}
                aria-label="刷新应用信息与最新发布"
                title="向远程同步刷新最新 Releases 与元数据"
                style={{ color: 'var(--text-secondary)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
            )}
            {onToggleFavorite && (
              <button
                className="modal-close-btn"
                onClick={() => onToggleFavorite(app.id)}
                aria-label={isFavorite ? '取消收藏' : '添加收藏'}
                style={{ color: isFavorite ? '#eab308' : 'var(--text-secondary)' }}
                title={isFavorite ? '已收藏（点击取消）' : '加入收藏夹'}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            )}
            <button
              className="modal-close-btn"
              onClick={onClose}
              aria-label="关闭详情弹窗"
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
            iconBg={app.icon_bg}
            className="modal-app-icon"
          />

          <div className="modal-header-info">
            <div className="modal-app-title">
              <span>{app.name}</span>
              {app.is_verified && (
                <span className="verified-badge" title="官方所有权已通过验证">
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
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontWeight: 600, color: 'inherit', textDecoration: 'none' }}
                title="在浏览器中查看开源仓库"
              >
                {app.repo} ↗
              </a>
              <span>·</span>
              <span>最新发布 {app.latest_version}</span>
            </div>
            <div className="modal-tags">
              <span className="modal-tag">★ {(app.stars / 1000).toFixed(1)}k</span>
              <span className="modal-tag">{app.license}</span>
              <span className="modal-tag">{app.category_name}</span>
              {app.forge && app.forge !== 'github' && (
                <span
                  className="modal-tag"
                  style={{
                    background: 'rgba(56, 189, 248, 0.15)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    fontWeight: 600,
                  }}
                >
                  {app.forge === 'codeberg' ? '🏔️ Codeberg 源' : app.forge === 'gitea' ? '🍵 Gitea 源' : `🌐 ${app.forge_host || app.forge}`}
                </span>
              )}
              {primaryAsset && (
                <span className="modal-tag">大小 {formatBytes(primaryAsset.size_bytes)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="modal-body">
          {/* Action Card */}
          <div className="install-action-bar">
            <div>
              <div className="install-asset-label">
                {app.isLoading && (!app.releases || app.releases.length === 0)
                  ? '正在同步 GitHub Release 最新发布产物...'
                  : isInstalled
                  ? '状态：已安装就绪'
                  : '建议安装版本 (Windows 自适应匹配)'}
              </div>
              <div className="install-asset-name">
                {app.isLoading && (!app.releases || app.releases.length === 0) && showSkeleton ? (
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
                      {downloadProgress.state === 'downloading' && '⚡ 正在下载...'}
                      {downloadProgress.state === 'verifying' && '🛡️ 正在进行 SHA-256 完整性比对...'}
                      {downloadProgress.state === 'verified' && '✅ 哈希匹配！官方防篡改认证通过'}
                      {downloadProgress.state === 'tampered' && '❌ 警告：文件篡改已拦截'}
                    </span>
                    <span>
                      {(downloadProgress.speed_bytes_per_sec / 1024 / 1024).toFixed(1)} MB/s
                    </span>
                  </div>
                  <div className="install-progress-bar-container">
                    <div
                      className="install-progress-bar"
                      style={{
                        width: downloadProgress.total_bytes
                          ? `${Math.min(100, (downloadProgress.downloaded_bytes / downloadProgress.total_bytes) * 100)}%`
                          : '75%',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {app.releases && app.releases.length > 1 && (
                <button
                  className="btn-fluent btn-secondary"
                  onClick={() => setShowAllAssets(!showAllAssets)}
                  style={{ fontSize: '13px' }}
                >
                  {showAllAssets ? '收起资产' : `全部资产 (${app.releases.length})`}
                </button>
              )}

              <button
                className={`btn-fluent ${isInstalled ? 'btn-secondary' : 'btn-primary'}`}
                onClick={handleAction}
                disabled={isInstalling || Boolean(app.isLoading && (!app.releases || app.releases.length === 0))}
                style={{ minWidth: '130px', fontWeight: 600, opacity: app.isLoading && (!app.releases || app.releases.length === 0) ? 0.75 : 1 }}
              >
                {app.isLoading && (!app.releases || app.releases.length === 0) ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span className="spinner-icon" />
                    <span>检索版本中...</span>
                  </span>
                ) : isInstalled ? (
                  '🚀 打开应用'
                ) : isInstalling ? (
                  '正在安装...'
                ) : (
                  '一键获取安装'
                )}
              </button>
            </div>
          </div>

          {/* All Assets Drawer */}
          {showAllAssets && (
            <div className="settings-group" style={{ marginBottom: 0 }}>
              <div className="settings-group-title">GitHub Release 原生构建设施产物</div>
              {app.releases.map((asset) => (
                <div key={asset.name} className="settings-row" style={{ padding: '12px 20px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{asset.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      目标平台: {asset.os} ({asset.arch}) · 体积: {formatBytes(asset.size_bytes)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {asset.sha256 && (
                      <span
                        className="trust-hash"
                        title={`官方校验值: ${asset.sha256}`}
                        style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        SHA-256: {asset.sha256.slice(0, 12)}...
                      </span>
                    )}
                    <a
                      href={asset.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 10px', textDecoration: 'none' }}
                    >
                      直链
                    </a>
                  </div>
                </div>
              ))}
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
