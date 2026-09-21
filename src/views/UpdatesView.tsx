import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { marked } from 'marked';
import {
  RotateCcw,
  Shield,
  Search,
  BellOff,
  SkipForward,
  Lock,
  EyeOff,
  CheckCircle2,
  Eye,
  DownloadCloud,
} from 'lucide-react';
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
  const { t } = useTranslation();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const [localChecking, setLocalChecking] = useState(false);
  const isChecking = propIsChecking !== undefined ? propIsChecking : localChecking;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());

  const resolveIconInfo = (appId: string, iconOverride?: string, iconBgOverride?: string) =>
    resolveAppIconInfo(appId, apps, iconOverride, iconBgOverride);

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
          <h3 className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <RotateCcw size={18} style={{ color: 'var(--brand-primary)' }} />
            <span>{t('updates.title', { count: updates.length })}</span>
          </h3>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-tertiary)' }}>
            {t('updates.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {onOpenRules && (
            <button
              className="btn-fluent btn-secondary"
              onClick={onOpenRules}
              style={{ fontSize: '13px', padding: '6px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              title={t('updates.rules_tooltip')}
            >
              <Shield size={13} />
              <span>{t('updates.rules_btn')} {typeof updateRulesCount === 'number' && updateRulesCount > 0 ? `(${updateRulesCount})` : ''}</span>
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
              title={t('updates.check_tooltip')}
            >
              {isChecking ? (
                <>
                  <RotateCcw size={13} className="icon-spin" />
                  <span>{t('updates.checking')}</span>
                </>
              ) : (
                <>
                  <Search size={13} />
                  <span>{t('updates.check_updates')}</span>
                </>
              )}
            </button>
          )}
          {updates.length > 0 && (
            <button
              className="btn-fluent btn-primary"
              onClick={handleUpdateAll}
              disabled={isUpdatingAll || isChecking}
              style={{ fontWeight: 600, fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <DownloadCloud size={14} />
              <span>{isUpdatingAll ? t('updates.updating_all') : t('updates.update_all', { count: updates.length })}</span>
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
              <strong>{t('updates.progress_title')}</strong>
              {checkProgress && checkProgress.total > 0 ? (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {' '}{t('updates.progress_checked', {
                    checked: checkProgress.checked,
                    total: checkProgress.total,
                    current: checkProgress.app_name ? t('updates.progress_comparing', { name: checkProgress.app_name }) : '',
                  })}
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>{t('updates.progress_hint')}</span>
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
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--brand-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Eye size={14} />
            <span>{t('updates.watch_updates_title', { count: watchNotifications.length })}</span>
          </span>
          {watchNotifications.map((n) => {
            const iconInfo = resolveIconInfo(n.app_id);
            return (
              <div
                key={n.app_id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', fontSize: '13px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{ cursor: onOpenWatchedApp ? 'pointer' : 'default', flexShrink: 0 }}
                    onClick={() => onOpenWatchedApp && onOpenWatchedApp(n.app_id)}
                    title={onOpenWatchedApp ? t('app.view_details') : undefined}
                  >
                    <AppIcon
                      icon={iconInfo.icon}
                      name={n.app_name || n.app_id}
                      appId={n.app_id}
                      iconBg={iconInfo.iconBg}
                      size={26}
                      style={{ width: '26px', height: '26px', borderRadius: '7px' }}
                    />
                  </div>
                  <span>
                    {t('updates.watch_released', { name: n.app_name || n.app_id, version: n.version })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {onOpenWatchedApp && (
                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      onClick={() => onOpenWatchedApp(n.app_id)}
                    >
                      {t('updates.view_details')}
                    </button>
                  )}
                  {onDismissWatch && (
                    <button
                      className="btn-fluent btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 12px' }}
                      onClick={() => onDismissWatch(n.app_id)}
                    >
                      {t('updates.dismiss_watch')}
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
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{t('updates.stream_checking_title')}</h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              {t('updates.stream_checking_desc')}
            </p>
          </div>
        ) : (
          <div className="empty-state-card">
            <CheckCircle2 size={44} strokeWidth={1.5} style={{ color: 'var(--status-success)', margin: '0 auto 12px' }} />
            <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{t('updates.all_latest_title')}</h4>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', margin: 0 }}>
              {t('updates.all_latest_desc')}
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
            const iconInfo = resolveIconInfo(item.app_id, item.icon, item.icon_bg);

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
                      title={onOpenWatchedApp ? t('app.view_details') : undefined}
                    >
                      <AppIcon
                        icon={iconInfo.icon}
                        name={item.app_name}
                        appId={item.app_id}
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
                        title={onOpenWatchedApp ? t('app.view_details') : undefined}
                      >
                        {item.app_name}
                      </h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>{t('updates.current_version', { version: item.current_version })}</span>
                        <span>➔</span>
                        <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>
                          {t('updates.latest_version', { version: item.latest_version })}
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
                      {isExpanded ? t('updates.collapse_changelog') : t('updates.view_changelog')}
                    </button>

                    <button
                      className="btn-fluent btn-primary"
                      style={{ fontSize: '13px', padding: '6px 16px', fontWeight: 600 }}
                      disabled={isThisUpdating || isUpdatingAll}
                      onClick={() => handleUpdate(item.app_id)}
                    >
                      {isThisUpdating ? t('updates.updating') : t('updates.update_now')}
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
                        title={t('updates.more_rules_tooltip')}
                        aria-label={t('installed.more_options')}
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
                            <BellOff size={14} style={{ color: 'var(--text-secondary)' }} />
                            <div>
                              <div style={{ fontWeight: 600 }}>{t('updates.ignore_once')}</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                {t('updates.ignore_once_desc')}
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
                            <SkipForward size={14} style={{ color: 'var(--brand-primary)' }} />
                            <div>
                              <div style={{ fontWeight: 600 }}>{t('updates.skip_version')}</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                {t('updates.skip_version_desc', { version: item.latest_version })}
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
                            <Lock size={14} style={{ color: '#60a5fa' }} />
                            <div>
                              <div style={{ fontWeight: 600 }}>{t('updates.lock_version')}</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                                {t('updates.lock_version_desc', { version: item.current_version })}
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
                            <EyeOff size={14} style={{ color: '#f87171' }} />
                            <div>
                              <div style={{ fontWeight: 600 }}>{t('updates.hide_app')}</div>
                              <div style={{ fontSize: '10.5px', opacity: 0.85 }}>
                                {t('updates.hide_app_desc')}
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

