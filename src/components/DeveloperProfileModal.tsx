import React, { useEffect, useState } from 'react';
import { DeveloperProfile } from '../types';
import { api } from '../services/api';

interface DeveloperProfileModalProps {
  developer: string;
  isOpen: boolean;
  onClose: () => void;
  onOpenAppDetail: (appId: string) => void;
  onInstallApp: (appId: string) => Promise<void>;
  installedIds?: Set<string>;
}

export const DeveloperProfileModal: React.FC<DeveloperProfileModalProps> = ({
  developer,
  isOpen,
  onClose,
  onOpenAppDetail,
  onInstallApp,
  installedIds,
}) => {
  const [profile, setProfile] = useState<DeveloperProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !developer) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    api
      .getDeveloperProfile(developer)
      .then((data) => {
        if (isMounted) {
          setProfile(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(String(err));
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [developer, isOpen]);

  // Global Esc key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleInstall = async (appId: string) => {
    try {
      setInstallingId(appId);
      await onInstallApp(appId);
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-modal"
        style={{ maxWidth: '780px', width: '92%', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header Hero */}
        <div className="modal-header" style={{ position: 'relative', padding: '24px 28px' }}>
          <button
            className="modal-close-btn"
            onClick={onClose}
            aria-label="关闭开发者详情"
            style={{ position: 'absolute', top: '16px', right: '16px' }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>

          {loading ? (
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <div
                style={{
                  width: '72px',
                  height: '72px',
                  borderRadius: '50%',
                  background: 'var(--bg-acrylic-thin, rgba(255, 255, 255, 0.08))',
                  animation: 'pulse 1.5s infinite',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ width: '160px', height: '22px', background: 'var(--bg-acrylic-thin)', borderRadius: '4px' }} />
                <div style={{ width: '240px', height: '14px', background: 'var(--bg-acrylic-thin)', borderRadius: '4px' }} />
              </div>
            </div>
          ) : error ? (
            <div>
              <h3 style={{ margin: 0, fontSize: '18px', color: '#f87171' }}>获取开发者全景失败</h3>
              <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: 'var(--text-tertiary)' }}>{error}</p>
            </div>
          ) : profile ? (
            <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
              <img
                src={profile.avatar_url}
                alt={profile.login}
                style={{
                  width: '76px',
                  height: '76px',
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: '2px solid var(--border-highlight, rgba(255, 255, 255, 0.15))',
                  boxShadow: 'var(--shadow-rest)',
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>
                    {profile.name || profile.login}
                  </h3>
                  <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    @{profile.login}
                  </span>
                  <a
                    href={profile.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-fluent btn-secondary"
                    style={{ fontSize: '11px', padding: '2px 8px', textDecoration: 'none' }}
                  >
                    GitHub ↗
                  </a>
                </div>

                {profile.bio && (
                  <p style={{ margin: '8px 0 10px 0', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {profile.bio}
                  </p>
                )}

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                  <span className="modal-tag">📦 {profile.public_repos} 个开源仓库</span>
                  <span className="modal-tag">👥 {profile.followers} 关注者</span>
                  {profile.company && <span className="modal-tag">🏢 {profile.company}</span>}
                  {profile.location && <span className="modal-tag">📍 {profile.location}</span>}
                  {profile.blog && (
                    <a
                      href={profile.blog.startsWith('http') ? profile.blog : `https://${profile.blog}`}
                      target="_blank"
                      rel="noreferrer"
                      className="modal-tag"
                      style={{ textDecoration: 'none', color: 'var(--brand-primary)' }}
                    >
                      🔗 {profile.blog}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Modal Body: Repositories List */}
        <div className="modal-body" style={{ padding: '24px 28px', maxHeight: '55vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
              📂 开源项目矩阵 ({profile?.repos.length || 0})
            </h4>
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
              标记「已收录」的项目可直接在 Z-Store 中一键安装与接管更新
            </span>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-tertiary)' }}>
              正在通过 GitHub API 解析该开发者名下项目...
            </div>
          ) : profile && profile.repos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-tertiary)' }}>
              该开发者暂无公开开源仓库
            </div>
          ) : profile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {profile.repos.map((repo) => {
                const isInstalling = installingId === repo.id;

                return (
                  <div
                    key={repo.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '14px 18px',
                      borderRadius: 'var(--radius-md, 8px)',
                      background: 'var(--bg-acrylic-thin, rgba(255, 255, 255, 0.04))',
                      border: '1px solid var(--border-acrylic, rgba(255, 255, 255, 0.08))',
                      transition: 'background 0.2s ease, border-color 0.2s ease',
                    }}
                  >
                    <div style={{ flex: 1, marginRight: '16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                          {repo.name}
                        </span>
                        {repo.in_catalog && (
                          <span
                            style={{
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'var(--brand-subtle)',
                              color: 'var(--brand-primary)',
                              fontWeight: 600,
                            }}
                          >
                            ✓ Z-Store 已收录
                          </span>
                        )}
                        {repo.latest_release_tag && (
                          <span style={{ fontSize: '11.5px', color: 'var(--brand-primary)', fontWeight: 600 }}>
                            {repo.latest_release_tag}
                          </span>
                        )}
                      </div>

                      {repo.description && (
                        <p style={{ margin: '0 0 6px 0', fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                          {repo.description}
                        </p>
                      )}

                      <div style={{ display: 'flex', gap: '12px', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
                        <span>★ {repo.stars}</span>
                        <span>🍴 {repo.forks}</span>
                        {repo.language && <span>💻 {repo.language}</span>}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {repo.in_catalog ? (
                        <>
                          <button
                            className="btn-fluent btn-secondary"
                            style={{ fontSize: '12px', padding: '6px 12px' }}
                            onClick={() => {
                              onClose();
                              onOpenAppDetail(repo.id);
                            }}
                          >
                            查看详情
                          </button>
                          {installedIds?.has(repo.id) ? (
                            <button
                              className="btn-fluent btn-secondary"
                              style={{
                                fontSize: '12px',
                                padding: '6px 14px',
                                fontWeight: 600,
                                color: 'var(--brand-primary)',
                                borderColor: 'var(--border-nav-active)',
                              }}
                              onClick={() => {
                                onClose();
                                onOpenAppDetail(repo.id);
                              }}
                              title="已就绪 · 点击查看与管理"
                            >
                              ✓ 已安装
                            </button>
                          ) : (
                            <button
                              className="btn-fluent btn-primary"
                              style={{ fontSize: '12px', padding: '6px 14px', fontWeight: 600 }}
                              disabled={isInstalling}
                              onClick={() => handleInstall(repo.id)}
                            >
                              {isInstalling ? '安装中...' : '一键安装'}
                            </button>
                          )}
                        </>
                      ) : (
                        <a
                          href={repo.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-fluent btn-secondary"
                          style={{ fontSize: '12px', padding: '6px 12px', textDecoration: 'none' }}
                        >
                          打开仓库 ↗
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
