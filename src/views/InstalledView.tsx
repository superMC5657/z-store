import React, { useState } from 'react';
import { InstalledApp } from '../types';

interface InstalledViewProps {
  installedApps: InstalledApp[];
  onLaunch: (id: string) => void;
  onUninstall: (id: string) => void;
  onScanSystemApps?: () => void;
  onExportApps?: () => void;
  onExportAppsJson?: () => void;
}

export const InstalledView: React.FC<InstalledViewProps> = ({
  installedApps,
  onLaunch,
  onUninstall,
  onScanSystemApps,
  onExportApps,
  onExportAppsJson,
}) => {
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const formatDate = (ts: number) => {
    const normalizedTs = ts < 10000000000 ? ts * 1000 : ts;
    return new Date(normalizedTs).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  const handleTriggerUninstall = (id: string) => {
    if (confirmingUninstallId === id) {
      onUninstall(id);
      setConfirmingUninstallId(null);
    } else {
      setConfirmingUninstallId(id);
      setTimeout(() => {
        setConfirmingUninstallId((prev) => (prev === id ? null : prev));
      }, 4000);
    }
  };

  const handleCopyPath = (id: string, path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 2000);
  };

  const getMethodBadge = (method: string) => {
    switch (method) {
      case 'msi':
        return { label: 'MSI 官方安装', color: 'var(--brand-primary)' };
      case 'setup_exe':
        return { label: 'EXE 安装向导', color: '#0284c7' };
      case 'portable_zip':
        return { label: '便携绿色版', color: '#10b981' };
      case 'system_import':
        return { label: '系统纳管', color: '#8b5cf6' };
      default:
        return { label: '系统管理', color: 'var(--text-tertiary)' };
    }
  };

  return (
    <div className="installed-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">📦 已安装的开源软件 ({installedApps.length})</h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {onExportApps && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
              onClick={onExportApps}
              disabled={installedApps.length === 0}
              title="复制软件清单 Markdown 到剪贴板"
            >
              📋 导出 Markdown
            </button>
          )}
          {onExportAppsJson && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
              onClick={onExportAppsJson}
              disabled={installedApps.length === 0}
              title="导出软件资产 JSON 备份文件"
            >
              💾 备份 JSON
            </button>
          )}
          {onScanSystemApps && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px' }}
              onClick={onScanSystemApps}
              title="扫描系统存量开源软件并纳管"
            >
              🔍 扫描系统开源软件
            </button>
          )}
          <button
            className={`btn-fluent ${viewMode === 'card' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '4px 12px', fontSize: '12px' }}
            onClick={() => setViewMode('card')}
          >
            卡片视图
          </button>
          <button
            className={`btn-fluent ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '4px 12px', fontSize: '12px' }}
            onClick={() => setViewMode('list')}
          >
            紧凑列表
          </button>
        </div>
      </div>

      {installedApps.length === 0 ? (
        <div className="empty-state-card">
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>📂</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>尚未通过 Z-Store 安装任何开源软件</h4>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
            前往「精选发现」或「分类浏览」探索优质开源应用，享受一键安装与自动更新服务。
          </p>
        </div>
      ) : viewMode === 'card' ? (
        <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {installedApps.map((app) => {
            const badge = getMethodBadge(app.install_method);
            return (
              <div key={app.app_id} className="app-card" style={{ padding: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '15px' }}>{app.app_name}</h4>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      版本 {app.version} · 安装于 {formatDate(app.installed_at)}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: 'var(--bg-acrylic-thin)',
                      border: '1px solid var(--border-acrylic)',
                      color: badge.color,
                      fontWeight: 600,
                    }}
                  >
                    {badge.label}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0' }}>
                  <div
                    style={{
                      flex: 1,
                      fontSize: '11px',
                      color: 'var(--text-tertiary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                      background: 'var(--bg-acrylic-thin)',
                      padding: '5px 8px',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      border: '1px solid var(--border-acrylic)',
                    }}
                    title={app.install_path}
                  >
                    {app.install_path}
                  </div>
                  <button
                    className="btn-fluent btn-secondary"
                    style={{ padding: '4px 8px', fontSize: '11px', flexShrink: 0 }}
                    onClick={() => handleCopyPath(app.app_id, app.install_path)}
                    title="复制完整路径"
                  >
                    {copiedId === app.app_id ? '✓ 已复制' : '复制路径'}
                  </button>
                </div>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
                  {confirmingUninstallId === app.app_id ? (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <button
                        className="btn-fluent"
                        style={{
                          padding: '5px 12px',
                          fontSize: '12px',
                          background: '#ef4444',
                          color: '#fff',
                          fontWeight: 600,
                        }}
                        onClick={() => handleTriggerUninstall(app.app_id)}
                      >
                        {app.install_method === 'system_import' ? '确认取消纳管？' : '确认卸载？'}
                      </button>
                      <button
                        className="btn-fluent btn-secondary"
                        style={{ padding: '5px 8px', fontSize: '12px' }}
                        onClick={() => setConfirmingUninstallId(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ padding: '5px 12px', fontSize: '12px', color: '#ef4444' }}
                      onClick={() => handleTriggerUninstall(app.app_id)}
                      title={app.install_method === 'system_import' ? '从 Z-Store 中移除监控，不会删除本机应用程序文件' : '调起官方卸载程序'}
                    >
                      {app.install_method === 'system_import' ? '取消纳管' : '卸载'}
                    </button>
                  )}
                  <button
                    className="btn-fluent btn-primary"
                    style={{ padding: '5px 16px', fontSize: '12px' }}
                    onClick={() => onLaunch(app.app_id)}
                  >
                    启动
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings-group" style={{ marginBottom: 0 }}>
          {installedApps.map((app) => {
            const badge = getMethodBadge(app.install_method);
            return (
              <div key={app.app_id} className="settings-row" style={{ padding: '12px 20px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 600 }}>{app.app_name}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{app.version}</span>
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: 'var(--brand-subtle)',
                        color: badge.color,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>路径: {app.install_path} · 安装于 {formatDate(app.installed_at)}</span>
                    <button
                      onClick={() => handleCopyPath(app.app_id, app.install_path)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--brand-primary)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        padding: '0 4px',
                      }}
                    >
                      {copiedId === app.app_id ? '✓ 已复制' : '复制'}
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {confirmingUninstallId === app.app_id ? (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <button
                        className="btn-fluent"
                        style={{
                          padding: '4px 10px',
                          fontSize: '12px',
                          background: '#ef4444',
                          color: '#fff',
                          fontWeight: 600,
                        }}
                        onClick={() => handleTriggerUninstall(app.app_id)}
                      >
                        {app.install_method === 'system_import' ? '确认取消纳管？' : '确认卸载？'}
                      </button>
                      <button
                        className="btn-fluent btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={() => setConfirmingUninstallId(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 10px', color: '#ef4444' }}
                      onClick={() => handleTriggerUninstall(app.app_id)}
                      title={app.install_method === 'system_import' ? '从 Z-Store 中移除监控，不会删除本机应用程序文件' : '调起官方卸载程序'}
                    >
                      {app.install_method === 'system_import' ? '取消纳管' : '卸载'}
                    </button>
                  )}
                  <button
                    className="btn-fluent btn-primary"
                    style={{ fontSize: '12px', padding: '4px 14px' }}
                    onClick={() => onLaunch(app.app_id)}
                  >
                    启动
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
