import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { BellRing } from 'lucide-react';
import type { AppSummary, WatchUpdatedPayload } from '../../types';
import { CountBadge } from '../../components/CountBadge';
import { AppIconFrame } from '../../components/AppIconFrame';
import { resolveAppIconInfo } from '../../utils/appHelper';
import { queueAssembledRowIcons } from '../../services/iconStore';
import { buildCatalogLookup } from '../manage/manageModel';

interface WatchReleasesPanelProps {
  notifications: WatchUpdatedPayload[];
  /** 图标查表用的未过平台全集，避免平台筛选后提醒行丢图。 */
  apps: readonly AppSummary[];
  onOpenDetail?: (id: string) => void;
  /** 确认提醒：后端记下已确认版本，可在规则管理「关注已读」恢复。 */
  onDismiss?: (appId: string) => void;
}

/**
 * 关注应用的新版本提醒：收藏页「关注」签顶部的待处理列表，无提醒时不渲染。
 * 关注的应用不一定已安装，所以提醒放在关注列表旁，而不是「我的应用」。
 */
export const WatchReleasesPanel: React.FC<WatchReleasesPanelProps> = ({
  notifications,
  apps,
  onOpenDetail,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const catalogById = useMemo(() => buildCatalogLookup(apps), [apps]);

  useEffect(() => {
    if (notifications.length === 0) return;
    queueAssembledRowIcons(
      notifications.map((n) => ({
        id: n.app_id,
        icon: catalogById.get(n.app_id.toLowerCase())?.icon || '',
      })),
    );
  }, [notifications, catalogById]);

  if (notifications.length === 0) return null;

  return (
    <section className="manage-section watch-releases-panel" aria-label={t('favorites.watch_updates_title')}>
      <div className="manage-section-eyebrow">
        <span className="manage-section-eyebrow-title">
          <BellRing size={13} strokeWidth={1.5} aria-hidden="true" />
          <span>{t('favorites.watch_updates_title')}</span>
          <CountBadge value={notifications.length} />
        </span>
      </div>
      <div className="manage-panel">
        {notifications.map((n) => {
          const entry = catalogById.get(n.app_id.toLowerCase());
          const iconInfo = resolveAppIconInfo(n.app_id, [], entry?.icon, entry?.icon_bg);
          const displayName = n.app_name || n.app_id;
          return (
            <div key={n.app_id} className="manage-row">
              <div className="manage-row-main">
                <div className="manage-identity">
                  <AppIconFrame
                    size="sm"
                    icon={iconInfo.icon}
                    name={displayName}
                    appId={n.app_id}
                    iconBg={iconInfo.iconBg}
                    onClick={onOpenDetail ? () => onOpenDetail(n.app_id) : undefined}
                    title={onOpenDetail ? t('app.view_details') : undefined}
                  />
                  <div className="manage-identity-text">
                    <div className="manage-title-line">
                      <span
                        className={`manage-app-name ${onOpenDetail ? 'is-clickable' : ''}`.trim()}
                        onClick={() => onOpenDetail && onOpenDetail(n.app_id)}
                        title={onOpenDetail ? t('app.view_details') : undefined}
                      >
                        {displayName}
                      </span>
                      <span className="manage-version-chip is-target">{n.version}</span>
                    </div>
                    <div className="manage-meta-line">
                      <span>{t('favorites.watch_released', { name: displayName, version: n.version })}</span>
                    </div>
                  </div>
                </div>

                <div className="manage-row-actions">
                  {onOpenDetail && (
                    <button
                      type="button"
                      className="manage-btn-action"
                      onClick={() => onOpenDetail(n.app_id)}
                    >
                      {t('favorites.watch_view')}
                    </button>
                  )}
                  {onDismiss && (
                    <button
                      type="button"
                      className="btn-fluent btn-ghost btn-compact"
                      onClick={() => onDismiss(n.app_id)}
                    >
                      {t('favorites.dismiss_watch')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
