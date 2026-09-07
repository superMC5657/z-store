import React, { useState } from 'react';
import { marked } from 'marked';
import { UpdateItem } from '../types';
import { sanitizeHtml } from '../utils/sanitize';
import { FlyoutMenu } from '../components/FlyoutMenu';

interface UpdatesViewProps {
  updates: UpdateItem[];
  onApplyUpdate: (id: string) => Promise<void>;
  onBatchUpdateAll: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onIgnoreUpdate?: (id: string) => void;
  onSkipVersion?: (id: string, version: string) => Promise<void>;
  onFreezeVersion?: (id: string) => Promise<void>;
  onHideApp?: (id: string) => Promise<void>;
  updateRulesCount?: number;
  onOpenRules?: () => void;
}

export const UpdatesView: React.FC<UpdatesViewProps> = ({
  updates,
  onApplyUpdate,
  onBatchUpdateAll,
  onCheckUpdates,
  onIgnoreUpdate,
  onSkipVersion,
  onFreezeVersion,
  onHideApp,
  updateRulesCount,
  onOpenRules,
}) => {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());

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
                setIsChecking(true);
                try {
                  await onCheckUpdates();
                } finally {
                  setIsChecking(false);
                }
              }}
              disabled={isChecking || isUpdatingAll}
              style={{ fontSize: '13px', padding: '6px 14px' }}
              title="向各开源托管仓库实时检查最新版本"
            >
              {isChecking ? '正在检查...' : '🔍 检查更新'}
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

      {updates.length === 0 ? (
        <div className="empty-state-card">
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>✨</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>太棒了！所有应用均已是最新版本</h4>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
            Z-Store 基于 ETag 304 条件缓存静默轮询 GitHub Releases，在有新发布时将第一时间在此通知您。
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {updates.map((item) => {
            const isExpanded = expandedId === item.app_id;
            const isThisUpdating = updatingId === item.app_id;
            const isMenuOpen = activeMenuId === item.app_id;
            const isFading = fadingIds.has(item.app_id);

            return (
              <div
                key={item.app_id}
                className="app-card"
                style={{
                  padding: '20px',
                  position: 'relative',
                  zIndex: isMenuOpen ? 50 : 1,
                  opacity: isFading ? 0 : 1,
                  transform: isFading ? 'scale(0.96) translateY(-8px)' : 'scale(1) translateY(0)',
                  transition: 'opacity 0.28s cubic-bezier(0.1, 0.9, 0.2, 1), transform 0.28s cubic-bezier(0.1, 0.9, 0.2, 1)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h4 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>{item.app_name}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>当前: {item.current_version}</span>
                      <span>➔</span>
                      <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>
                        最新: {item.latest_version}
                      </span>
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

