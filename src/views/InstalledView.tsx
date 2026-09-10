import React, { useState } from 'react';
import { AppSummary, InstalledApp, UpdateRule } from '../types';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { AppIcon } from '../components/AppIcon';
import { formatAppDate, getMethodBadge, resolveInstalledIconInfo } from '../utils/appHelper';

interface InstalledViewProps {
  installedApps: InstalledApp[];
  apps?: AppSummary[];
  uninstallingAppIds?: Set<string>;
  onOpenDetail?: (id: string) => void;
  onLaunch: (id: string) => void;
  onUninstall: (id: string) => void;
  onUnmanage?: (id: string) => void;
  onScanSystemApps?: () => void;
  onExportAppsJson?: () => void;
  updateRules?: UpdateRule[];
  onToggleRuleFrozen?: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden?: (appId: string, isHidden: boolean) => Promise<void>;
  onOpenRules?: () => void;
  onRefresh?: () => Promise<void> | void;
  isRefreshing?: boolean;
}

interface InstalledItemActionsProps {
  app: InstalledApp;
  isFrozen: boolean;
  isHidden: boolean;
  isMenuOpen: boolean;
  isUninstallingLoading?: boolean;
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
  compact?: boolean;
}

const InstalledItemActions: React.FC<InstalledItemActionsProps> = ({
  app,
  isFrozen,
  isHidden,
  isMenuOpen,
  isUninstallingLoading = false,
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
  compact = false,
}) => {
  const isUnmanaging = confirmingUnmanageId === app.app_id;
  const isUninstalling = confirmingUninstallId === app.app_id;

  return (
    <div className={`installed-actions-group ${compact ? 'compact' : ''}`}>
      {/* 左侧区域：破坏性/管理操作 (卡片模式在左，紧凑列表模式居右归并) */}
      <div className="installed-actions-left">
        {isUninstallingLoading ? (
          <button
            className={`installed-action-btn btn-installed-uninstall btn-loading ${compact ? 'compact' : ''}`}
            disabled
            title="正在调起官方卸载向导并等待完成..."
          >
            ⏳ 正在卸载...
          </button>
        ) : isUnmanaging ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className={`installed-action-btn btn-confirm-warning ${compact ? 'compact' : ''}`}
              onClick={() => onTriggerUnmanage(app.app_id)}
              title="确认从 Z-Store 列表中移除纳管记录"
            >
              确认取消纳管？
            </button>
            <button
              className={`installed-action-btn btn-confirm-cancel ${compact ? 'compact' : ''}`}
              onClick={onCancelConfirm}
              title="取消操作"
            >
              取消
            </button>
          </div>
        ) : isUninstalling ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className={`installed-action-btn btn-confirm-danger ${compact ? 'compact' : ''}`}
              onClick={() => onTriggerUninstall(app.app_id)}
              title="确认调起卸载或清理本地安装文件"
            >
              确认彻底卸载？
            </button>
            <button
              className={`installed-action-btn btn-confirm-cancel ${compact ? 'compact' : ''}`}
              onClick={onCancelConfirm}
              title="取消操作"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            className={`installed-action-btn btn-installed-uninstall ${compact ? 'compact' : ''}`}
            onClick={() => onTriggerUninstall(app.app_id)}
            title="调起官方卸载程序或清理本地安装文件彻底卸载应用"
          >
            卸载
          </button>
        )}
      </div>

      {/* 右侧区域：核心高频行动点 [ ▶ 启动 ] + [ ··· 更多操作 ] */}
      <div className="installed-actions-right">
        <button
          className={`installed-action-btn btn-fluent btn-primary ${compact ? 'compact' : ''}`}
          disabled={isUninstallingLoading}
          onClick={() => onLaunch(app.app_id)}
          title="运行此应用程序"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '4px' }}>
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>启动</span>
        </button>

        <div style={{ position: 'relative' }}>
          <button
            className={`installed-action-btn btn-fluent btn-secondary btn-icon-only ${compact ? 'compact' : ''} ${isMenuOpen ? 'active' : ''}`}
            disabled={isUninstallingLoading}
            onClick={(e) => onToggleMenu(app.app_id, e)}
            title="更多管理与版本控制操作"
            aria-label="更多操作"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>

          <FlyoutMenu
            isOpen={isMenuOpen}
            onClose={onCloseMenu}
            align="right"
            width={210}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' }}>
              {/* 版本锁定 */}
              {onToggleRuleFrozen && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleFrozen(app.app_id, !isFrozen);
                  }}
                  title={isFrozen ? '已锁定当前版本，点击解除锁定并恢复更新提示' : '锁定当前版本，不再提示更新'}
                >
                  <div className="flyout-item-icon">
                    {isFrozen ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                  </div>
                  <div className="flyout-item-content">
                    <div className="flyout-item-title">
                      <span>{isFrozen ? '解除版本锁定' : '锁定当前版本'}</span>
                      {isFrozen && <span className="flyout-item-badge badge-blue">已锁定</span>}
                    </div>
                    <div className="flyout-item-subtitle">
                      {isFrozen ? '点击恢复接收更新提示' : '保留此版本，不再提示更新'}
                    </div>
                  </div>
                </button>
              )}

              {/* 隐藏应用 */}
              {onToggleRuleHidden && (
                <button
                  className="flyout-item"
                  onClick={async () => {
                    onCloseMenu();
                    await onToggleRuleHidden(app.app_id, !isHidden);
                  }}
                  title={isHidden ? '取消隐藏，重新在列表中展示' : '在探索发现与列表中隐藏此应用'}
                >
                  <div className="flyout-item-icon">
                    {isHidden ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    )}
                  </div>
                  <div className="flyout-item-content">
                    <div className="flyout-item-title">
                      <span>{isHidden ? '恢复显示应用' : '在列表中隐藏'}</span>
                      {isHidden && <span className="flyout-item-badge badge-red">已隐藏</span>}
                    </div>
                    <div className="flyout-item-subtitle">
                      {isHidden ? '点击恢复在发现与更新中可见' : '不在探索与更新列表中展示'}
                    </div>
                  </div>
                </button>
              )}

              <div className="flyout-divider" />

              {/* 取消纳管 */}
              <button
                className="flyout-item flyout-item-danger"
                onClick={() => {
                  onCloseMenu();
                  onTriggerUnmanage(app.app_id);
                }}
                title="将此应用从 Z-Store 列表中移除纳管记录（保留本机软件与数据）"
              >
                <div className="flyout-item-icon">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div className="flyout-item-content">
                  <div className="flyout-item-title">取消应用纳管</div>
                  <div className="flyout-item-subtitle">仅移出列表，保留本机应用与数据</div>
                </div>
              </button>
            </div>
          </FlyoutMenu>
        </div>
      </div>
    </div>
  );
};

export const InstalledView: React.FC<InstalledViewProps> = ({
  installedApps,
  apps = [],
  uninstallingAppIds,
  onOpenDetail,
  onLaunch,
  onUninstall,
  onUnmanage,
  onScanSystemApps,
  onExportAppsJson,
  updateRules = [],
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onOpenRules,
  onRefresh,
  isRefreshing = false,
}) => {
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [confirmingUninstallId, setConfirmingUninstallId] = useState<string | null>(null);
  const [confirmingUnmanageId, setConfirmingUnmanageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const handleTriggerUninstall = (id: string) => {
    if (uninstallingAppIds?.has(id)) return;
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
          {onRefresh && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
              onClick={onRefresh}
              disabled={isRefreshing}
              title="刷新状态：重新检测本地安装状态，自动清理外部卸载的应用"
            >
              <span className={isRefreshing ? 'spinner-icon' : ''} style={isRefreshing ? { width: '11px', height: '11px', borderWidth: '1.5px' } : undefined}>
                {!isRefreshing && '🔄'}
              </span>
              <span>{isRefreshing ? '刷新中...' : '刷新状态'}</span>
            </button>
          )}
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
              title="导出已安装软件资产清单为规范 JSON 格式文件"
              disabled={installedApps.length === 0}
            >
              📋 导出资产清单 (JSON)
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
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: '0 0 16px 0' }}>
            前往「精选发现」或「分类浏览」探索优质开源应用，享受一键安装与自动更新服务。
          </p>
          {onRefresh && (
            <button
              className="btn-fluent btn-secondary"
              style={{ padding: '6px 16px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <span className={isRefreshing ? 'spinner-icon' : ''} style={isRefreshing ? { width: '12px', height: '12px', borderWidth: '1.5px' } : undefined}>
                {!isRefreshing && '🔄'}
              </span>
              <span>{isRefreshing ? '正在刷新...' : '刷新已安装软件列表'}</span>
            </button>
          )}
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
                        height: '28px',
                        boxSizing: 'border-box',
                        fontSize: '11.5px',
                        padding: '0 8px',
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
                          height: '28px',
                          boxSizing: 'border-box',
                          padding: '0 10px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: copiedId === app.app_id ? '#4ade80' : 'var(--text-secondary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
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
                          height: '28px',
                          boxSizing: 'border-box',
                          padding: '0 10px',
                          fontSize: '11.5px',
                          whiteSpace: 'nowrap',
                          color: 'var(--brand-primary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onClick={() => onScanSystemApps && onScanSystemApps()}
                        title="刷新并重新探测本地安装路径"
                      >
                        🔍 重新探测
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ marginTop: '16px', width: '100%' }}>
                  <InstalledItemActions
                    app={app}
                    isFrozen={isFrozen}
                    isHidden={isHidden}
                    isMenuOpen={isMenuOpen}
                    isUninstallingLoading={uninstallingAppIds?.has(app.app_id)}
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
                  isUninstallingLoading={uninstallingAppIds?.has(app.app_id)}
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
