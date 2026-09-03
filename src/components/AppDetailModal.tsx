import React, { useEffect, useState } from 'react';
import { marked } from 'marked';
import { AppDetail, DownloadProgressPayload, ReleaseAsset } from '../types';
import { api } from '../services/api';

interface AppDetailModalProps {
  app: AppDetail;
  isInstalled: boolean;
  isFavorite?: boolean;
  onClose: () => void;
  onInstall: (id: string) => Promise<void>;
  onLaunch: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
}

export const AppDetailModal: React.FC<AppDetailModalProps> = ({
  app,
  isInstalled,
  isFavorite = false,
  onClose,
  onInstall,
  onLaunch,
  onToggleFavorite,
}) => {
  const [showAllAssets, setShowAllAssets] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressPayload | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);

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

  const readmeHtml = marked.parse(app.readme_markdown, { async: false }) as string;

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
            {onToggleFavorite && (
              <button
                className="modal-close-btn"
                onClick={() => onToggleFavorite(app.id)}
                aria-label={isFavorite ? '取消收藏' : '添加收藏'}
                style={{ color: isFavorite ? '#eab308' : 'var(--text-secondary)' }}
                title={isFavorite ? '已收藏（点击取消）' : '加入收藏夹'}
              >
                {isFavorite ? '★' : '☆'}
              </button>
            )}
            <button
              className="modal-close-btn"
              onClick={onClose}
              aria-label="关闭详情弹窗"
            >
              ✕
            </button>
          </div>

          <div
            className="modal-app-icon"
            style={{ background: app.icon_bg }}
          >
            {app.icon}
          </div>

          <div className="modal-header-info">
            <div className="modal-app-title">
              <span>{app.name}</span>
              {app.is_verified && (
                <span className="verified-badge" title="官方所有权已通过验证">
                  ✓
                </span>
              )}
            </div>
            <div className="modal-app-repo">
              {app.owner}/{app.repo} · 最新发布 {app.latest_version}
            </div>
            <div className="modal-tags">
              <span className="modal-tag">★ {(app.stars / 1000).toFixed(1)}k</span>
              <span className="modal-tag">{app.license}</span>
              <span className="modal-tag">{app.category_name}</span>
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
                {isInstalled ? '状态：已安装就绪' : '建议安装版本 (Windows 自适应匹配)'}
              </div>
              <div className="install-asset-name">
                {primaryAsset ? primaryAsset.name : `${app.name} 最新发布包`}
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
              {app.releases.length > 1 && (
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
                disabled={isInstalling}
                style={{ minWidth: '130px', fontWeight: 600 }}
              >
                {isInstalled ? '🚀 打开应用' : isInstalling ? '正在安装...' : '一键获取安装'}
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
                {primaryAsset?.sha256 ? `SHA-256: ${primaryAsset.sha256.slice(0, 20)}...` : '官方动态流式校验'}
              </span>
            </div>
            <div className="trust-row">
              <span>🔑 开发者认证指纹</span>
              <span className="trust-hash">
                {app.signature_fingerprint || 'GitHub Release Verified'}
              </span>
            </div>
          </div>

          {/* README Section */}
          <div className="readme-preview">
            <div
              className="readme-markdown-body"
              dangerouslySetInnerHTML={{ __html: readmeHtml }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
