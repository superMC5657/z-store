import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, RefreshCw, Trash2, Sparkles, Check, AlertTriangle, EyeOff } from 'lucide-react';
import type { AffinityProfileSummary } from '../types';
import { tauriApi } from '../services/api';
import { subscribeAffinityUpdated } from '../services/feed';
import { getCategoryLabel } from '../utils/appHelper';
import { useTransientFeedback } from './useTransientFeedback';

const EMPTY_SUMMARY: AffinityProfileSummary = {
  enabled: true,
  starred_repo_count: 0,
  forked_repo_count: 0,
  owned_repo_count: 0,
  favorites_count: 0,
  watched_count: 0,
  top_categories: [],
  top_languages: [],
  last_synced_at: null,
};

export const AffinityPrivacyRow: React.FC = () => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AffinityProfileSummary>(EMPTY_SUMMARY);
  const [busyAction, setBusyAction] = useState<'toggle' | 'sync' | 'reset' | 'clear_feedback' | null>(null);
  const [confirmClearFeedback, setConfirmClearFeedback] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const { text: feedbackText, isError: feedbackError, show: showFeedback } = useTransientFeedback();

  const loadSummary = useCallback(async () => {
    try {
      const res = await tauriApi.getAffinityProfileSummary();
      if (res) setSummary(res);
    } catch {
      // keep fallback state when backend is unavailable
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    return subscribeAffinityUpdated(() => {
      void loadSummary();
    });
  }, [loadSummary]);

  const handleToggleEnabled = async () => {
    if (busyAction !== null) return;
    const nextEnabled = !summary.enabled;
    setBusyAction('toggle');
    try {
      await tauriApi.saveSetting('enable_local_affinity', nextEnabled ? 'true' : 'false');
      setSummary((prev) => ({ ...prev, enabled: nextEnabled }));
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      showFeedback(
        nextEnabled
          ? t('affinity_privacy.enabled_toast')
          : t('affinity_privacy.disabled_toast'),
        false,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg }), true);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncNow = async () => {
    if (busyAction !== null) return;
    setBusyAction('sync');
    try {
      await tauriApi.syncAffinitySignals();
      await loadSummary();
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      showFeedback(t('affinity_privacy.sync_ok'), false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg }), true);
    } finally {
      setBusyAction(null);
    }
  };

  // 一键清空本地画像需二次确认：确认态文案说明会一并清除兴趣方向与推荐反馈。
  const handleResetProfile = async () => {
    if (busyAction !== null) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setBusyAction('reset');
    try {
      await tauriApi.resetAffinityProfile();
      await loadSummary();
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      showFeedback(t('affinity_privacy.reset_ok'), false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg }), true);
    } finally {
      setBusyAction(null);
    }
  };

  // 清空推荐反馈需二次确认：第一次点击进入确认态，再点一次才执行。
  const handleClearFeedback = async () => {
    if (busyAction !== null) return;
    if (!confirmClearFeedback) {
      setConfirmClearFeedback(true);
      return;
    }
    setConfirmClearFeedback(false);
    setBusyAction('clear_feedback');
    try {
      const count = await tauriApi.clearFeedFeedback();
      await loadSummary();
      showFeedback(t('affinity_privacy.clear_feedback_ok', { count }), false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg }), true);
    } finally {
      setBusyAction(null);
    }
  };

  const optionalStats: { key: string; value: number | undefined; label: string }[] = [
    { key: 'installed', value: summary.installed_count, label: 'affinity_privacy.stat_installed' },
    { key: 'viewed', value: summary.viewed_count, label: 'affinity_privacy.stat_viewed' },
    { key: 'searches', value: summary.search_query_count, label: 'affinity_privacy.stat_searches' },
    { key: 'feedback', value: summary.feedback_count, label: 'affinity_privacy.stat_feedback' },
  ];
  const interestSeeds = summary.interest_seeds ?? [];

  const formattedSyncTime = summary.last_synced_at
    ? new Date(summary.last_synced_at * 1000).toLocaleString()
    : t('affinity_privacy.never_synced');

  return (
    <div
      className="settings-row"
      data-testid="affinity-privacy-row"
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <div className="settings-row-info" style={{ flex: 1, minWidth: '240px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Sparkles size={14} strokeWidth={1.5} />
            <span style={{ fontWeight: 510 }}>
              {t('affinity_privacy.title')}
            </span>
            <span
              className="setting-applied-badge"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--font-xs)' }}
            >
              <ShieldCheck size={14} strokeWidth={1.5} />
              <span>{t('affinity_privacy.local_badge')}</span>
            </span>
            {feedbackText && (
              <span
                className="setting-applied-badge"
                style={
                  feedbackError
                    ? { color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.35)' }
                    : undefined
                }
              >
                {!feedbackError ? (
                  <Check size={14} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                ) : (
                  <AlertTriangle size={14} strokeWidth={1.5} style={{ color: 'currentColor' }} />
                )}
                <span>{feedbackText}</span>
              </span>
            )}
          </div>
          <div className="settings-row-desc" style={{ marginTop: '4px' }}>
            {t('affinity_privacy.desc')}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            role="switch"
            aria-checked={summary.enabled}
            data-testid="affinity-toggle-btn"
            className={`btn-fluent btn-compact ${summary.enabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => void handleToggleEnabled()}
            disabled={busyAction !== null}
          >
            <Sparkles size={13} strokeWidth={1.5} />
            <span>
              {summary.enabled
                ? t('affinity_privacy.toggle_on')
                : t('affinity_privacy.toggle_off')}
            </span>
          </button>

          <button
            type="button"
            data-testid="affinity-sync-btn"
            className="btn-fluent btn-secondary btn-compact"
            onClick={() => void handleSyncNow()}
            disabled={busyAction !== null}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.5}
              className={busyAction === 'sync' ? 'icon-spin' : undefined}
            />
            <span>
              {busyAction === 'sync'
                ? t('affinity_privacy.syncing')
                : t('affinity_privacy.sync_btn')}
            </span>
          </button>

          <button
            type="button"
            data-testid="affinity-reset-btn"
            className="btn-fluent btn-secondary btn-compact"
            onClick={() => void handleResetProfile()}
            onBlur={() => setConfirmReset(false)}
            disabled={busyAction !== null}
          >
            <Trash2 size={13} strokeWidth={1.5} />
            <span>{confirmReset ? t('affinity_privacy.reset_confirm') : t('affinity_privacy.reset_btn')}</span>
          </button>

          {typeof summary.feedback_count === 'number' && summary.feedback_count > 0 && (
            <button
              type="button"
              data-testid="affinity-clear-feedback-btn"
              className="btn-fluent btn-secondary btn-compact"
              onClick={() => void handleClearFeedback()}
              onBlur={() => setConfirmClearFeedback(false)}
              disabled={busyAction !== null}
            >
              <EyeOff size={13} strokeWidth={1.5} />
              <span>
                {confirmClearFeedback
                  ? t('affinity_privacy.clear_feedback_confirm')
                  : t('affinity_privacy.clear_feedback_btn')}
              </span>
            </button>
          )}
        </div>
      </div>

      <div
        data-testid="affinity-privacy-stats"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          fontSize: 'var(--font-xs)',
          color: 'var(--text-secondary)',
        }}
      >
        <span className="app-tag">
          {t('affinity_privacy.stat_starred', {
            count: summary.starred_repo_count,
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_forked', {
            count: summary.forked_repo_count,
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_owned', {
            count: summary.owned_repo_count,
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_favorites', {
            count: summary.favorites_count,
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_watched', {
            count: summary.watched_count,
          })}
        </span>
        {optionalStats.map((s) =>
          typeof s.value === 'number' ? (
            <span key={s.key} className="app-tag" data-testid={`affinity-stat-${s.key}`}>
              {t(s.label as 'affinity_privacy.stat_installed', { count: s.value })}
            </span>
          ) : null,
        )}
        <span className="app-tag">
          {t('affinity_privacy.last_synced', {
            time: formattedSyncTime,
          })}
        </span>
      </div>

      {(summary.top_categories.length > 0 || summary.top_languages.length > 0 || interestSeeds.length > 0) && (
        <div
          data-testid="affinity-privacy-top-signals"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            fontSize: 'var(--font-xs)',
            color: 'var(--text-secondary)',
          }}
        >
          {summary.top_categories.length > 0 && (
            <span>
              {t('affinity_privacy.top_categories', {
                items: summary.top_categories
                  .map((c) => `${getCategoryLabel(c.category, c.category, t)} (${Math.round(c.weight * 100)}%)`)
                  .join(' · '),
              })}
            </span>
          )}
          {summary.top_languages.length > 0 && (
            <span>
              {t('affinity_privacy.top_languages', {
                items: summary.top_languages.join(' / '),
              })}
            </span>
          )}
          {interestSeeds.length > 0 && (
            <span data-testid="affinity-interest-seeds">
              {t('affinity_privacy.interest_seeds', {
                items: interestSeeds.map((c) => getCategoryLabel(c, c, t)).join(' · '),
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
