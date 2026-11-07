import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, RefreshCw, Trash2, Sparkles, Check, AlertTriangle } from 'lucide-react';
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
  const [busyAction, setBusyAction] = useState<'toggle' | 'sync' | 'reset' | null>(null);
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
          ? t('affinity_privacy.enabled_toast', { defaultValue: '已开启本地个性化推荐' })
          : t('affinity_privacy.disabled_toast', { defaultValue: '已切回默认星数基线排序' }),
        false,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg, defaultValue: '操作失败：{{error}}' }), true);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncNow = async () => {
    if (busyAction !== null) return;
    setBusyAction('sync');
    try {
      await tauriApi.syncGithubStarred();
      await loadSummary();
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      showFeedback(t('affinity_privacy.sync_ok', { defaultValue: '已完成 GitHub 画像增量同步' }), false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg, defaultValue: '操作失败：{{error}}' }), true);
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetProfile = async () => {
    if (busyAction !== null) return;
    setBusyAction('reset');
    try {
      await tauriApi.resetAffinityProfile();
      await loadSummary();
      window.dispatchEvent(new CustomEvent('zstore:affinity-updated'));
      showFeedback(t('affinity_privacy.reset_ok', { defaultValue: '已清空本地 GitHub 画像信号' }), false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(t('affinity_privacy.action_failed', { error: msg, defaultValue: '操作失败：{{error}}' }), true);
    } finally {
      setBusyAction(null);
    }
  };

  const formattedSyncTime = summary.last_synced_at
    ? new Date(summary.last_synced_at * 1000).toLocaleString()
    : t('affinity_privacy.never_synced', { defaultValue: '尚未同步' });

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
              {t('affinity_privacy.title', { defaultValue: '本地推荐画像与隐私数据看板' })}
            </span>
            <span
              className="setting-applied-badge"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--font-xs)' }}
            >
              <ShieldCheck size={14} strokeWidth={1.5} />
              <span>{t('affinity_privacy.local_badge', { defaultValue: '本地隐私闭环 · SQLite Only' })}</span>
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
            {t('affinity_privacy.desc', {
              defaultValue:
                '基于本地缓存的 GitHub Stars / Forks 与应用内收藏 / 关注信号在客户端重排精选推荐，零服务器上传。',
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            role="switch"
            aria-checked={summary.enabled}
            data-testid="affinity-toggle-btn"
            className={`btn-fluent ${summary.enabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => void handleToggleEnabled()}
            disabled={busyAction !== null}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Sparkles size={14} strokeWidth={1.5} />
            <span>
              {summary.enabled
                ? t('affinity_privacy.toggle_on', { defaultValue: '个性化推荐：已开启' })
                : t('affinity_privacy.toggle_off', { defaultValue: '个性化推荐：已关闭' })}
            </span>
          </button>

          <button
            type="button"
            data-testid="affinity-sync-btn"
            className="btn-fluent btn-secondary"
            onClick={() => void handleSyncNow()}
            disabled={busyAction !== null}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw
              size={14}
              strokeWidth={1.5}
              className={busyAction === 'sync' ? 'icon-spin' : undefined}
            />
            <span>
              {busyAction === 'sync'
                ? t('affinity_privacy.syncing', { defaultValue: '正在同步…' })
                : t('affinity_privacy.sync_btn', { defaultValue: '立即增量同步' })}
            </span>
          </button>

          <button
            type="button"
            data-testid="affinity-reset-btn"
            className="btn-fluent btn-secondary"
            onClick={() => void handleResetProfile()}
            disabled={busyAction !== null}
            style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
            <span>{t('affinity_privacy.reset_btn', { defaultValue: '清空本地画像' })}</span>
          </button>
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
            defaultValue: 'GitHub Stars: {{count}}',
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_forked', {
            count: summary.forked_repo_count,
            defaultValue: 'GitHub Forks: {{count}}',
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_owned', {
            count: summary.owned_repo_count,
            defaultValue: '自有仓库: {{count}}',
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_favorites', {
            count: summary.favorites_count,
            defaultValue: '应用内收藏: {{count}}',
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.stat_watched', {
            count: summary.watched_count,
            defaultValue: '版本关注: {{count}}',
          })}
        </span>
        <span className="app-tag">
          {t('affinity_privacy.last_synced', {
            time: formattedSyncTime,
            defaultValue: '最近同步: {{time}}',
          })}
        </span>
      </div>

      {(summary.top_categories.length > 0 || summary.top_languages.length > 0) && (
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
                defaultValue: '偏好分类: {{items}}',
              })}
            </span>
          )}
          {summary.top_languages.length > 0 && (
            <span>
              {t('affinity_privacy.top_languages', {
                items: summary.top_languages.join(' / '),
                defaultValue: '偏好语言: {{items}}',
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
