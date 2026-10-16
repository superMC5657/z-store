import React, { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Inbox } from 'lucide-react';
import { AppSummary } from '../types';
import { AppIcon } from './AppIcon';
import { VerifiedBadge } from './VerifiedBadge';
import { PlatformIcon, ForgeIcon } from './icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import { getAppDescription, getCategoryLabel, isAppCataloged } from '../utils/appHelper';
import { formatStars } from '../services/trends/enrich';

interface AppCardProps {
  app: AppSummary;
  isInstalled: boolean;
  /**
   * 已纳管（绿色已安装）。三态：`true`/`false` = 已知，
   * `null` = managed 列表尚未加载（未知）：union 命中时渲染中性占位，永不闪灰（P1）。
   */
  isManaged: boolean | null;
  /**
   * 仅检测到未纳管（灰色检测到·点击纳管）。`null` = 未知态（由 isManaged===null 统一门控）。
   */
  isDetectedOnly?: boolean | null;
  isInstalling?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  /** 加载中态（summary 为空且详情尚未落定）：此时不渲染 Other 徽标，改以占位保持布局稳定。 */
  platformLoading: boolean;
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
  /**
   * 收录态徽标（收藏列表传入 true）：已收录走收录蓝 pill，未收录走弱化描边，
   * 定宽 48px 保持布局稳定。不传则不渲染，其它页面外观零变化。
   */
  showCatalogBadge?: boolean;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  /** 仅检测到时点击纳管（调 handleManageApp/importSingleApp）。缺席时回退为打开详情。 */
  onManageApp?: (id: string) => void | Promise<void>;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
  /**
   * 移入收录入口（富卡内部操作区，与安装/详情同排）：
   * 仅当未收录 external 行（`!isAppCataloged(app)`，沿用展示层唯一口径）且
   * 非 custom 草稿行、且 `isCustomExisting` 为假时渲染；缺席即不渲染，其它页面零变化。
   */
  onMoveInApp?: (app: AppSummary) => void;
  /** 移入进行中（该卡入口禁用态，防重复提交）。 */
  isMovingIn?: boolean;
  /** custom 草稿已存在（`selectMergedCatalogApps` 会命中 custom 行）——抑制入口防误点。 */
  isCustomExisting?: boolean;
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
  const prevSource = (prev as { source?: unknown }).source;
  const nextSource = (next as { source?: unknown }).source;
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
    prevSource === nextSource &&
    arePlatformsEqual(prev.platforms, next.platforms)
  );
}

function areAppCardPropsEqual(prev: AppCardProps, next: AppCardProps): boolean {
  // managed 三态比较：null（未知）与 boolean 严格区分，未知→已知必重渲染（消灭占位残留）。
  const managedKey = (v: boolean | null): string =>
    v === null ? 'unknown' : String(v);
  return (
    isAppVisualEqual(prev.app, next.app) &&
    prev.isInstalled === next.isInstalled &&
    managedKey(prev.isManaged) === managedKey(next.isManaged) &&
    (prev.isDetectedOnly ?? (prev.isInstalled && !prev.isManaged)) ===
      (next.isDetectedOnly ?? (next.isInstalled && !next.isManaged)) &&
    (prev.isInstalling ?? false) === (next.isInstalling ?? false) &&
    (prev.isFavorite ?? false) === (next.isFavorite ?? false) &&
    (prev.isWatched ?? false) === (next.isWatched ?? false) &&
    (prev.platformLoading) === (next.platformLoading) &&
    prev.rank === next.rank &&
    prev.rankColor === next.rankColor &&
    prev.trendGain === next.trendGain &&
    prev.trendGainText === next.trendGainText &&
    prev.className === next.className &&
    (prev.eager ?? false) === (next.eager ?? false) &&
    (prev.showCatalogBadge ?? false) === (next.showCatalogBadge ?? false) &&
    (prev.isMovingIn ?? false) === (next.isMovingIn ?? false) &&
    (prev.isCustomExisting ?? false) === (next.isCustomExisting ?? false) &&
    prev.onOpenDetail === next.onOpenDetail &&
    prev.onQuickInstall === next.onQuickInstall &&
    prev.onManageApp === next.onManageApp &&
    prev.onToggleFavorite === next.onToggleFavorite &&
    prev.onToggleWatch === next.onToggleWatch &&
    prev.onMoveInApp === next.onMoveInApp
  );
}

export const AppCard: React.FC<AppCardProps> = memo(({
  app,
  isInstalled,
  isManaged,
  isDetectedOnly,
  isInstalling = false,
  isFavorite = false,
  isWatched = false,
  platformLoading,
  rank,
  rankColor,
  trendGain,
  trendGainText,
  className,
  eager = false,
  showCatalogBadge = false,
  onOpenDetail,
  onQuickInstall,
  onManageApp,
  onToggleFavorite,
  onToggleWatch,
  onMoveInApp,
  isMovingIn = false,
  isCustomExisting = false,
}) => {
  const { t, i18n } = useTranslation();
  // P0 已纳管 vs 仅检测到：managed 绿已安装，detected 灰检测到·点击纳管。
  // P1 三态：isManaged===null（managed 未加载）+ union 命中 = 未知，渲染中性占位，永不闪灰；
  // union 未命中即确定未安装（Get），无需占位。
  const managed = isManaged;
  const detectedOnly = isDetectedOnly ?? (isInstalled && !managed);
  const showUnknown = isInstalled && isManaged === null;
  const showManaged = !showUnknown && managed && !detectedOnly;
  const showDetected = !showUnknown && detectedOnly && !managed;
  const [isManaging, setIsManaging] = useState(false);
  const displayName = app.name;
  const displayDesc = getAppDescription(app, i18n.language);
  const displayCategory = getCategoryLabel(app.category, app.category_name, t);
  // 平台徽标三态：有平台展示 OS 图标；已确认 other 展示 Other 徽标；
  // 加载中（summary 为空且详情未落定）不展示 Other，改以同尺寸占位避免布局跳动。
  const hasPlatforms = !!app.platforms && app.platforms.length > 0;
  const showLoadingPlaceholder = !hasPlatforms && platformLoading;
  const showOther = !hasPlatforms && !platformLoading;
  // 主按钮降级：平台为空（loading 加载中或已确认 Other）且未安装时，
  // 不承诺安装——统一为次级“查看详情”直开详情（避免安装后 toast 失败）。
  // 已安装行保持原样（已安装徽标直开详情）。
  const showDetailOnly = !isInstalled && !hasPlatforms;
  const detailLabel = t('app.view_details');
  const otherLabel = t('nav.platforms_other');
  const supportedDevicesLabel = t('app.supported_devices', { defaultValue: '支持设备' });
  // Lane C 自维护角标：source=custom 即本地草稿 overlay 行；category external 原样保留，
  // 判定仅看 source，不改 isAppCataloged 口径。
  const isCustomRow = (app as { source?: unknown }).source === 'custom';
  const customBadgeLabel = t('app.custom_badge', { defaultValue: '自维护' });
  // 移入收录入口门控：仅未收录 external 行（isAppCataloged 唯一口径）生效；
  // 已收录 / 已转正（远端行）/ custom 草稿行 / custom 已存在一律不渲染，避免误点。
  const showMoveIn = Boolean(onMoveInApp) && !isAppCataloged(app) && !isCustomRow && !isCustomExisting;
  const moveInLabel = isMovingIn
    ? t('custom.moving_in', { defaultValue: '移入中…' })
    : t('custom.move_in', { defaultValue: '移入收录' });

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
          {showCatalogBadge &&
            (isAppCataloged(app) ? (
              <span
                className="app-tag app-tag-cataloged"
                title={t('app.verified_badge')}
                aria-label={t('app.cataloged_badge')}
              >
                <span>{t('app.cataloged_badge')}</span>
              </span>
            ) : (
              <span
                className="app-tag app-tag-uncataloged"
                title={t('app.uncataloged_badge')}
                aria-label={t('app.uncataloged_badge')}
              >
                <span>{t('app.uncataloged_badge')}</span>
              </span>
            ))}
          {isCustomRow && (
            <span
              className="app-tag app-tag-custom"
              title={customBadgeLabel}
              aria-label={customBadgeLabel}
              style={{
                border: '1px dashed var(--border-nav-active)',
                color: 'var(--brand-primary)',
                fontWeight: 600,
              }}
            >
              <span>{customBadgeLabel}</span>
            </span>
          )}
          {typeof trendGain === 'number' && trendGain > 0 && trendGainText && (
            <span className="app-tag trend-gain" title={trendGainText}>
              {trendGainText}
            </span>
          )}
          {showLoadingPlaceholder ? (
            <span
              className="app-tag app-tag-platforms app-tag-platforms-loading"
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
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 6px', cursor: 'default', minWidth: '52px', justifyContent: 'center' }}
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

        {showMoveIn && (
          <button
            type="button"
            data-testid={`move-in-${app.id}`}
            className="btn-fluent btn-secondary"
            disabled={isMovingIn}
            onClick={(e) => {
              e.stopPropagation();
              onMoveInApp?.(app);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={t('custom.move_in_hint', { defaultValue: '存为本地自维护草稿，编辑页可手改' })}
            aria-label={moveInLabel}
            style={{ padding: '6px 10px', fontSize: 'var(--font-xs)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <Inbox size={12} strokeWidth={1.5} aria-hidden="true" />
            <span>{moveInLabel}</span>
          </button>
        )}
        <button
          className={`btn-install ${showManaged ? 'btn-installed' : ''}`}
          data-badge={showUnknown ? 'unknown' : showManaged ? 'managed' : showDetected ? 'detected' : 'none'}
          disabled={showUnknown ? true : showDetailOnly ? false : (isInstalling || isManaging)}
          onClick={(e) => {
            e.stopPropagation();
            if (showUnknown) return;
            if (showDetailOnly) {
              onOpenDetail(app.id);
            } else if (showDetected) {
              // 仅检测到：点击纳管（调 handleManageApp/importSingleApp），无回调时回退详情
              if (onManageApp) {
                if (isManaging) return;
                setIsManaging(true);
                Promise.resolve(onManageApp(app.id)).catch(() => undefined).finally(() => setIsManaging(false));
              } else {
                onOpenDetail(app.id);
              }
            } else if (showManaged) {
              onOpenDetail(app.id);
            } else if (!isInstalling) {
              onQuickInstall(app.id);
            }
          }}
          title={
            showUnknown
              ? t('app.loading', { defaultValue: '加载中' })
              : showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : showDetected
                  ? t('app.detected_manage_tip', { defaultValue: '检测到本地安装，点击纳入管理', name: displayName })
                  : showManaged
                    ? t('app.installed_details', { name: displayName })
                    : t('app.get_app', { name: displayName })
          }
          aria-label={
            showUnknown
              ? t('app.loading', { defaultValue: '加载中' })
              : showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : showDetected
                  ? t('app.detected_manage_tip', { defaultValue: '检测到本地安装，点击纳入管理', name: displayName })
                  : showManaged
                    ? t('app.installed_details', { name: displayName })
                    : t('app.get_app', { name: displayName })
          }
          style={
            showDetected
              ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' }
              : !showDetailOnly && isInstalling
                ? { opacity: 0.8, cursor: 'not-allowed' }
                : undefined
          }
        >
          {/* P1 未知态中性占位（单色骨架，不可交互）：managed 未加载前永不闪灰 */}
          {showUnknown ? (
            <span role="status" aria-label={t('app.loading', { defaultValue: '加载中' })} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: 0.65, cursor: 'default' }}>
              <span
                aria-hidden="true"
                className="skeleton-box"
                style={{ width: '46px', height: '10px', borderRadius: '3px', display: 'inline-block' }}
              />
            </span>
          ) : showDetailOnly ? (
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
          ) : showDetected ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              <span>{isManaging ? t('app.managing', { defaultValue: '纳管中...' }) : t('app.detected_manage', { defaultValue: '检测到·点击纳管' })}</span>
            </>
          ) : showManaged ? (
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
