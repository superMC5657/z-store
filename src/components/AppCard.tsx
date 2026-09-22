import React from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppSummary } from '../types';
import { AppIcon } from './AppIcon';
import { PlatformIcon, ForgeIcon } from './icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import { getAppDisplayName, getAppDescription, getCategoryLabel } from '../utils/appHelper';

interface AppCardProps {
  app: AppSummary;
  isInstalled: boolean;
  isInstalling?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
}

export const AppCard: React.FC<AppCardProps> = ({
  app,
  isInstalled,
  isInstalling = false,
  isFavorite = false,
  isWatched = false,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
}) => {
  const { t, i18n } = useTranslation();
  const displayName = getAppDisplayName(app);
  const displayDesc = getAppDescription(app, i18n.language);
  const displayCategory = getCategoryLabel(app.category, app.category_name, t);

  const formatStars = (count: number) => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  };

  return (
    <div
      className="app-card"
      onClick={() => onOpenDetail(app.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onOpenDetail(app.id);
        }
      }}
    >
      <div className="app-card-header">
        <AppIcon
          icon={app.icon}
          name={displayName}
          appId={app.id}
          iconBg={app.icon_bg}
          className="app-icon"
        />
        <div className="app-meta">
          <div className="app-title">
            <span className="app-name">{displayName}</span>
            {app.is_verified && (
              <span className="verified-badge" title={t('app.verified_badge')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="var(--brand-primary)" />
                  <path d="m9 12 2 2 4-4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
          <div className="app-owner">
            {app.owner} · {displayCategory}
          </div>
        </div>

        {onToggleWatch && (
          <button
            className={`btn-fav-card ${isWatched ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleWatch(app.id);
            }}
            title={isWatched ? t('app.watch_active') : t('app.watch_inactive')}
            aria-label={isWatched ? t('app.watch_active') : t('app.watch_inactive')}
            style={isWatched ? { color: 'var(--brand-primary)' } : undefined}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
        {onToggleFavorite && (
          <button
            className={`btn-fav-card ${isFavorite ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(app.id);
            }}
            title={isFavorite ? t('app.fav_active') : t('app.fav_inactive')}
            aria-label={isFavorite ? t('app.fav_active') : t('app.fav_inactive')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
      </div>

      <p className="app-desc" title={displayDesc}>{displayDesc}</p>

      <div className="app-card-footer">
        <div className="app-tags">
          <span className="app-tag app-tag-star">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{formatStars(app.stars)}</span>
          </span>
          {app.platforms && app.platforms.length > 0 && (
            <span
              className="app-tag app-tag-platforms"
              title={`${t('app.supported_devices', { defaultValue: '支持设备' })}: ${app.platforms.map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p).join(', ')}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 6px', cursor: 'default' }}
            >
              {app.platforms.map((p) => (
                <PlatformIcon key={p} platform={p} size={11} />
              ))}
            </span>
          )}
          {app.forge && app.forge !== 'github' && (
            <span
              className="app-tag"
              style={{
                background: 'var(--brand-subtle)',
                color: 'var(--brand-primary)',
                border: '1px solid var(--border-nav-active)',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title={`${t('app.code_source', { defaultValue: '代码源' })}: ${app.forge_host || app.forge}`}
            >
              <ForgeIcon forge={app.forge} size={12} />
              <span>{app.forge_host || app.forge}</span>
            </span>
          )}
        </div>

        <button
          className={`btn-install ${isInstalled ? 'btn-installed' : ''}`}
          disabled={isInstalling}
          onClick={(e) => {
            e.stopPropagation();
            if (isInstalled) {
              onOpenDetail(app.id);
            } else if (!isInstalling) {
              onQuickInstall(app.id);
            }
          }}
          title={
            isInstalling
              ? t('app.installing_app', { name: displayName })
              : isInstalled
                ? t('app.installed_details', { name: displayName })
                : t('app.get_app', { name: displayName })
          }
          aria-label={
            isInstalling
              ? t('app.installing_app', { name: displayName })
              : isInstalled
                ? t('app.installed_details', { name: displayName })
                : t('app.get_app', { name: displayName })
          }
          style={isInstalling ? { opacity: 0.8, cursor: 'not-allowed' } : undefined}
        >
          {isInstalling ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} />
              <span>{t('app.installing')}</span>
            </span>
          ) : isInstalled ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{t('app.installed')}</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{t('app.get')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
