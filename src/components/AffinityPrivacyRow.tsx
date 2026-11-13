import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, RefreshCw, Sparkles, Check, AlertTriangle, EyeOff, Monitor } from 'lucide-react';
import { GitHubIcon } from './icons/PlatformIcons';
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

type AffinitySource = 'local' | 'github';

const SOURCE_SETTING_KEY: Record<AffinitySource, string> = {
  local: 'enable_local_affinity',
  github: 'enable_github_affinity',
};

/** 信号源关闭时，其计数仍展示但淡化，表示不参与推荐。 */
const sourceTagStyle = (on: boolean): React.CSSProperties | undefined =>
  on ? undefined : { opacity: 0.5 };

export const AffinityPrivacyRow: React.FC = () => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AffinityProfileSummary>(EMPTY_SUMMARY);
  const [busyAction, setBusyAction] = useState<'toggle' | 'sync' | 'clear_feedback' | null>(null);
  const [confirmClearFeedback, setConfirmClearFeedback] = useState(false);
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

  // 旧后端只回 `enabled`：两个信号源随总开关。
  const localEnabled = summary.local_enabled ?? summary.enabled;
  const githubEnabled = summary.github_enabled ?? summary.enabled;

  const handleToggleSource = async (source: AffinitySource) => {
    if (busyAction !== null) return;
    const next = !(source === 'local' ? localEnabled : githubEnabled);
    setBusyAction('toggle');
    try {
      await tauriApi.saveSetting(SOURCE_SETTING_KEY[source], next ? 'true' : 'false');
      setSummary((prev) => {
        const local = source === 'local' ? next : prev.local_enabled ?? prev.enabled;
        const github = source === 'github' ? next : prev.github_enabled ?? prev.enabled;
        return { ...prev, local_enabled: local, github_enabled: github, enabled: local || github };
      });
      // 画像随开关重算：刷新偏好分类与语言。
      void loadSummary();
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      const toast =
        source === 'local'
          ? next
            ? t('affinity_privacy.local_on_toast')
            : t('affinity_privacy.local_off_toast')
          : next
            ? t('affinity_privacy.github_on_toast')
            : t('affinity_privacy.github_off_toast');
      showFeedback(toast, false);
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

  const optionalStats: { key: string; value: number | undefined; label: string; local: boolean }[] = [
    { key: 'installed', value: summary.installed_count, label: 'affinity_privacy.stat_installed', local: true },
    { key: 'viewed', value: summary.viewed_count, label: 'affinity_privacy.stat_viewed', local: true },
    { key: 'searches', value: summary.search_query_count, label: 'affinity_privacy.stat_searches', local: true },
    { key: 'feedback', value: summary.feedback_count, label: 'affinity_privacy.stat_feedback', local: false },
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
            aria-checked={localEnabled}
            data-testid="affinity-toggle-local-btn"
            title={t('affinity_privacy.local_source_hint')}
            className={`btn-fluent btn-compact ${localEnabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => void handleToggleSource('local')}
            disabled={busyAction !== null}
          >
            <Monitor size={13} strokeWidth={1.5} />
            <span>
              {localEnabled
                ? t('affinity_privacy.local_source_on')
                : t('affinity_privacy.local_source_off')}
            </span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={githubEnabled}
            data-testid="affinity-toggle-github-btn"
            title={t('affinity_privacy.github_source_hint')}
            className={`btn-fluent btn-compact ${githubEnabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => void handleToggleSource('github')}
            disabled={busyAction !== null}
          >
            <GitHubIcon size={13} />
            <span>
              {githubEnabled
                ? t('affinity_privacy.github_source_on')
                : t('affinity_privacy.github_source_off')}
            </span>
          </button>

          <button
            type="button"
            data-testid="affinity-sync-btn"
            className="btn-fluent btn-secondary btn-compact"
            title={githubEnabled ? undefined : t('affinity_privacy.sync_disabled_hint')}
            onClick={() => void handleSyncNow()}
            disabled={busyAction !== null || !githubEnabled}
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
        <span className="app-tag" data-source="github" style={sourceTagStyle(githubEnabled)}>
          {t('affinity_privacy.stat_starred', {
            count: summary.starred_repo_count,
          })}
        </span>
        <span className="app-tag" data-source="github" style={sourceTagStyle(githubEnabled)}>
          {t('affinity_privacy.stat_forked', {
            count: summary.forked_repo_count,
          })}
        </span>
        <span className="app-tag" data-source="github" style={sourceTagStyle(githubEnabled)}>
          {t('affinity_privacy.stat_owned', {
            count: summary.owned_repo_count,
          })}
        </span>
        <span className="app-tag" data-source="github" style={sourceTagStyle(githubEnabled)}>
          {t('affinity_privacy.last_synced', {
            time: formattedSyncTime,
          })}
        </span>
        <span className="app-tag" data-source="local" style={sourceTagStyle(localEnabled)}>
          {t('affinity_privacy.stat_favorites', {
            count: summary.favorites_count,
          })}
        </span>
        <span className="app-tag" data-source="local" style={sourceTagStyle(localEnabled)}>
          {t('affinity_privacy.stat_watched', {
            count: summary.watched_count,
          })}
        </span>
        {optionalStats.map((s) =>
          typeof s.value === 'number' ? (
            <span
              key={s.key}
              className="app-tag"
              data-testid={`affinity-stat-${s.key}`}
              data-source={s.local ? 'local' : undefined}
              style={s.local ? sourceTagStyle(localEnabled) : undefined}
            >
              {t(s.label as 'affinity_privacy.stat_installed', { count: s.value })}
            </span>
          ) : null,
        )}
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
