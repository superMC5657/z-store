import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { AppSummary } from '../types';
import { AppIcon } from './AppIcon';
import { VerifiedBadge } from './VerifiedBadge';
import { PlatformIcon, ForgeIcon } from './icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import { getAppDisplayName, getAppDescription, getCategoryLabel } from '../utils/appHelper';
import { formatStars } from '../services/trends';

interface AppCardProps {
  app: AppSummary;
  isInstalled: boolean;
  isInstalling?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  /** 待确认态（summary 为空且详情尚未落定）：此时不渲染 Other 徽标，改以占位保持布局稳定。 */
  platformPending?: boolean;
  /** 趋势榜单名次（1-based）。不传则不渲染名次，精选页外观零变化。 */
  rank?: number;
  /** 名次颜色覆盖；默认按金银铜规则着色。 */
  rankColor?: string;
  /** 趋势榜涨星数（>0 才渲染徽标，缺失时不渲染，保持精选页零变化）。 */
  trendGain?: number;
  /** 已按当前语言格式化好的涨星文案，如“本周 +1.2k”。 */
  trendGainText?: string;
  className?: string;
  /** 首屏卡片传入 true（图标 eager），其余默认 lazy，避免全网格抢加载。 */
  eager?: boolean;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
}

/** 趋势名次配色：冠军金 / 亚军银 / 季军铜，其余为次级文本色。入参为 0-based index。 */
export function getRankBadgeColor(index: number): string {
  if (index === 0) return '#eab308';
  if (index === 1) return '#94a3b8';
  if (index === 2) return '#d97706';
  return 'var(--text-tertiary)';
}

function arePlatformsEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isAppVisualEqual(prev: AppSummary, next: AppSummary): boolean {
  if (prev === next) return true;
  return (
    prev.id === next.id &&
    prev.icon === next.icon &&
    prev.icon_bg === next.icon_bg &&
    prev.name === next.name &&
    prev.description === next.description &&
    prev.description_en === next.description_en &&
    prev.owner === next.owner &&
    prev.repo === next.repo &&
    prev.stars === next.stars &&
    prev.forks === next.forks &&
    prev.license === next.license &&
    prev.latest_version === next.latest_version &&
    prev.category === next.category &&
    prev.category_name === next.category_name &&
    prev.is_verified === next.is_verified &&
    prev.forge === next.forge &&
    prev.forge_host === next.forge_host &&
    prev.homepage === next.homepage &&
    arePlatformsEqual(prev.platforms, next.platforms)
  );
}

function areAppCardPropsEqual(prev: AppCardProps, next: AppCardProps): boolean {
  return (
    isAppVisualEqual(prev.app, next.app) &&
    prev.isInstalled === next.isInstalled &&
    (prev.isInstalling ?? false) === (next.isInstalling ?? false) &&
    (prev.isFavorite ?? false) === (next.isFavorite ?? false) &&
    (prev.isWatched ?? false) === (next.isWatched ?? false) &&
    (prev.platformPending ?? false) === (next.platformPending ?? false) &&
    prev.rank === next.rank &&
    prev.rankColor === next.rankColor &&
    prev.trendGain === next.trendGain &&
    prev.trendGainText === next.trendGainText &&
    prev.className === next.className &&
    (prev.eager ?? false) === (next.eager ?? false) &&
    prev.onOpenDetail === next.onOpenDetail &&
    prev.onQuickInstall === next.onQuickInstall &&
    prev.onToggleFavorite === next.onToggleFavorite &&
    prev.onToggleWatch === next.onToggleWatch
  );
}

export const AppCard: React.FC<AppCardProps> = memo(({
  app,
  isInstalled,
  isInstalling = false,
  isFavorite = false,
  isWatched = false,
  platformPending = false,
  rank,
  rankColor,
  trendGain,
  trendGainText,
  className,
  eager = false,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
}) => {
  const { t, i18n } = useTranslation();
  const displayName = getAppDisplayName(app);
  const displayDesc = getAppDescription(app, i18n.language);
  const displayCategory = getCategoryLabel(app.category, app.category_name, t);
  // 平台徽标三态：有平台展示 OS 图标；已确认 other 展示 Other 徽标；
  // 待确认（summary 为空且详情未落定）不展示 Other，改以同尺寸占位避免布局跳动。
  const hasPlatforms = !!app.platforms && app.platforms.length > 0;
  const showPendingPlaceholder = !hasPlatforms && platformPending;
  const showOther = !hasPlatforms && !platformPending;
  // 主按钮降级：平台为空（pending 待确认或已确认 Other）且未安装时，
  // 不承诺安装——统一为次级“查看详情”直开详情（避免安装后 toast 失败）。
  // 已安装行保持原样（已安装徽标直开详情）。
  const showDetailOnly = !isInstalled && !hasPlatforms;
  const detailLabel = t('app.view_details');
  const otherLabel = t('nav.platforms_other');
  const supportedDevicesLabel = t('app.supported_devices', { defaultValue: '支持设备' });

  return (
    <div
      className={className ? `app-card ${className}` : 'app-card'}
      onClick={() => onOpenDetail(app.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onOpenDetail(app.id);
        }
      }}
    >
      {rank !== undefined && (
        <div
          className="app-rank"
          style={{ color: rankColor ?? getRankBadgeColor(rank - 1) }}
          aria-label={`#${rank}`}
        >
          #{rank}
        </div>
      )}
      <div className="app-card-header">
        <AppIcon
          icon={app.icon}
          name={displayName}
          appId={app.id}
          iconBg={app.icon_bg}
          className="app-icon"
          loading={eager ? 'eager' : 'lazy'}
        />
        <div className="app-meta">
          <div className="app-title">
            <span className="app-name">{displayName}</span>
            {app.is_verified && <VerifiedBadge size="sm" />}
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? '#eab308' : 'none'} stroke={isFavorite ? '#eab308' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
          {typeof trendGain === 'number' && trendGain > 0 && trendGainText && (
            <span className="app-tag trend-gain" title={trendGainText}>
              {trendGainText}
            </span>
          )}
          {showPendingPlaceholder ? (
            <span
              className="app-tag app-tag-platforms app-tag-platforms-pending"
              title={supportedDevicesLabel}
              aria-label={supportedDevicesLabel}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 6px', cursor: 'default', opacity: 0.55, minWidth: '52px', justifyContent: 'center' }}
            >
              <span
                aria-hidden="true"
                style={{ width: '34px', height: '10px', borderRadius: '3px', background: 'var(--border-subtle)', display: 'inline-block' }}
              />
            </span>
          ) : (
            <span
              className="app-tag app-tag-platforms"
              title={hasPlatforms ? `${supportedDevicesLabel}: ${app.platforms!.map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p).join(', ')}` : `${supportedDevicesLabel}: ${otherLabel}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 6px', cursor: 'default' }}
            >
              {hasPlatforms ? (
                app.platforms!.map((p) => (
                  <PlatformIcon key={p} platform={p} size={11} />
                ))
              ) : showOther ? (
                <>
                  <PlatformIcon platform="other" size={11} />
                  <span>{otherLabel}</span>
                </>
              ) : null}
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
          disabled={showDetailOnly ? false : isInstalling}
          onClick={(e) => {
            e.stopPropagation();
            if (isInstalled || showDetailOnly) {
              onOpenDetail(app.id);
            } else if (!isInstalling) {
              onQuickInstall(app.id);
            }
          }}
          title={
            showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : isInstalled
                  ? t('app.installed_details', { name: displayName })
                  : t('app.get_app', { name: displayName })
          }
          aria-label={
            showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : isInstalled
                  ? t('app.installed_details', { name: displayName })
                  : t('app.get_app', { name: displayName })
          }
          style={!showDetailOnly && isInstalling ? { opacity: 0.8, cursor: 'not-allowed' } : undefined}
        >
          {showDetailOnly ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>{detailLabel}</span>
            </span>
          ) : isInstalling ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span className="spinner-icon" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} />
              <span>{t('app.installing')}</span>
            </span>
          ) : isInstalled ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{t('app.installed')}</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
}, areAppCardPropsEqual);
