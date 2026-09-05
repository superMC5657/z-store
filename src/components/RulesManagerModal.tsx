import React, { useState } from 'react';
import { UpdateRule } from '../types';

interface RulesManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  updateRules: UpdateRule[];
  onRemoveRule: (appId: string) => Promise<void>;
  onClearRuleSkip: (appId: string) => Promise<void>;
  onToggleRuleFrozen: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden: (appId: string, isHidden: boolean) => Promise<void>;
}

export const RulesManagerModal: React.FC<RulesManagerModalProps> = ({
  isOpen,
  onClose,
  updateRules,
  onRemoveRule,
  onClearRuleSkip,
  onToggleRuleFrozen,
  onToggleRuleHidden,
}) => {
  const [rulesTab, setRulesTab] = useState<'all' | 'skipped' | 'frozen' | 'hidden'>('all');
  const [filterQuery, setFilterQuery] = useState('');

  if (!isOpen) return null;

  const filteredRules = updateRules.filter((r) => {
    if (filterQuery.trim() && !r.app_id.toLowerCase().includes(filterQuery.trim().toLowerCase())) {
      return false;
    }
    if (rulesTab === 'skipped') return Boolean(r.skipped_version);
    if (rulesTab === 'frozen') return r.is_frozen;
    if (rulesTab === 'hidden') return r.is_hidden;
    return true;
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '680px',
          maxHeight: '82vh',
          background: 'var(--bg-acrylic-dialog, #1e2024)',
          backdropFilter: 'blur(30px) saturate(140%)',
          border: '1px solid var(--border-acrylic)',
          borderRadius: '14px',
          boxShadow: '0 24px 50px rgba(0,0,0,0.42)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'fadeIn 0.2s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>🛡️</span>
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 600, color: 'var(--text-primary)' }}>
                版本策略与屏蔽规则管理 ({updateRules.length})
              </h3>
            </div>
            <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
              管理已跳过版本、版本锁定与全局隐藏的开源应用，随时恢复正常版本更新通知
            </p>
          </div>
          <button
            onClick={onClose}
            className="btn-fluent btn-secondary"
            style={{ padding: '4px 8px', border: 'none', background: 'transparent', fontSize: '16px' }}
          >
            ✕
          </button>
        </div>

        {/* Filter Toolbar */}
        <div
          style={{
            padding: '12px 24px',
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.05))',
            flexWrap: 'wrap',
          }}
        >
          <div className="segmented-group" style={{ padding: '2px' }}>
            {[
              { id: 'all', label: `全部 (${updateRules.length})` },
              { id: 'skipped', label: `⏭️ 已跳过 (${updateRules.filter((r) => Boolean(r.skipped_version)).length})` },
              { id: 'frozen', label: `🔒 已锁定 (${updateRules.filter((r) => r.is_frozen).length})` },
              { id: 'hidden', label: `👁️ 已隐藏 (${updateRules.filter((r) => r.is_hidden).length})` },
            ].map((tab) => (
              <button
                key={tab.id}
                className={`segmented-item ${rulesTab === tab.id ? 'active' : ''}`}
                style={{ fontSize: '12px', padding: '4px 10px' }}
                onClick={() => setRulesTab(tab.id as any)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            className="settings-input"
            placeholder="搜索规则应用 ID..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            style={{ width: '160px', fontSize: '11px', padding: '4px 8px' }}
          />
        </div>

        {/* Rules Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {filteredRules.length === 0 ? (
            <div
              style={{
                padding: '48px 20px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: '13px',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '10px' }}>📋</div>
              {updateRules.length === 0
                ? '当前未设置任何版本跳过、锁定或隐藏规则。您可以在「更新中心」的应用卡片更多菜单（···）中配置规则。'
                : '当前分类或筛选条件下未检索到匹配的规则记录。'}
            </div>
          ) : (
            filteredRules.map((rule) => {
              const dateStr = rule.updated_at
                ? new Date(
                    rule.updated_at * 1000 > 1000000000000
                      ? rule.updated_at
                      : rule.updated_at * 1000
                  ).toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '近期设置';

              return (
                <div
                  key={rule.app_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'var(--card-bg-subtle, rgba(255,255,255,0.03))',
                    border: '1px solid var(--border-color)',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '180px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {rule.app_id}
                      </span>
                      {rule.skipped_version && (
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: '#f59e0b',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                          }}
                        >
                          跳过 {rule.skipped_version}
                        </span>
                      )}
                      {rule.is_frozen && (
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'rgba(14, 165, 233, 0.15)',
                            color: '#38bdf8',
                            border: '1px solid rgba(14, 165, 233, 0.3)',
                          }}
                        >
                          锁定当前版本
                        </span>
                      )}
                      {rule.is_hidden && (
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: '#ef4444',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                          }}
                        >
                          已隐藏
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      生效于: {dateStr}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {rule.skipped_version && (
                      <button
                        type="button"
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: '11px', padding: '4px 8px' }}
                        onClick={() => onClearRuleSkip(rule.app_id)}
                      >
                        恢复提醒
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                      onClick={() => onToggleRuleFrozen(rule.app_id, !rule.is_frozen)}
                    >
                      {rule.is_frozen ? '解除锁定' : '锁定版本'}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                      onClick={() => onToggleRuleHidden(rule.app_id, !rule.is_hidden)}
                    >
                      {rule.is_hidden ? '取消隐藏' : '隐藏应用'}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px', color: '#ef4444' }}
                      onClick={() => onRemoveRule(rule.app_id)}
                      title="清除该应用的所有规则"
                    >
                      🗑️ 移除规则
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'flex-end',
            background: 'var(--card-bg-subtle, rgba(0,0,0,0.15))',
          }}
        >
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '6px 18px' }}
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};