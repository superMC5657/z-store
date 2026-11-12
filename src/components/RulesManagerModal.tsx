import React, { useState } from 'react';
import { CountLabel } from './CountBadge';
import {
  Shield,
  Plus,
  ChevronUp,
  Lock,
  EyeOff,
  Eye,
  SkipForward,
  ShieldAlert,
  Search,
  X,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppSummary, InstalledApp, UpdateRule, WatchDismissedEntry } from '../types';
import { SegmentedControl } from './SegmentedControl';
import { EmptyState } from './EmptyState';
import { AppIconFrame } from './AppIconFrame';
import { resolveAppIconInfo, resolveInstalledAppName } from '../utils/appHelper';

interface RulesManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  updateRules: UpdateRule[];
  installedApps?: InstalledApp[];
  apps?: AppSummary[];
  onRemoveRule: (appId: string) => Promise<void>;
  onClearRuleSkip: (appId: string) => Promise<void>;
  onToggleRuleFrozen: (appId: string, isFrozen: boolean) => Promise<void>;
  onToggleRuleHidden: (appId: string, isHidden: boolean) => Promise<void>;
  onSkipVersion?: (appId: string, version: string) => Promise<void>;
  /** 已确认（「知道了」）的关注提醒，在「关注已读」签下列出，可恢复为待处理提醒。 */
  dismissedWatches?: WatchDismissedEntry[];
  onRestoreWatch?: (appId: string) => Promise<void>;
  onUnwatch?: (appId: string) => Promise<void>;
}

type RulesTab = 'all' | 'skipped' | 'frozen' | 'hidden' | 'watch';

interface NoticeState {
  text: string;
  isError: boolean;
}

export const RulesManagerModal: React.FC<RulesManagerModalProps> = ({
  isOpen,
  onClose,
  updateRules,
  installedApps = [],
  apps = [],
  onRemoveRule,
  onClearRuleSkip,
  onToggleRuleFrozen,
  onToggleRuleHidden,
  onSkipVersion,
  dismissedWatches = [],
  onRestoreWatch,
  onUnwatch,
}) => {
  const { t, i18n } = useTranslation();
  const [rulesTab, setRulesTab] = useState<RulesTab>('all');
  const [filterQuery, setFilterQuery] = useState('');

  // 新增规则表单状态
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [customAppId, setCustomAppId] = useState<string>('');
  const [ruleType, setRuleType] = useState<'frozen' | 'hidden' | 'skip'>('frozen');
  const [skipVersion, setSkipVersion] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!isOpen) return null;

  const showNotice = (msg: string, isError = false) => {
    const next = { text: msg, isError };
    setNotice(next);
    setTimeout(() => {
      setNotice((prev) => (prev === next ? null : prev));
    }, 3000);
  };

  const handleCreateRule = async () => {
    const finalAppId = (selectedAppId === '__custom__' || !selectedAppId ? customAppId : selectedAppId).trim();
    if (!finalAppId) {
      showNotice(t('rules.notice_select_app'), true);
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
          showNotice(t('rules.notice_input_skip_version'), true);
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
      showNotice(t('rules.notice_save_failed', { error: String(err) }), true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatRuleDate = (updatedAt: number) => {
    if (!updatedAt) return t('rules.recent_set');
    // 时间戳单位自适应：以 1e11（~1973年毫秒）区分秒级（~1.7e9）与毫秒级（~1.7e12）
    const ms = updatedAt > 1e11 ? updatedAt : updatedAt * 1000;
    return new Date(ms).toLocaleString(i18n.language || 'zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const resolveIdentity = (appId: string) => {
    const idNorm = appId.toLowerCase();
    const matchedApp = installedApps.find((a) => a.app_id.toLowerCase() === idNorm);
    const catalogApp = apps.find((a) => a.id.toLowerCase() === idNorm);
    const iconInfo = resolveAppIconInfo(catalogApp?.id || appId, apps, matchedApp?.icon, matchedApp?.icon_bg);
    const displayName = matchedApp
      ? resolveInstalledAppName(matchedApp, apps)
      : (catalogApp?.name || appId);
    return { iconInfo, displayName, showId: Boolean(matchedApp) || appId !== displayName };
  };

  const query = filterQuery.trim().toLowerCase();
  const matchesQuery = (appId: string, displayName: string) =>
    !query || appId.toLowerCase().includes(query) || displayName.toLowerCase().includes(query);

  const filteredRules = updateRules
    .map((rule) => ({ rule, ...resolveIdentity(rule.app_id) }))
    .filter(({ rule, displayName }) => {
      if (!matchesQuery(rule.app_id, displayName)) return false;
      if (rulesTab === 'watch') return false;
      if (rulesTab === 'skipped') return Boolean(rule.skipped_version);
      if (rulesTab === 'frozen') return rule.is_frozen;
      if (rulesTab === 'hidden') return rule.is_hidden;
      return true;
    });

  const filteredWatches = dismissedWatches
    .map((entry) => ({ entry, ...resolveIdentity(entry.app_id) }))
    .filter(({ entry, displayName }) =>
      (rulesTab === 'all' || rulesTab === 'watch') && matchesQuery(entry.app_id, displayName),
    );

  const totalCount = updateRules.length + dismissedWatches.length;

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
          maxWidth: '760px',
          height: 'min(640px, 86vh, calc(100% - 32px))',
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
                {t('rules.title')}
              </h3>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className={`btn-fluent btn-compact ${isAddOpen ? 'btn-secondary' : 'btn-primary'}`}
              onClick={() => setIsAddOpen(!isAddOpen)}
            >
              {isAddOpen ? (
                <>
                  <ChevronUp size={13} strokeWidth={1.5} />
                  <span>{t('rules.collapse_add')}</span>
                </>
              ) : (
                <>
                  <Plus size={13} strokeWidth={1.5} />
                  <span>{t('rules.add_rule')}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="modal-header-btn modal-close-btn"
              aria-label={t('rules.close_modal')}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

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
              // 窗口较矮时表单自身滚动，让出空间保住下方规则列表的最小高度
              flex: '0 1 auto',
              minHeight: 0,
              overflowY: 'auto',
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
                    className="select-fluent"
                    value={selectedAppId}
                    onChange={(e) => setSelectedAppId(e.target.value)}
                    style={{ flex: '1 1 240px', width: 'auto' }}
                  >
                    <option value="">{t('rules.form_select_installed', { count: installedApps.length })}</option>
                    {installedApps.map((a) => (
                      <option key={a.app_id} value={a.app_id}>
                        {a.app_name} (ID: {a.app_id} · v{a.version.replace(/^v/i, '')})
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
            onChange={(val) => setRulesTab(val as RulesTab)}
            size="compact"
            options={[
              {
                value: 'all',
                label: (
                  <CountLabel
                    label={t('rules.tab_all_short')}
                    count={totalCount}
                    active={rulesTab === 'all'}
                  />
                ),
              },
              {
                value: 'skipped',
                label: (
                  <CountLabel
                    icon={<SkipForward size={11} strokeWidth={1.5} />}
                    label={t('rules.tab_skipped_short')}
                    count={updateRules.filter((r) => Boolean(r.skipped_version)).length}
                    active={rulesTab === 'skipped'}
                  />
                ),
              },
              {
                value: 'frozen',
                label: (
                  <CountLabel
                    icon={<Lock size={11} strokeWidth={1.5} />}
                    label={t('rules.tab_frozen_short')}
                    count={updateRules.filter((r) => r.is_frozen).length}
                    active={rulesTab === 'frozen'}
                  />
                ),
              },
              {
                value: 'hidden',
                label: (
                  <CountLabel
                    icon={<EyeOff size={11} strokeWidth={1.5} />}
                    label={t('rules.tab_hidden_short')}
                    count={updateRules.filter((r) => r.is_hidden).length}
                    active={rulesTab === 'hidden'}
                  />
                ),
              },
              {
                value: 'watch',
                label: (
                  <CountLabel
                    icon={<Eye size={11} strokeWidth={1.5} />}
                    label={t('rules.tab_watch_short')}
                    count={dismissedWatches.length}
                    active={rulesTab === 'watch'}
                  />
                ),
              },
            ]}
          />

          <div className="fluent-input-search" style={{ width: '200px' }}>
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
            minHeight: '160px',
            overflowY: 'auto',
            padding: '16px 24px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {filteredRules.length === 0 && filteredWatches.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert size={40} strokeWidth={1.5} />}
              style={{ flex: 1 }}
              title={totalCount === 0 ? t('rules.empty_no_rules') : t('rules.empty_filtered')}
              action={
                totalCount === 0 && !isAddOpen ? (
                  <button
                    type="button"
                    className="btn-fluent btn-primary"
                    onClick={() => setIsAddOpen(true)}
                  >
                    <Plus size={14} strokeWidth={1.5} />
                    <span>{t('rules.add_first_rule')}</span>
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="fluent-list-container">
              {filteredRules.map(({ rule, iconInfo, displayName, showId }) => {
                const skipLabel = rule.skipped_version
                  ? t('rules.badge_skipped', { version: rule.skipped_version })
                  : '';
                return (
                  <div key={rule.app_id} className="fluent-list-row rules-row">
                    <AppIconFrame
                      icon={iconInfo.icon}
                      name={displayName}
                      appId={rule.app_id}
                      iconBg={iconInfo.iconBg}
                      size="md"
                    />
                    <div className="rules-row-info">
                      <div className="rules-row-title">
                        <span className="rules-row-name" title={displayName}>{displayName}</span>
                        {showId && (
                          <span className="rules-row-id text-mono" title={rule.app_id}>{rule.app_id}</span>
                        )}
                      </div>
                      <div className="rules-row-meta">
                        {rule.skipped_version && (
                          <span className="app-tag app-tag-skipped rules-row-tag" title={skipLabel}>
                            <SkipForward size={10} strokeWidth={1.5} />
                            <span>{skipLabel}</span>
                          </span>
                        )}
                        {rule.is_frozen && (
                          <span className="app-tag app-tag-locked rules-row-tag">
                            <Lock size={10} strokeWidth={1.5} />
                            <span>{t('rules.badge_frozen')}</span>
                          </span>
                        )}
                        {rule.is_hidden && (
                          <span className="app-tag app-tag-hidden rules-row-tag">
                            <EyeOff size={10} strokeWidth={1.5} />
                            <span>{t('rules.badge_hidden')}</span>
                          </span>
                        )}
                        <span className="rules-row-date">
                          {t('rules.effective_at', { date: formatRuleDate(rule.updated_at) })}
                        </span>
                      </div>
                    </div>

                    <div className="rules-row-actions">
                      {rule.skipped_version && (
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
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
                        className="btn-fluent btn-secondary btn-sm"
                        onClick={async () => {
                          await onToggleRuleFrozen(rule.app_id, !rule.is_frozen);
                          showNotice(rule.is_frozen ? t('rules.unlock_notice_success', { id: rule.app_id }) : t('rules.frozen_notice_success', { id: rule.app_id }));
                        }}
                      >
                        {rule.is_frozen ? t('rules.unlock_version') : t('rules.lock_version')}
                      </button>
                      <button
                        type="button"
                        className="btn-fluent btn-secondary btn-sm"
                        onClick={async () => {
                          await onToggleRuleHidden(rule.app_id, !rule.is_hidden);
                          showNotice(rule.is_hidden ? t('rules.unhide_notice_success', { id: rule.app_id }) : t('rules.hide_notice_success', { id: rule.app_id }));
                        }}
                      >
                        {rule.is_hidden ? t('rules.unhide_app') : t('rules.hide_app')}
                      </button>
                      <button
                        type="button"
                        className="btn-fluent btn-danger btn-sm btn-icon-only"
                        onClick={async () => {
                          await onRemoveRule(rule.app_id);
                          showNotice(t('rules.remove_notice_success', { id: rule.app_id }));
                        }}
                        title={t('rules.remove_rule_btn')}
                        aria-label={t('rules.remove_rule_btn')}
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {filteredWatches.map(({ entry, iconInfo, displayName, showId }) => {
                const readLabel = t('rules.badge_watch_read', { version: entry.version });
                return (
                  <div key={`watch:${entry.app_id}`} className="fluent-list-row rules-row">
                    <AppIconFrame
                      icon={iconInfo.icon}
                      name={displayName}
                      appId={entry.app_id}
                      iconBg={iconInfo.iconBg}
                      size="md"
                    />
                    <div className="rules-row-info">
                      <div className="rules-row-title">
                        <span className="rules-row-name" title={displayName}>{displayName}</span>
                        {showId && (
                          <span className="rules-row-id text-mono" title={entry.app_id}>{entry.app_id}</span>
                        )}
                      </div>
                      <div className="rules-row-meta">
                        <span className="app-tag app-tag-watch rules-row-tag" title={readLabel}>
                          <Eye size={10} strokeWidth={1.5} />
                          <span>{readLabel}</span>
                        </span>
                        <span className="rules-row-date">
                          {t('rules.dismissed_at', { date: formatRuleDate(entry.dismissed_at) })}
                        </span>
                      </div>
                    </div>

                    <div className="rules-row-actions">
                      {onRestoreWatch && (
                        <button
                          type="button"
                          className="btn-fluent btn-secondary btn-sm"
                          onClick={async () => {
                            try {
                              await onRestoreWatch(entry.app_id);
                              showNotice(t('rules.restore_watch_notice_success', { id: entry.app_id }));
                            } catch (err) {
                              showNotice(t('rules.notice_save_failed', { error: String(err) }), true);
                            }
                          }}
                        >
                          {t('rules.restore_reminder')}
                        </button>
                      )}
                      {onUnwatch && (
                        <button
                          type="button"
                          className="btn-fluent btn-danger btn-sm btn-icon-only"
                          onClick={async () => {
                            try {
                              await onUnwatch(entry.app_id);
                              showNotice(t('rules.unwatch_notice_success', { id: entry.app_id }));
                            } catch (err) {
                              showNotice(t('rules.notice_save_failed', { error: String(err) }), true);
                            }
                          }}
                          title={t('rules.unwatch_btn')}
                          aria-label={t('rules.unwatch_btn')}
                        >
                          <Trash2 size={13} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部状态与操作栏 */}
        <div
          className="modal-footer"
          style={{
            padding: '12px 24px',
            background: 'var(--card-bg-subtle, rgba(0,0,0,0.15))',
            justifyContent: 'space-between',
          }}
        >
          <span
            className={`rules-notice${notice ? (notice.isError ? ' is-error' : ' is-success') : ''}`}
            role="status"
            aria-live="polite"
          >
            {notice?.text}
          </span>
          <button
            type="button"
            className="btn-fluent btn-primary"
            onClick={onClose}
          >
            {t('rules.done')}
          </button>
        </div>
      </div>
    </div>
  );
};