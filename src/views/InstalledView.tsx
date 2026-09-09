import React, { useState } from 'react';
import { AppSummary, InstalledApp, UpdateRule } from '../types';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { AppIcon } from '../components/AppIcon';
import { formatAppDate, getMethodBadge, resolveInstalledIconInfo } from '../utils/appHelper';

interface InstalledViewProps {
  installedApps: InstalledApp[];
  apps?: AppSummary[];
  onOpenDetail?: (id: string) => void;
  onLaunch: (id: string) => void;
  onUninstall: (id: string) => void;
  onUnmanage?: (id: string) => void;
  onScanSystemApps?: () => void;
  onExportApps?: () => void;
  onExportAppsJson?: () => void;
  updateRules?: UpdateRule[];
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  onOpenRules?: () => void;
}

interface InstalledItemActionsProps {
  app: InstalledApp;
  isFrozen: boolean;
  isHidden: boolean;
  isMenuOpen: boolean;
  confirmingUninstallId: string | null;
  confirmingUnmanageId: string | null;
  onTriggerUninstall: (id: string) => void;
  onTriggerUnmanage: (id: string) => void;
  onCancelConfirm: () => void;
  onLaunch: (id: string) => void;
  onToggleMenu: (id: string, e: React.MouseEvent) => void;
  onCloseMenu: () => void;
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  onOpenRules?: () => void;
  compact?: boolean;
}

const InstalledItemActions: React.FC<InstalledItemActionsProps> = ({
  app,
  isFrozen,
  isHidden,
  isMenuOpen,
  confirmingUninstallId,
  confirmingUnmanageId,
  onTriggerUninstall,
  onTriggerUnmanage,
  onCancelConfirm,
  onLaunch,
  onToggleMenu,
  onCloseMenu,
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onOpenRules,
  compact = false,
}) => {
  const isUnmanaging = confirmingUnmanageId === app.app_id;
  const isUninstalling = confirmingUninstallId === app.app_id;
  const btnPadding = compact ? '4px 10px' : '5px 12px';

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      {isUnmanaging ? (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            className="btn-fluent"
            style={{
              padding: btnPadding,
              fontSize: '12px',
              background: '#eab308',
              color: '#000',
              fontWeight: 600,
            }}
            onClick={() => onTriggerUnmanage(app.app_id)}
          >
            确认取消纳管？
          </button>
          <button
            className="btn-fluent btn-secondary"
            style={{ padding: compact ? '4px 8px' : '5px 8px', fontSize: '12px' }}
            onClick={onCancelConfirm}
          >
            取消
          </button>
        </div>
      ) : isUninstalling ? (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            className="btn-fluent"
            style={{
              padding: btnPadding,
              fontSize: '12px',
              background: '#ef4444',
              color: '#fff',
              fontWeight: 600,
            }}
            onClick={() => onTriggerUninstall(app.app_id)}
          >
            确认彻底卸载？
          </button>
          <button
            className="btn-fluent btn-secondary"
            style={{ padding: compact ? '4px 8px' : '5px 8px', fontSize: '12px' }}
            onClick={onCancelConfirm}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <button
            className="btn-fluent btn-secondary"
            style={{ padding: btnPadding, fontSize: '12px' }}
            onClick={() => onTriggerUnmanage(app.app_id)}
            title="将此应用从 Z-Store 列表中移除纳管记录（保留本机软件与数据）"
          >
            取消纳管
          </button>
          <button
            className="btn-fluent btn-secondary"
            style={{ padding: btnPadding, fontSize: '12px', color: '#ef4444' }}
            onClick={() => onTriggerUninstall(app.app_id)}
            title="调起官方卸载程序或清理本地安装文件彻底卸载应用"
          >
            卸载
          </button>
        </>
      )}

      <button
        className="btn-fluent btn-primary"
        style={{ padding: compact ? '4px 14px' : '5px 16px', fontSize: '12px' }}
        onClick={() => onLaunch(app.app_id)}
        title="运行此应用程序"
      >
        启动
      </button>

      {(onToggleRuleFrozen || onToggleRuleHidden) && (
        <div style={{ position: 'relative' }}>
          <button
            className={`btn-fluent btn-secondary ${isMenuOpen ? 'active' : ''}`}
            style={{
              padding: compact ? '4px 8px' : '6px 8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: '1',
            }}
            onClick={(e) => onToggleMenu(app.app_id, e)}
            title="更多版本控制与屏蔽规则操作"
            aria-label="更多操作"
          >
            •••
          </button>

          <FlyoutMenu
            isOpen={isMenuOpen}
            onClose={onCloseMenu}
            align="right"
            width={210}
          >
            <div style={{ padding: '4px 0', minWidth: '160px' }}>
              {onToggleRuleFrozen && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleFrozen(app.app_id, !isFrozen);
                  }}
                >
                  <span>{isFrozen ? '🔓 解除版本锁定' : '🔒 锁定此版本'}</span>
                </button>
              )}
              {onToggleRuleHidden && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleHidden(app.app_id, !isHidden);
                  }}
                >
                  <span>{isHidden ? '👁️ 取消隐藏' : '👁️ 在探索与列表中隐藏'}</span>
                </button>
              )}
              {onOpenRules && (
                <>
                  <div className="flyout-divider" />
                  <button
                    className="flyout-item"
                    onClick={() => {
                      onCloseMenu();
                      onOpenRules();
                    }}
                  >
                    <span>🛡️ 打开规则管理器...</span>
                  </button>
                </>
              )}
            </div>
          </FlyoutMenu>
        </div>
      )}
    </div>
  );
};

export const InstalledView: React.FC<InstalledViewProps> = ({
  installedApps,
  apps = [],
  onOpenDetail,
  onLaunch,
  onUninstall,
  onUnmanage,
  onScanSystemApps,
  onExportApps,
  onExportAppsJson,
  updateRules = [],
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onOpenRules,
}) => {
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [confirmingUnmanageId, setConfirmingUnmanageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const handleTriggerUninstall = (id: string) => {
    if (confirmingUninstallId === id) {
      onUninstall(id);
      setConfirmingUninstallId(null);
    } else {
      setConfirmingUninstallId(id);
      setConfirmingUnmanageId(null);
      setTimeout(() => {
        setConfirmingUninstallId((prev) => (prev === id ? null : prev));
      }, 4000);
    }
  };

  const handleTriggerUnmanage = (id: string) => {
    if (confirmingUnmanageId === id) {
      if (onUnmanage) {
        onUnmanage(id);
      } else {
        onUninstall(id);
      }
      setConfirmingUnmanageId(null);
    } else {
      setConfirmingUnmanageId(id);
      setConfirmingUninstallId(null);
      setTimeout(() => {
        setConfirmingUnmanageId((prev) => (prev === id ? null : prev));
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

  return (
    <div className="installed-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">📦 已安装应用 ({installedApps.length})</h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {onOpenRules && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
              onClick={onOpenRules}
              title="查看与管理版本控制与屏蔽规则"
            >
              <span>🛡️ 规则</span>
              {updateRules.length > 0 && (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '0 6px',
                    borderRadius: '8px',
                    background: 'var(--brand-primary)',
                    color: '#000',
                    fontWeight: 700,
                  }}
                >
                  {updateRules.length}
                </span>
              )}
            </button>
          )}
          {onExportAppsJson && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px' }}
              onClick={onExportAppsJson}
              title="导出应用清单为规范 JSON 备份文件"
              disabled={installedApps.length === 0}
            >
              📋 导出 JSON
            </button>
          )}
          {onExportApps && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px' }}
              onClick={onExportApps}
              title="导出已安装应用清单为 Markdown 文档"
              disabled={installedApps.length === 0}
            >
              📋 导出清单
            </button>
          )}
          {onScanSystemApps && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px' }}
              onClick={onScanSystemApps}
              title="存量应用纳管：扫描系统已安装软件并接管更新"
            >
              🔍 存量应用纳管
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
            const rule = updateRules.find((r) => r.app_id.toLowerCase() === app.app_id.toLowerCase());
            const isFrozen = Boolean(rule?.is_frozen);
            const isHidden = Boolean(rule?.is_hidden);
            const isMenuOpen = activeMenuId === app.app_id;
            const iconInfo = resolveInstalledIconInfo(app, apps);

            return (
              <div key={app.app_id} className="app-card" style={{ padding: '18px', zIndex: isMenuOpen ? 50 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                    <div
                      style={{ cursor: onOpenDetail ? 'pointer' : 'default', flexShrink: 0 }}
                      onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                      title={onOpenDetail ? '查看应用详情' : undefined}
                    >
                      <AppIcon
                        icon={iconInfo.icon}
                        name={app.app_name}
                        appId={app.app_id}
                        owner={iconInfo.owner}
                        repo={iconInfo.repo}
                        iconBg={iconInfo.iconBg}
                        className="app-icon"
                        size={46}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h4
                        style={{
                          margin: '0 0 4px 0',
                          fontSize: '15px',
                          cursor: onOpenDetail ? 'pointer' : 'default',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                        title={onOpenDetail ? '查看应用详情' : undefined}
                      >
                        {app.app_name}
                      </h4>
                      <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        版本 {app.version} · 安装于 {formatAppDate(app.installed_at)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                    {isFrozen && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '2px 7px',
                          borderRadius: '10px',
                          background: 'rgba(59, 130, 246, 0.15)',
                          color: '#60a5fa',
                          fontWeight: 600,
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                        }}
                        title="已锁定当前版本，不再接收更新提示"
                      >
                        🔒 已锁定
                      </span>
                    )}
                    {isHidden && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '2px 7px',
                          borderRadius: '10px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#f87171',
                          fontWeight: 600,
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                        }}
                        title="已从探索发现及可更新列表中屏蔽"
                      >
                        👁️ 已隐藏
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: 'var(--brand-subtle)',
                        color: badge.color,
                        fontWeight: 500,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                </div>

                <div style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="text"
                      readOnly
                      value={app.install_path}
                      placeholder="正在自动探测或未检测到安装路径..."
                      style={{
                        flex: 1,
                        fontSize: '11.5px',
                        padding: '4px 8px',
                        background: 'var(--bg-acrylic-input, rgba(0, 0, 0, 0.25))',
                        border: '1px solid var(--border-acrylic)',
                        borderRadius: 'var(--radius-sm)',
                        color: app.install_path ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                        fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                        outline: 'none',
                        cursor: 'text',
                        userSelect: 'all',
                      }}
                      title={app.install_path || '未检测到安装路径'}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    {app.install_path ? (
                      <button
                        className="btn-fluent btn-secondary"
                        style={{
                          padding: '4px 8px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: copiedId === app.app_id ? '#4ade80' : 'var(--text-secondary)',
                        }}
                        onClick={() => handleCopyPath(app.app_id, app.install_path)}
                        title="复制完整安装绝对路径"
                      >
                        {copiedId === app.app_id ? '✓ 已复制' : '复制路径'}
                      </button>
                    ) : (
                      <button
                        className="btn-fluent btn-secondary"
                        style={{
                          padding: '4px 8px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: 'var(--brand-primary)',
                        }}
                        onClick={() => onScanSystemApps && onScanSystemApps()}
                        title="刷新并重新探测本地安装路径"
                      >
                        🔍 重新探测
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
                  <InstalledItemActions
                    app={app}
                    isFrozen={isFrozen}
                    isHidden={isHidden}
                    isMenuOpen={isMenuOpen}
                    confirmingUninstallId={confirmingUninstallId}
                    confirmingUnmanageId={confirmingUnmanageId}
                    onTriggerUninstall={handleTriggerUninstall}
                    onTriggerUnmanage={handleTriggerUnmanage}
                    onCancelConfirm={() => {
                      setConfirmingUninstallId(null);
                      setConfirmingUnmanageId(null);
                    }}
                    onLaunch={onLaunch}
                    onToggleMenu={(id, e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === id ? null : id);
                    }}
                    onCloseMenu={() => setActiveMenuId(null)}
                    onToggleRuleFrozen={onToggleRuleFrozen}
                    onToggleRuleHidden={onToggleRuleHidden}
                    onOpenRules={onOpenRules}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {installedApps.map((app) => {
            const badge = getMethodBadge(app.install_method);
            const rule = updateRules.find((r) => r.app_id.toLowerCase() === app.app_id.toLowerCase());
            const isFrozen = Boolean(rule?.is_frozen);
            const isHidden = Boolean(rule?.is_hidden);
            const isMenuOpen = activeMenuId === app.app_id;
            const iconInfo = resolveInstalledIconInfo(app, apps);

            return (
              <div
                key={app.app_id}
                className="app-card"
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  zIndex: isMenuOpen ? 50 : 1,
                }}
              >
                <div
                  style={{ cursor: onOpenDetail ? 'pointer' : 'default', flexShrink: 0 }}
                  onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                  title={onOpenDetail ? '查看应用详情' : undefined}
                >
                  <AppIcon
                    icon={iconInfo.icon}
                    name={app.app_name}
                    appId={app.app_id}
                    owner={iconInfo.owner}
                    repo={iconInfo.repo}
                    iconBg={iconInfo.iconBg}
                    className="app-icon"
                    size={38}
                  />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span
                      style={{ fontWeight: 600, cursor: onOpenDetail ? 'pointer' : 'default' }}
                      onClick={() => onOpenDetail && onOpenDetail(app.app_id)}
                      title={onOpenDetail ? '查看应用详情' : undefined}
                    >
                      {app.app_name}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{app.version}</span>
                    {isFrozen && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'rgba(59, 130, 246, 0.15)',
                          border: '1px solid rgba(59, 130, 246, 0.35)',
                          color: 'var(--brand-primary)',
                          fontWeight: 600,
                        }}
                      >
                        🔒 锁定版本
                      </span>
                    )}
                    {isHidden && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          border: '1px solid rgba(239, 68, 68, 0.35)',
                          color: '#ef4444',
                          fontWeight: 600,
                        }}
                      >
                        👁️ 已隐藏
                      </span>
                    )}
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
                    <span>路径: {app.install_path || '未检测到安装路径 (启动时将自动嗅探修复)'} · 安装于 {formatAppDate(app.installed_at)}</span>
                    {app.install_path ? (
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
                    ) : (
                      onScanSystemApps && (
                        <button
                          onClick={() => onScanSystemApps()}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--brand-primary)',
                            cursor: 'pointer',
                            fontSize: '11px',
                            padding: '0 4px',
                          }}
                        >
                          🔍 重新探测
                        </button>
                      )
                    )}
                  </div>
                </div>

                <InstalledItemActions
                  app={app}
                  isFrozen={isFrozen}
                  isHidden={isHidden}
                  isMenuOpen={isMenuOpen}
                  confirmingUninstallId={confirmingUninstallId}
                  confirmingUnmanageId={confirmingUnmanageId}
                  onTriggerUninstall={handleTriggerUninstall}
                  onTriggerUnmanage={handleTriggerUnmanage}
                  onCancelConfirm={() => {
                    setConfirmingUninstallId(null);
                    setConfirmingUnmanageId(null);
                  }}
                  onLaunch={onLaunch}
                  onToggleMenu={(id, e) => {
                    e.stopPropagation();
                    setActiveMenuId(activeMenuId === id ? null : id);
                  }}
                  onCloseMenu={() => setActiveMenuId(null)}
                  onToggleRuleFrozen={onToggleRuleFrozen}
                  onToggleRuleHidden={onToggleRuleHidden}
                  onOpenRules={onOpenRules}
                  compact={true}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
