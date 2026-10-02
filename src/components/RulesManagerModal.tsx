import React, { useState } from 'react';
import {
  Shield,
  Plus,
  ChevronUp,
  Lock,
  EyeOff,
  SkipForward,
  ShieldAlert,
  Search,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { InstalledApp, UpdateRule } from '../types';
import { SegmentedControl } from './SegmentedControl';
import { EmptyState } from './EmptyState';

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
  const { t, i18n } = useTranslation();
  const [rulesTab, setRulesTab] = useState<'all' | 'skipped' | 'frozen' | 'hidden'>('all');
  const [filterQuery, setFilterQuery] = useState('');

  // 新增规则表单状态
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
      showNotice(t('rules.notice_select_app'));
      return;
    }

    setIsSubmitting(true);
    try {
      if (ruleType === 'frozen') {
        await onToggleRuleFrozen(finalAppId, true);
        showNotice(t('rules.notice_frozen_success', { id: finalAppId }));
      } else if (ruleType === 'hidden') {
        await onToggleRuleHidden(finalAppId, true);
        showNotice(t('rules.notice_hidden_success', { id: finalAppId }));
      } else if (ruleType === 'skip') {
        if (!skipVersion.trim()) {
          showNotice(t('rules.notice_input_skip_version'));
          setIsSubmitting(false);
          return;
        }
        if (onSkipVersion) {
          await onSkipVersion(finalAppId, skipVersion.trim());
          showNotice(t('rules.notice_skip_success', { id: finalAppId, version: skipVersion.trim() }));
        }
      }
      setIsAddOpen(false);
      setSelectedAppId('');
      setCustomAppId('');
      setSkipVersion('');
    } catch (err) {
      showNotice(t('rules.notice_save_failed', { error: String(err) }));
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
        {/* 弹窗头部 */}
        <div
          className="modal-header"
          style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-acrylic-thin)',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Shield size={18} strokeWidth={1.5} style={{ color: 'var(--brand-primary)' }} />
              <h3 style={{ margin: 0, fontSize: 'calc(17px * var(--font-scale))', fontWeight: 590, color: 'var(--text-primary)', letterSpacing: '-0.018em' }}>
                {t('rules.title', { count: updateRules.length })}
              </h3>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className={`btn-fluent ${isAddOpen ? 'btn-secondary' : 'btn-primary'}`}
              style={{ fontSize: 'var(--font-sm)', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={() => setIsAddOpen(!isAddOpen)}
            >
              {isAddOpen ? (
                <>
                  <ChevronUp size={14} strokeWidth={1.5} />
                  <span>{t('rules.collapse_add')}</span>
                </>
              ) : (
                <>
                  <Plus size={14} strokeWidth={1.5} />
                  <span>{t('rules.add_rule')}</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="modal-close-btn"
              aria-label={t('rules.close_modal')}
              style={{ position: 'relative', top: 'auto', right: 'auto' }}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>
        </div>

        {/* 内联通知提示条 */}
        {noticeMessage && (
          <div
            style={{
              padding: '8px 24px',
              fontSize: 'var(--font-sm)',
              fontWeight: 500,
              background: noticeMessage.includes('失败') || noticeMessage.includes('failed') || noticeMessage.includes('Failed') ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: noticeMessage.includes('失败') || noticeMessage.includes('failed') || noticeMessage.includes('Failed') ? '#ef4444' : '#10b981',
              borderBottom: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>{noticeMessage}</span>
          </div>
        )}

        {/* 可折叠的手动添加规则表单 */}
        {isAddOpen && (
          <div
            style={{
              padding: '16px 24px',
              background: 'var(--card-bg-subtle, rgba(255, 255, 255, 0.03))',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              animation: 'fadeIn 0.2s ease-out',
            }}
          >
            <div style={{ fontSize: 'var(--font-base)', fontWeight: 590, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px', letterSpacing: '-0.015em' }}>
              <Plus size={14} strokeWidth={1.5} style={{ color: 'var(--brand-primary)' }} />
              <span>{t('rules.form_manual_title')}</span>
            </div>

            {/* 目标应用选择行 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('rules.form_step_target')}
              </label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {installedApps.length > 0 && (
                  <select
                    className="settings-input"
                    value={selectedAppId}
                    onChange={(e) => setSelectedAppId(e.target.value)}
                    style={{ flex: '1 1 240px', fontSize: 'var(--font-sm)', padding: '6px 10px' }}
                  >
                    <option value="">{t('rules.form_select_installed', { count: installedApps.length })}</option>
                    {installedApps.map((a) => (
                      <option key={a.app_id} value={a.app_id}>
                        {a.app_name} (ID: {a.app_id} · v{a.version})
                      </option>
                    ))}
                    <option value="__custom__">{t('rules.form_custom_input')}</option>
                  </select>
                )}

                {(selectedAppId === '__custom__' || installedApps.length === 0 || !selectedAppId) && (
                  <input
                    type="text"
                    className="settings-input"
                    placeholder={t('rules.form_custom_input_placeholder')}
                    value={customAppId}
                    onChange={(e) => setCustomAppId(e.target.value)}
                    style={{ flex: '1 1 200px', fontSize: 'var(--font-sm)' }}
                  />
                )}
              </div>
            </div>

            {/* 规则策略类型 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('rules.form_step_action')}
              </label>
              <SegmentedControl
                value={ruleType}
                onChange={(val) => setRuleType(val as 'frozen' | 'hidden' | 'skip')}
                style={{ alignSelf: 'flex-start' }}
                options={[
                  {
                    value: 'frozen',
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                        <Lock size={12} />
                        <span>{t('rules.form_type_frozen')}</span>
                      </span>
                    ),
                  },
                  {
                    value: 'hidden',
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                        <EyeOff size={12} />
                        <span>{t('rules.form_type_hidden')}</span>
                      </span>
                    ),
                  },
                  {
                    value: 'skip',
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                        <SkipForward size={12} />
                        <span>{t('rules.form_type_skip')}</span>
                      </span>
                    ),
                  },
                ]}
              />

              {ruleType === 'skip' && (
                <div style={{ marginTop: '4px' }}>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder={t('rules.form_skip_version_placeholder')}
                    value={skipVersion}
                    onChange={(e) => setSkipVersion(e.target.value)}
                    style={{ width: '260px', fontSize: 'var(--font-sm)' }}
                  />
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="modal-footer" style={{ borderTop: 'none', background: 'transparent', padding: '8px 0 0 0', marginTop: '4px' }}>
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: 'var(--font-sm)', padding: '6px 14px' }}
                onClick={() => {
                  setIsAddOpen(false);
                  setSelectedAppId('');
                  setCustomAppId('');
                }}
              >
                {t('rules.cancel')}
              </button>
              <button
                type="button"
                className="btn-fluent btn-primary"
                style={{ fontSize: 'var(--font-sm)', padding: '6px 18px', fontWeight: 510 }}
                onClick={handleCreateRule}
                disabled={isSubmitting}
              >
                {isSubmitting ? t('rules.form_saving') : t('rules.confirm_add')}
              </button>
            </div>
          </div>
        )}

        {/* 过滤工具栏 */}
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
          <SegmentedControl
            value={rulesTab}
            onChange={(val) => setRulesTab(val as 'all' | 'skipped' | 'frozen' | 'hidden')}
            options={[
              {
                value: 'all',
                label: (
                  <span>
                    {t('rules.tab_all_short')} ({updateRules.length})
                  </span>
                ),
              },
              {
                value: 'skipped',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <SkipForward size={11} strokeWidth={1.5} />
                    <span>{t('rules.tab_skipped_short')} ({updateRules.filter((r) => Boolean(r.skipped_version)).length})</span>
                  </span>
                ),
              },
              {
                value: 'frozen',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Lock size={11} strokeWidth={1.5} />
                    <span>{t('rules.tab_frozen_short')} ({updateRules.filter((r) => r.is_frozen).length})</span>
                  </span>
                ),
              },
              {
                value: 'hidden',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <EyeOff size={11} strokeWidth={1.5} />
                    <span>{t('rules.tab_hidden_short')} ({updateRules.filter((r) => r.is_hidden).length})</span>
                  </span>
                ),
              },
            ]}
          />

          <div className="fluent-input-search" style={{ width: '180px' }}>
            <Search size={13} />
            <input
              type="text"
              placeholder={t('rules.search_placeholder')}
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
          </div>
        </div>

        {/* 规则列表内容区 */}
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
            <EmptyState
              icon={<ShieldAlert size={40} strokeWidth={1.5} />}
              title={updateRules.length === 0 ? t('rules.empty_no_rules') : t('rules.empty_filtered')}
              action={
                updateRules.length === 0 && !isAddOpen ? (
                  <button
                    type="button"
                    className="btn-fluent btn-primary"
                    style={{ fontSize: 'var(--font-sm)', padding: '7px 18px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    onClick={() => setIsAddOpen(true)}
                  >
                    <Plus size={14} strokeWidth={1.5} />
                    <span>{t('rules.add_first_rule')}</span>
                  </button>
                ) : undefined
              }
            />
          ) : (
            filteredRules.map((rule) => {
              const matchedApp = installedApps.find((a) => a.app_id.toLowerCase() === rule.app_id.toLowerCase());
              const dateStr = rule.updated_at
                ? new Date(
                    rule.updated_at * 1000 > 1000000000000
                      ? rule.updated_at
                      : rule.updated_at * 1000
                  ).toLocaleDateString(i18n.language || 'zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : t('rules.recent_set');

              return (
                <div
                  key={rule.app_id}
                  className="fluent-list-row"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 14px',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '180px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 590, fontSize: 'var(--font-base)', color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>
                        {matchedApp ? matchedApp.app_name : rule.app_id}
                      </span>
                      {matchedApp && (
                        <span className="text-mono" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                          ({rule.app_id})
                        </span>
                      )}
                      {rule.skipped_version && (
                        <span className="app-tag app-tag-skipped">
                          <SkipForward size={10} strokeWidth={1.5} />
                          <span>{t('rules.badge_skipped', { version: rule.skipped_version })}</span>
                        </span>
                      )}
                      {rule.is_frozen && (
                        <span className="app-tag app-tag-locked">
                          <Lock size={10} strokeWidth={1.5} />
                          <span>{t('rules.badge_frozen')}</span>
                        </span>
                      )}
                      {rule.is_hidden && (
                        <span className="app-tag app-tag-hidden">
                          <EyeOff size={10} strokeWidth={1.5} />
                          <span>{t('rules.badge_hidden')}</span>
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>
                      {t('rules.effective_at', { date: dateStr })}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {rule.skipped_version && (
                      <button
                        type="button"
                        className="btn-fluent btn-secondary"
                        style={{ fontSize: 'var(--font-xs)', padding: '4px 8px' }}
                        onClick={async () => {
                          await onClearRuleSkip(rule.app_id);
                          showNotice(t('rules.restore_notice_success', { id: rule.app_id }));
                        }}
                      >
                        {t('rules.restore_reminder')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: 'var(--font-xs)', padding: '4px 8px' }}
                      onClick={async () => {
                        await onToggleRuleFrozen(rule.app_id, !rule.is_frozen);
                        showNotice(rule.is_frozen ? t('rules.unlock_notice_success', { id: rule.app_id }) : t('rules.frozen_notice_success', { id: rule.app_id }));
                      }}
                    >
                      {rule.is_frozen ? t('rules.unlock_version') : t('rules.lock_version')}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: 'var(--font-xs)', padding: '4px 8px' }}
                      onClick={async () => {
                        await onToggleRuleHidden(rule.app_id, !rule.is_hidden);
                        showNotice(rule.is_hidden ? t('rules.unhide_notice_success', { id: rule.app_id }) : t('rules.hide_notice_success', { id: rule.app_id }));
                      }}
                    >
                      {rule.is_hidden ? t('rules.unhide_app') : t('rules.hide_app')}
                    </button>
                    <button
                      type="button"
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: 'var(--font-xs)', padding: '4px 8px', color: '#ef4444' }}
                      onClick={async () => {
                        await onRemoveRule(rule.app_id);
                        showNotice(t('rules.remove_notice_success', { id: rule.app_id }));
                      }}
                      title={t('rules.remove_rule_title')}
                    >
                      {t('rules.remove_rule_btn')}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 底部状态与操作栏 */}
        <div
          className="modal-footer"
          style={{
            padding: '12px 24px',
            background: 'var(--card-bg-subtle, rgba(0,0,0,0.15))',
          }}
        >
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: 'var(--font-sm)', padding: '6px 18px' }}
            onClick={onClose}
          >
            {t('rules.done')}
          </button>
        </div>
      </div>
    </div>
  );
};