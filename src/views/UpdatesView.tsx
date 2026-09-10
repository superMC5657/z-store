import React, { useState } from 'react';
import { marked } from 'marked';
import { AppSummary, UpdateItem, UpdateCheckProgressPayload, WatchUpdatedPayload } from '../types';
import { sanitizeHtml } from '../utils/sanitize';
import { FlyoutMenu } from '../components/FlyoutMenu';
import { AppIcon } from '../components/AppIcon';
import { resolveAppIconInfo } from '../utils/appHelper';

interface UpdatesViewProps {
  updates: UpdateItem[];
  apps?: AppSummary[];
  isChecking?: boolean;
  checkProgress?: UpdateCheckProgressPayload | null;
  onApplyUpdate: (id: string) => Promise<void>;
  onBatchUpdateAll: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onIgnoreUpdate?: (id: string) => void;
  onSkipVersion?: (id: string, version: string) => Promise<void>;
  onFreezeVersion?: (id: string) => Promise<void>;
  onHideApp?: (id: string) => Promise<void>;
  updateRulesCount?: number;
  onOpenRules?: () => void;
  // FR-6.2: 关注应用的新版本应用内提醒（经 zstore://watch-updated 事件聚合）
  watchNotifications?: WatchUpdatedPayload[];
  onOpenWatchedApp?: (id: string) => void;
  onDismissWatch?: (appId: string) => void;
}

export const UpdatesView: React.FC<UpdatesViewProps> = ({
  updates,
  apps = [],
  isChecking: propIsChecking,
  checkProgress,
  onApplyUpdate,
  onBatchUpdateAll,
  onCheckUpdates,
  onIgnoreUpdate,
  onSkipVersion,
  onFreezeVersion,
  onHideApp,
  updateRulesCount,
  onOpenRules,
  watchNotifications,
  onOpenWatchedApp,
  onDismissWatch,
}) => {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [localChecking, setLocalChecking] = useState(false);
  const isChecking = propIsChecking !== undefined ? propIsChecking : localChecking;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());

  const resolveIconInfo = (appId: string, appName: string, iconOverride?: string, iconBgOverride?: string) =>
    resolveAppIconInfo(appId, appName, apps, iconOverride, iconBgOverride);

  const handleUpdate = async (id: string) => {
    try {
      setUpdatingId(id);
      await onApplyUpdate(id);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdateAll = async () => {
    try {
      setIsUpdatingAll(true);
      await onBatchUpdateAll();
    } finally {
      setIsUpdatingAll(false);
    }
  };

  const triggerAnimatedAction = async (id: string, action: () => Promise<void> | void) => {
    setActiveMenuId(null);
    setFadingIds((prev) => new Set(prev).add(id));
    setTimeout(async () => {
      await action();
      setFadingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 280);
  };

  return (
    <div className="updates-view view-entrance">
      <div className="section-header">
        <div>
          <h3 className="section-title" style={{ margin: 0 }}>🔄 可更新项管理 ({updates.length})</h3>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-tertiary)' }}>
            支持跳过破坏性版本或永久锁定，可点击「🛡️ 规则」随时管理或恢复
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {onOpenRules && (
            <button
              className="btn-fluent btn-secondary"
              onClick={onOpenRules}
              style={{ fontSize: '13px', padding: '6px 14px' }}
              title="查看与管理跳过、锁定或隐藏的更新规则"
            >
              🛡️ 规则 {typeof updateRulesCount === 'number' && updateRulesCount > 0 ? `(${updateRulesCount})` : ''}
            </button>
          )}
          {onCheckUpdates && (
            <button
              className="btn-fluent btn-secondary"
              onClick={async () => {
                setLocalChecking(true);
                try {
                  await onCheckUpdates();
                } finally {
                  setLocalChecking(false);
                }
              }}
              disabled={isChecking || isUpdatingAll}
              style={{ fontSize: '13px', padding: '6px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              title="向各开源托管仓库实时检查最新版本"
            >
              {isChecking ? (
                <>
                  <span className="spinner-icon" style={{ width: '12px', height: '12px', borderWidth: '1.5px' }} />
                  <span>正在逐项检测...</span>
                </>
              ) : (
                <>
                  <span>🔍</span>
                  <span>检查更新</span>
                </>
              )}
            </button>
          )}
          {updates.length > 0 && (
            <button
              className="btn-fluent btn-primary"
              onClick={handleUpdateAll}
              disabled={isUpdatingAll || isChecking}
              style={{ fontWeight: 600, fontSize: '13px' }}
            >
              {isUpdatingAll ? '正在批量更新中...' : `一键全部升级 (${updates.length} 个就绪)`}
            </button>
          )}
        </div>
      </div>

      {/* 实时检查更新流式进度条 */}
      {isChecking && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            marginBottom: '16px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--brand-subtle)',
            border: '1px solid var(--border-nav-active)',
            fontSize: '13px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="spinner-icon" style={{ width: '14px', height: '14px', borderWidth: '2px', flexShrink: 0 }} />
            <span>
              <strong>正在流式比对开源应用最新发布</strong>
              {checkProgress && checkProgress.total > 0 ? (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {' '}（已检查 {checkProgress.checked} / {checkProgress.total} 款
                  {checkProgress.app_name ? ` · 正在比对 ${checkProgress.app_name}` : ''}）
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>，发现可用更新将立即在此跳出...</span>
              )}
            </span>
          </div>
          {checkProgress && checkProgress.total > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--brand-primary)', fontWeight: 600, flexShrink: 0 }}>
              {Math.round((checkProgress.checked / checkProgress.total) * 100)}%
            </div>
          )}
        </div>
      )}

      {/* FR-6.2: 我关注的应用动态（与已安装更新相互独立，仅作提醒） */}
      {watchNotifications && watchNotifications.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            marginBottom: '16px',
            padding: '14px 18px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--brand-subtle)',
            border: '1px solid var(--border-nav-active)',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--brand-primary)' }}>
            👁 你关注的应用有新动态 ({watchNotifications.length})
          </span>
          {watchNotifications.map((n) => {
            const iconInfo = resolveIconInfo(n.app_id, n.app_name || n.app_id);
            return (
              <div
                key={n.app_id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', fontSize: '13px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{ cursor: onOpenWatchedApp ? 'pointer' : 'default', flexShrink: 0 }}
                    onClick={() => onOpenWatchedApp && onOpenWatchedApp(n.app_id)}
                    title={onOpenWatchedApp ? '查看应用详情' : undefined}
                  >
                    <AppIcon
                      icon={iconInfo.icon}
                      name={n.app_name || n.app_id}
                      appId={n.app_id}
                      owner={iconInfo.owner}
                      repo={iconInfo.repo}
                      iconBg={iconInfo.iconBg}
                      size={26}
                      style={{ width: '26px', height: '26px', borderRadius: '7px' }}
                    />
                  </div>
                  <span>
                    你关注的 <strong>{n.app_name || n.app_id}</strong> 发布了 {n.version}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {onOpenWatchedApp && (
                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      onClick={() => onOpenWatchedApp(n.app_id)}
                    >
                      查看详情
                    </button>
                  )}
                  {onDismissWatch && (
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      onClick={() => onDismissWatch(n.app_id)}
                    >
                      不再提醒
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {updates.length === 0 ? (
        isChecking ? (
          <div className="empty-state-card" style={{ padding: '48px 24px' }}>
            <div className="spinner-icon" style={{ width: '36px', height: '36px', borderWidth: '3px', margin: '0 auto 16px auto' }} />
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>正在逐项比对已安装开源应用的最新版本...</h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              只要检测出新版本就会立即跳出一项，请稍候
            </p>
          </div>
        ) : (
          <div className="empty-state-card">
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>✨</div>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>太棒了！所有应用均已是最新版本</h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              Z-Store 基于 ETag 304 条件缓存静默轮询 GitHub Releases，在有新发布时将第一时间在此通知您。
            </p>
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {updates.map((item) => {
            const isExpanded = expandedId === item.app_id;
            const isThisUpdating = updatingId === item.app_id;
            const isMenuOpen = activeMenuId === item.app_id;
            const isFading = fadingIds.has(item.app_id);
            const iconInfo = resolveIconInfo(item.app_id, item.app_name, item.icon, item.icon_bg);

            return (
              <div
                key={item.app_id}
                className="app-card update-item-entrance"
                style={{
                  padding: '20px',
                  position: 'relative',
                  zIndex: isMenuOpen ? 50 : 1,
                  opacity: isFading ? 0 : 1,
                  transform: isFading ? 'scale(0.96) translateY(-8px)' : undefined,
                  transition: 'opacity 0.28s cubic-bezier(0.1, 0.9, 0.2, 1), transform 0.28s cubic-bezier(0.1, 0.9, 0.2, 1)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: 0 }}>
                    <div
                      style={{ cursor: onOpenWatchedApp ? 'pointer' : 'default', flexShrink: 0 }}
                      onClick={() => onOpenWatchedApp && onOpenWatchedApp(item.app_id)}
                      title={onOpenWatchedApp ? '查看应用详情' : undefined}
                    >
                      <AppIcon
                        icon={iconInfo.icon}
                        name={item.app_name}
                        appId={item.app_id}
                        owner={iconInfo.owner}
                        repo={iconInfo.repo}
                        iconBg={iconInfo.iconBg}
                        className="app-icon"
                        size={48}
                        style={{ width: '48px', height: '48px', borderRadius: '12px' }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h4
                        style={{
                          margin: '0 0 6px 0',
                          fontSize: '16px',
                          cursor: onOpenWatchedApp ? 'pointer' : 'default',
                        }}
                        onClick={() => onOpenWatchedApp && onOpenWatchedApp(item.app_id)}
                        title={onOpenWatchedApp ? '查看应用详情' : undefined}
                      >
                        {item.app_name}
                      </h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>当前: {item.current_version}</span>
                        <span>➔</span>
                        <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>
                          最新: {item.latest_version}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', position: 'relative' }}>
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '6px 12px' }}
                      onClick={() => setExpandedId(isExpanded ? null : item.app_id)}
                    >
                      {isExpanded ? '收起更新日志' : '查看日志'}
                    </button>

                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '13px', padding: '6px 16px', fontWeight: 600 }}
                      disabled={isThisUpdating || isUpdatingAll}
                      onClick={() => handleUpdate(item.app_id)}
                    >
                      {isThisUpdating ? '升级中...' : '立即升级'}
                    </button>

                    {/* Fluent 更多菜单按钮 (···) */}
                    <div style={{ position: 'relative' }}>
                      <button
                        className={`btn-fluent btn-secondary ${isMenuOpen ? 'active' : ''}`}
                        style={{
                          padding: '6px 8px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          lineHeight: '1',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenuId(isMenuOpen ? null : item.app_id);
                        }}
                        title="版本控制与规则策略"
                        aria-label="更多操作"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="5" cy="12" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="19" cy="12" r="2" />
                        </svg>
                      </button>

                      <FlyoutMenu
                        isOpen={isMenuOpen}
                        onClose={() => setActiveMenuId(null)}
                        width={210}
                      >
                        {onIgnoreUpdate && (
                          <button
                            className="menu-item-fluent"
                            onClick={() => {
                              triggerAnimatedAction(item.app_id, () => onIgnoreUpdate(item.app_id));
                            }}
                          >
                            <span>🚫</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>仅忽略本次提醒</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                临时隐藏，下次刷新时恢复
                              </div>
                            </div>
                          </button>
                        )}

                        {onSkipVersion && (
                          <button
                            className="menu-item-fluent"
                            onClick={() => {
                              triggerAnimatedAction(item.app_id, () => onSkipVersion(item.app_id, item.latest_version));
                            }}
                          >
                            <span>⏭️</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>跳过此版本</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                跳过 {item.latest_version}，下版再提醒
                              </div>
                            </div>
                          </button>
                        )}

                        {onFreezeVersion && (
                          <button
                            className="menu-item-fluent"
                            onClick={() => {
                              triggerAnimatedAction(item.app_id, () => onFreezeVersion(item.app_id));
                            }}
                          >
                            <span>🔒</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>永久锁定当前版本</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                保留 {item.current_version}，忽略所有更新
                              </div>
                            </div>
                          </button>
                        )}

                        {onHideApp && (
                          <button
                            className="menu-item-fluent"
                            style={{ color: '#f87171' }}
                            onClick={() => {
                              triggerAnimatedAction(item.app_id, () => onHideApp(item.app_id));
                            }}
                          >
                            <span>👁️‍🗨️</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>隐藏此应用</div>
                              <div style={{ fontSize: '10.5px', opacity: 0.85 }}>
                                在更新中心与探索列表中隐藏
                              </div>
                            </div>
                          </button>
                        )}
                      </FlyoutMenu>
                    </div>
                  </div>
                </div>

                {isExpanded && item.changelog && (
                  <div
                    style={{
                      marginTop: '16px',
                      padding: '16px 20px',
                      background: 'var(--bg-acrylic-thin)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-acrylic)',
                    }}
                  >
                    <div
                      className="readme-markdown-body"
                      dangerouslySetInnerHTML={{
                        __html: sanitizeHtml(marked.parse(item.changelog, { async: false }) as string),
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

