import React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Check, Shield } from 'lucide-react';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { ClientUpdateRow } from '../../../components/ClientUpdateRow';

export interface UpdatesRulesSectionProps {
  updateFrequency: string;
  watchNotifyFrequency: string;
  updateRulesCount: number;
  highlightRow: string | null;
  activeNotice: { key: string; text: string } | null;
  onSelectUpdateFrequency: (freq: string, label: string) => void;
  onSelectWatchFrequency: (freq: 'startup' | 'daily', label: string) => void;
  onOpenRules: () => void;
}

export const UpdatesRulesSection: React.FC<UpdatesRulesSectionProps> = ({
  updateFrequency,
  watchNotifyFrequency,
  updateRulesCount,
  highlightRow,
  activeNotice,
  onSelectUpdateFrequency,
  onSelectWatchFrequency,
  onOpenRules,
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-group">
      <div className="settings-group-title">
        <RefreshCw size={15} strokeWidth={1.5} />
        <span>{t('settings.updates_rules', { defaultValue: '更新与规则' })}</span>
      </div>
      <div className={`settings-row ${highlightRow === 'update_frequency' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.update_frequency')}</span>
            {activeNotice?.key === 'update_frequency' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={updateFrequency}
          onChange={(val) => {
            const opt = [
              { id: 'startup', label: t('settings.freq_startup') },
              { id: 'manual', label: t('settings.freq_manual') },
            ].find((u) => u.id === val);
            onSelectUpdateFrequency(val, opt?.label || val);
          }}
          options={[
            { value: 'startup', label: t('settings.freq_startup') },
            { value: 'manual', label: t('settings.freq_manual') },
          ]}
        />
      </div>

      <ClientUpdateRow />

      <div className={`settings-row ${highlightRow === 'watch_notify_frequency' ? 'row-highlight' : ''}`}>
        <div className="settings-row-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 510 }}>{t('settings.watch_notify_frequency')}</span>
            {activeNotice?.key === 'watch_notify_frequency' && (
              <span className="setting-applied-badge">
                <Check size={11} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                <span>{activeNotice.text}</span>
              </span>
            )}
          </div>
        </div>
        <SegmentedControl
          value={watchNotifyFrequency}
          onChange={(val) => {
            const opt = [
              { id: 'startup', label: t('settings.watch_startup') },
              { id: 'daily', label: t('settings.watch_daily') },
            ].find((o) => o.id === val);
            onSelectWatchFrequency(val as 'startup' | 'daily', opt?.label || val);
          }}
          options={[
            { value: 'startup', label: t('settings.watch_startup') },
            { value: 'daily', label: t('settings.watch_daily') },
          ]}
        />
      </div>

      <div className="settings-row" style={{ alignItems: 'center' }}>
        <div className="settings-row-info">
          <span style={{ fontWeight: 510 }}>{t('settings.rules_title')}</span>
        </div>
        <button
          type="button"
          className="btn-fluent btn-secondary"
          onClick={onOpenRules}
          style={{ fontSize: 'var(--font-sm)', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <Shield size={13} strokeWidth={1.5} />
          <span>{t('settings.rules_btn')}</span>
          {updateRulesCount > 0 && (
            <span
              style={{
                fontSize: 'var(--font-xs)',
                padding: '1px 7px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--brand-primary)',
                color: '#ffffff',
                fontWeight: 510,
              }}
            >
              {updateRulesCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
};
