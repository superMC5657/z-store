import React, { useState } from 'react';
import { InstalledApp, UpdateRule } from '../types';

export interface RulesManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  updateRules: UpdateRule[];
  installedApps?: InstalledApp[];
  onRemoveRule: (appId: string) => Promise<void>;
  onClearRuleSkip: (appId: string) => Promise<void>;
  onToggleRuleFrozen: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden: (appId: string, isHidden: boolean) => Promise<void>;
  onSkipVersion?: (appId: string, version: string) => Promise<void>;
}

export const RulesManagerModal: React.FC<RulesManagerModalProps> = ({
  isOpen,
  onClose,
  updateRules,
  installedApps = [],
  onRemoveRule,
  onClearRuleSkip,
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onSkipVersion,
}) => {
  const [rulesTab, setRulesTab] = useState<'all' | 'skipped' | 'frozen' | 'hidden'>('all');
  const [filterQuery, setFilterQuery] = useState('');

  // Add rule state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [customAppId, setCustomAppId] = useState<string>('');
  const [ruleType, setRuleType] = useState<'frozen' | 'hidden' | 'skip'>('frozen');
  const [skipVersion, setSkipVersion] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const showNotice = (msg: string) => {
    setNoticeMessage(msg);
    setTimeout(() => {
      setNoticeMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  };

  const handleCreateRule = async () => {
    const finalAppId = (selectedAppId === '__custom__' || !selectedAppId ? customAppId : selectedAppId).trim();
    if (!finalAppId) {
      showNotice('⚠️ 请选择或输入要配置规则的应用 ID');
      return;
    }

    setIsSubmitting(true);
    try {
      if (ruleType === 'frozen') {
        await onToggleRuleFrozen(finalAppId, true);
        showNotice(`✅ 已成功为 ${finalAppId} 锁定当前版本`);
      } else if (ruleType === 'hidden') {
        await onToggleRuleHidden(finalAppId, true);
        showNotice(`✅ 已成功将 ${finalAppId} 设为全局隐藏`);
      } else if (ruleType === 'skip') {
        if (!skipVersion.trim()) {
          showNotice('⚠️ 请输入要跳过的具体版本号 (如 v1.2.0)');
          setIsSubmitting(false);
          return;
        }
        if (onSkipVersion) {
          await onSkipVersion(finalAppId, skipVersion.trim());
          showNotice(`✅ 已成功为 ${finalAppId} 设置跳过版本 ${skipVersion.trim()}`);
        }
      }
      setIsAddOpen(false);
      setSelectedAppId('');
      setCustomAppId('');
      setSkipVersion('');
    } catch (err) {
      showNotice(`❌ 规则保存失败: ${String(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

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
      className="modal-backdrop"
      style={{ zIndex: 1000 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="detail-modal"
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: 'min(86vh, calc(100% - 32px))',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div
          className="modal-header"
          style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-acrylic)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
            flexShrink: 0,
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className={`btn-fluent ${isAddOpen ? 'btn-secondary' : 'btn-primary'}`}
              style={{ fontSize: '12px', padding: '5px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
              onClick={() => setIsAddOpen(!isAddOpen)}
            >
              <span>{isAddOpen ? '收起表单 ▲' : '➕ 添加规则'}</span>
            </button>
            <button
              onClick={onClose}
              className="modal-close-btn"
              aria-label="关闭弹窗"
              style={{ position: 'relative', top: 'auto', right: 'auto' }}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>
        </div>

        {/* Inline Notification Banner */}
        {noticeMessage && (
          <div
            style={{
              padding: '8px 24px',
              fontSize: '12px',
              fontWeight: 500,
              background: noticeMessage.includes('❌') ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: noticeMessage.includes('❌') ? '#ef4444' : '#10b981',
              borderBottom: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>{noticeMessage}</span>
          </div>
        )}

        {/* Collapsible Manual Add Rule Form */}
        {isAddOpen && (
          <div
            style={{
              padding: '16px 24px',
              background: 'var(--card-bg-subtle, rgba(255, 255, 255, 0.03))',
              borderBottom: '1px solid var(--border-acrylic)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              animation: 'fadeIn 0.2s ease-out',
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>➕ 手动新建软件版本与屏蔽规则</span>
            </div>

            {/* Target App Row */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                1. 选择或输入目标开源软件:
              </label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {installedApps.length > 0 && (
                  <select
                    className="settings-input"
                    value={selectedAppId}
                    onChange={(e) => setSelectedAppId(e.target.value)}
                    style={{ flex: '1 1 240px', fontSize: '12px', padding: '6px 10px' }}
                  >
                    <option value="">-- 从已安装软件中快捷选择 ({installedApps.length} 款) --</option>
                    {installedApps.map((a) => (
                      <option key={a.app_id} value={a.app_id}>
                        {a.app_name} (ID: {a.app_id} · v{a.version})
                      </option>
                    ))}
                    <option value="__custom__">✍️ 手动输入其他软件 ID...</option>
                  </select>
                )}

                {(selectedAppId === '__custom__' || installedApps.length === 0 || !selectedAppId) && (
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="输入开源软件 ID (如 rustdesk, localsend, obsidian)..."
                    value={customAppId}
                    onChange={(e) => setCustomAppId(e.target.value)}
                    style={{ flex: '1 1 200px', fontSize: '12px', fontFamily: 'monospace' }}
                  />
                )}
              </div>
            </div>

            {/* Rule Policy Type */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                2. 选择策略行为:
              </label>
              <div className="segmented-group" style={{ padding: '3px', alignSelf: 'flex-start' }}>
                <button
                  type="button"
                  className={`segmented-item ${ruleType === 'frozen' ? 'active' : ''}`}
                  style={{ fontSize: '12px', padding: '5px 12px' }}
                  onClick={() => setRuleType('frozen')}
                >
                  🔒 永久锁定版本 (不提示更新)
                </button>
                <button
                  type="button"
                  className={`segmented-item ${ruleType === 'hidden' ? 'active' : ''}`}
                  style={{ fontSize: '12px', padding: '5px 12px' }}
                  onClick={() => setRuleType('hidden')}
                >
                  👁️ 全局隐藏软件 (探索中屏蔽)
                </button>
                <button
                  type="button"
                  className={`segmented-item ${ruleType === 'skip' ? 'active' : ''}`}
                  style={{ fontSize: '12px', padding: '5px 12px' }}
                  onClick={() => setRuleType('skip')}
                >
                  ⏭️ 跳过特定版本
                </button>
              </div>

              {ruleType === 'skip' && (
                <div style={{ marginTop: '4px' }}>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="请输入要跳过的具体版本号 (例如 v1.4.0)..."
                    value={skipVersion}
                    onChange={(e) => setSkipVersion(e.target.value)}
                    style={{ width: '260px', fontSize: '12px' }}
                  />
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px' }}
                onClick={() => {
                  setIsAddOpen(false);
                  setSelectedAppId('');
                  setCustomAppId('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-fluent btn-primary"
                style={{ fontSize: '12px', padding: '6px 18px', fontWeight: 600 }}
                onClick={handleCreateRule}
                disabled={isSubmitting}
              >
                {isSubmitting ? '正在保存...' : '确认添加规则'}
              </button>
            </div>
          </div>
        )}

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
          className="modal-scroll-area"
          style={{
            flex: '1 1 auto',
            minHeight: 0,
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
                padding: '44px 20px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: '13px',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '10px' }}>📋</div>
              <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', marginBottom: '6px' }}>
                {updateRules.length === 0 ? '当前未配置任何版本策略规则' : '当前分类下暂无匹配规则'}
              </div>
              <p style={{ maxWidth: '440px', margin: '0 auto 16px', lineHeight: 1.5 }}>
                {updateRules.length === 0
                  ? '您可以点击上方「➕ 添加规则」直接为已安装或任意应用锁定版本，也可以在「已安装」或「更新中心」卡片菜单中快捷锁定。'
                  : '可尝试切换上方分类或清空搜索关键词。'}
              </p>
              {updateRules.length === 0 && !isAddOpen && (
                <button
                  type="button"
                  className="btn-fluent btn-primary"
                  style={{ fontSize: '12px', padding: '7px 18px' }}
                  onClick={() => setIsAddOpen(true)}
                >
                  ➕ 立即添加第一条规则
                </button>
              )}
            </div>
          ) : (
            filteredRules.map((rule) => {
              const matchedApp = installedApps.find((a) => a.app_id.toLowerCase() === rule.app_id.toLowerCase());
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {matchedApp ? matchedApp.app_name : rule.app_id}
                      </span>
                      {matchedApp && (
                        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>
                          ({rule.app_id})
                        </span>
                      )}
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
                            background: 'var(--brand-subtle)',
                            color: 'var(--brand-primary)',
                            border: '1px solid var(--border-nav-active)',
                          }}
                        >
                          🔒 锁定当前版本
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
                          👁️ 已隐藏
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
                        onClick={async () => {
                          await onClearRuleSkip(rule.app_id);
                          showNotice(`✓ 已恢复 ${rule.app_id} 的版本更新提醒`);
                        }}
                      >
                        恢复提醒
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                      onClick={async () => {
                        await onToggleRuleFrozen(rule.app_id, !rule.is_frozen);
                        showNotice(rule.is_frozen ? `✓ 已解除 ${rule.app_id} 的版本锁定` : `✓ 已锁定 ${rule.app_id} 当前版本`);
                      }}
                    >
                      {rule.is_frozen ? '解除锁定' : '锁定版本'}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                      onClick={async () => {
                        await onToggleRuleHidden(rule.app_id, !rule.is_hidden);
                        showNotice(rule.is_hidden ? `✓ 已取消隐藏 ${rule.app_id}` : `✓ 已将 ${rule.app_id} 全局隐藏`);
                      }}
                    >
                      {rule.is_hidden ? '取消隐藏' : '隐藏应用'}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px', color: '#ef4444' }}
                      onClick={async () => {
                        await onRemoveRule(rule.app_id);
                        showNotice(`✓ 已清空 ${rule.app_id} 的全部规则`);
                      }}
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
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--card-bg-subtle, rgba(0,0,0,0.15))',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            💡 规则变更将自动保存在本地数据库并在后续检查更新与搜索时实时生效
          </span>
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