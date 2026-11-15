import React, { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Inbox, Download, MoreHorizontal } from 'lucide-react';
import { AppSummary, FeedbackScope } from '../types';
import { AppIconFrame } from './AppIconFrame';
import { VerifiedBadge, resolveVerifiedBadgeVariant } from './VerifiedBadge';
import { PlatformIcon, ForgeIcon, WatchEyeIcon } from './icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../lib/platformFilter';
import { arePlatformsEqual, getAppDescription, getCategoryLabel, isAppCataloged } from '../utils/appHelper';
import { formatStars, isPlaceholderDescription } from '../services/trends';

interface AppCardProps {
  app: AppSummary;
  isInstalled: boolean;
  /**
   * 已纳管（绿色已安装）。三态：`true`/`false` = 已知，
   * `null` = managed 列表尚未加载（未知）：已安装命中时渲染中性占位。
   */
  isManaged: boolean | null;
  isInstalling?: boolean;
  isFavorite?: boolean;
  isWatched?: boolean;
  /** 加载中态（summary 为空且详情尚未落定）：此时不渲染 Other 徽标，改以占位保持布局稳定。 */
  platformLoading: boolean;
  /** 趋势榜涨星数（>0 才渲染徽标，缺席时不渲染）。 */
  trendGain?: number;
  /** 已按当前语言格式化好的涨星文案，如“本周 +1.2k”。 */
  trendGainText?: string;
  className?: string;
  /** 首屏卡片传入 true（图标 eager），其余默认 lazy，避免全网格抢加载。 */
  eager?: boolean;
  /** 收录时间徽标（最新入库视图传入 true）：透出收录日期。不传则不渲染。 */
  showAddedAtBadge?: boolean;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onToggleWatch?: (id: string) => void;
  /**
   * 移入收录入口（富卡内部操作区，与安装/详情同排）：
   * 仅当未收录 external 行（`!isAppCataloged(app)`，展示层唯一口径）且
   * 非 custom 草稿行、且 `isCustomExisting` 为假时渲染；缺席即不渲染。
   */
  onMoveInApp?: (app: AppSummary) => void;
  /** 移入进行中（该卡入口禁用态，防重复提交）。 */
  isMovingIn?: boolean;
  /** custom 草稿已存在（`selectMergedCatalogApps` 会命中 custom 行）——抑制入口防误点。 */
  isCustomExisting?: boolean;
  /**
   * 占位行手动加载入口（收藏页未收录空壳行）：
   * 调用方以 `isFavoritePlaceholderRow` 判定后传入 `showLoadDetail`，
   * 点击经 `onLoadDetail(app.id)` 拉取详情升级富卡；缺席即不渲染。
   */
  showLoadDetail?: boolean;
  onLoadDetail?: (id: string) => void;
  /** 推荐理由（精选页传入，已格式化）：描述下方一行次要文字，缺席不渲染。 */
  reasonText?: string;
  /** 推荐负反馈入口（精选页推荐区块传入）：「不感兴趣」与「少推这类」，缺席不渲染菜单。 */
  onDismiss?: (app: AppSummary, scope: FeedbackScope) => void;
}

/** 推荐负反馈菜单：键盘可达，Esc 或点击外部关闭。 */
const FeedbackMenu: React.FC<{
  app: AppSummary;
  categoryLabel: string;
  onDismiss: (app: AppSummary, scope: FeedbackScope) => void;
}> = ({ app, categoryLabel, onDismiss }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);
  const choose = (scope: FeedbackScope) => {
    setOpen(false);
    onDismiss(app, scope);
  };
  return (
    <span
      ref={rootRef}
      className="card-feedback"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="btn-fav-card"
        data-testid={`feedback-menu-${app.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('featured.feedback.menu')}
        aria-label={t('featured.feedback.menu')}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open && (
        <span className="card-feedback-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            data-testid={`dismiss-app-${app.id}`}
            onClick={() => choose('app')}
          >
            {t('featured.feedback.not_interested')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`dismiss-category-${app.id}`}
            onClick={() => choose('category')}
          >
            {t('featured.feedback.less_category', { category: categoryLabel })}
          </button>
        </span>
      )}
    </span>
  );
};

function isAppVisualEqual(prev: AppSummary, next: AppSummary): boolean {
  if (prev === next) return true;
  const prevCataloged = (prev as { is_cataloged?: unknown }).is_cataloged;
  const nextCataloged = (next as { is_cataloged?: unknown }).is_cataloged;
  const prevSource = (prev as { source?: unknown }).source;
  const nextSource = (next as { source?: unknown }).source;
  const prevStatus = (prev as { status?: unknown }).status;
  const nextStatus = (next as { status?: unknown }).status;
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
    prev.added_at === next.added_at &&
    prevCataloged === nextCataloged &&
    prevSource === nextSource &&
    prevStatus === nextStatus &&
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
    (prev.isInstalling ?? false) === (next.isInstalling ?? false) &&
    (prev.isFavorite ?? false) === (next.isFavorite ?? false) &&
    (prev.isWatched ?? false) === (next.isWatched ?? false) &&
    (prev.platformLoading) === (next.platformLoading) &&
    prev.trendGain === next.trendGain &&
    prev.trendGainText === next.trendGainText &&
    prev.className === next.className &&
    (prev.eager ?? false) === (next.eager ?? false) &&
    (prev.showAddedAtBadge ?? false) === (next.showAddedAtBadge ?? false) &&
    (prev.isMovingIn ?? false) === (next.isMovingIn ?? false) &&
    (prev.isCustomExisting ?? false) === (next.isCustomExisting ?? false) &&
    (prev.showLoadDetail ?? false) === (next.showLoadDetail ?? false) &&
    prev.reasonText === next.reasonText &&
    prev.onDismiss === next.onDismiss &&
    prev.onOpenDetail === next.onOpenDetail &&
    prev.onQuickInstall === next.onQuickInstall &&
    prev.onToggleFavorite === next.onToggleFavorite &&
    prev.onToggleWatch === next.onToggleWatch &&
    prev.onMoveInApp === next.onMoveInApp &&
    prev.onLoadDetail === next.onLoadDetail
  );
}

export const AppCard: React.FC<AppCardProps> = memo(({
  app,
  isInstalled,
  isManaged,
  isInstalling = false,
  isFavorite = false,
  isWatched = false,
  platformLoading,
  trendGain,
  trendGainText,
  className,
  eager = false,
  showAddedAtBadge = false,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
  onMoveInApp,
  isMovingIn = false,
  isCustomExisting = false,
  showLoadDetail = false,
  onLoadDetail,
  reasonText,
  onDismiss,
}) => {
  const { t, i18n } = useTranslation();
  // 已纳管绿已安装；未纳管走获取安装。
  // 三态：isManaged===null（managed 未加载）+ 已安装 = 未知，渲染中性占位；
  // 未命中即确定未安装（Get），无需占位。
  const managed = isManaged;
  const showUnknown = isInstalled && isManaged === null;
  const showManaged = !showUnknown && managed === true;
  const displayName = app.name;
  // 空或占位显示 trends.no_desc，中英任一有效即显示。
  const langDesc = getAppDescription(app, i18n.language);
  const isValidDesc = (v: unknown): v is string =>
    typeof v === 'string' && v.trim() !== '' && !isPlaceholderDescription(v);
  const displayDesc = isValidDesc(langDesc)
    ? langDesc
    : isValidDesc(app.description_en)
      ? app.description_en
      : isValidDesc(app.description)
        ? app.description
        : t('trends.no_desc');
  const displayCategory = getCategoryLabel(app.category, app.category_name, t);
  // 平台徽标三态：有平台展示 OS 图标；已确认 other 展示 Other 徽标；
  // 加载中（summary 为空且详情未落定）不展示 Other，改以同尺寸占位避免布局跳动。
  const hasPlatforms = !!app.platforms && app.platforms.length > 0;
  const showLoadingPlaceholder = !hasPlatforms && platformLoading;
  const showOther = !hasPlatforms && !platformLoading;
  // 主按钮降级：平台为空（loading 加载中或已确认 Other）且未安装时，
  // 不承诺安装——统一为次级“查看”直开详情（避免安装后 toast 失败）。
  // 已安装行保持原样（已安装徽标直开详情）。
  const showDetailOnly = !isInstalled && !hasPlatforms;
  const detailLabel = t('app.view_details');
  const otherLabel = t('nav.platforms_other');
  const supportedDevicesLabel = t('app.supported_devices');
  // 已认证蓝标优先，本地收录橘黄次之，其余无标（verified 蓝不动）。
  const badgeVariant = resolveVerifiedBadgeVariant(app as { is_verified?: unknown; source?: unknown; status?: unknown });
  // 自维护角标：source=custom 即本地草稿行；category external 原样保留，
  // 判定仅看 source，不改 isAppCataloged 口径。
  const isCustomRow = (app as { source?: unknown }).source === 'custom';
  const customBadgeLabel = t('app.custom_badge');
  // 移入收录入口门控：仅未收录且未认证/未本地收录的行生效；
  // 已收录 / 已认证蓝标 / 本地收录黄标 / custom 草稿行 / custom 已存在一律不渲染，避免误点。
  const showMoveIn =
    Boolean(onMoveInApp) &&
    !isAppCataloged(app) &&
    !isCustomRow &&
    badgeVariant === null &&
    !isCustomExisting;
  const moveInLabel = isMovingIn
    ? t('custom.moving_in')
    : t('custom.move_in');
  // 占位行手动加载：仅调用方显式传入 showLoadDetail 时渲染，点击拉详情升级富卡。
  const showLoadRow = showLoadDetail && typeof onLoadDetail === 'function';
  const loadDetailLabel = t('favorites.load_detail');

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
      <div className="app-card-header">
        <AppIconFrame
          size="md"
          icon={app.icon}
          name={displayName}
          appId={app.id}
          iconBg={app.icon_bg}
          loading={eager ? 'eager' : 'lazy'}
        />
        <div className="app-meta">
          <div className="app-title">
            <span className="app-name">{displayName}</span>
            {badgeVariant === 'verified' && <VerifiedBadge size="sm" variant="verified" />}
            {badgeVariant === 'local' && <VerifiedBadge size="sm" variant="local" />}
          </div>
          <div className="app-owner">
            {app.owner} · {displayCategory}
          </div>
        </div>

        {onToggleWatch ? (
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
            <WatchEyeIcon isWatched={isWatched} />
          </button>
        ) : (
          <span className="btn-fav-card btn-fav-placeholder" aria-hidden="true" />
        )}
        {onToggleFavorite ? (
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
        ) : (
          <span className="btn-fav-card btn-fav-placeholder" aria-hidden="true" />
        )}
      </div>

      <p className="app-desc" title={displayDesc}>{displayDesc}</p>
      {reasonText && (
        <p className="app-reason" title={reasonText} data-testid={`reason-${app.id}`}>
          {reasonText}
        </p>
      )}

      <div className="app-card-footer">
        <div className="app-tags">
          <span className="app-tag app-tag-star">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{formatStars(app.stars)}</span>
          </span>
          {showAddedAtBadge && app.added_at && (
            <span
              className="app-tag"
              title={t('latest.added_at_badge', { date: app.added_at })}
              style={{
                fontSize: '11px',
                color: 'var(--text-tertiary)',
              }}
            >
              <span>{t('latest.added_at_badge', { date: app.added_at })}</span>
            </span>
          )}
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
              title={`${t('app.code_source')}: ${app.forge_host || app.forge}`}
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
            className="btn-fluent btn-secondary btn-compact"
            disabled={isMovingIn}
            onClick={(e) => {
              e.stopPropagation();
              onMoveInApp?.(app);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={t('custom.move_in_hint')}
            aria-label={moveInLabel}
          >
            <Inbox size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{moveInLabel}</span>
          </button>
        )}
        {showLoadRow && (
          <button
            type="button"
            data-testid={`load-detail-${app.id}`}
            className="btn-fluent btn-secondary btn-compact"
            onClick={(e) => {
              e.stopPropagation();
              onLoadDetail?.(app.id);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={loadDetailLabel}
            aria-label={loadDetailLabel}
          >
            <Download size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{loadDetailLabel}</span>
          </button>
        )}
        <button
          className={`btn-install ${showManaged ? 'btn-installed' : ''}`}
          data-badge={showUnknown ? 'unknown' : showManaged ? 'managed' : 'none'}
          disabled={showUnknown ? true : showDetailOnly ? false : isInstalling}
          onClick={(e) => {
            e.stopPropagation();
            if (showUnknown) return;
            if (showDetailOnly) {
              onOpenDetail(app.id);
            } else if (showManaged) {
              onOpenDetail(app.id);
            } else if (!isInstalling) {
              onQuickInstall(app.id);
            }
          }}
          title={
            showUnknown
              ? t('app.loading')
              : showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : showManaged
                  ? t('app.installed_details', { name: displayName })
                  : t('app.get_app', { name: displayName })
          }
          aria-label={
            showUnknown
              ? t('app.loading')
              : showDetailOnly
              ? detailLabel
              : isInstalling
                ? t('app.installing_app', { name: displayName })
                : showManaged
                  ? t('app.installed_details', { name: displayName })
                  : t('app.get_app', { name: displayName })
          }
          style={
            !showDetailOnly && isInstalling
              ? { opacity: 0.8, cursor: 'not-allowed' }
              : undefined
          }
        >
          {/* 未知态中性占位（单色骨架，不可交互） */}
          {showUnknown ? (
            <span role="status" aria-label={t('app.loading')} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: 0.65, cursor: 'default' }}>
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
        {onDismiss && <FeedbackMenu app={app} categoryLabel={displayCategory} onDismiss={onDismiss} />}
      </div>
    </div>
  );
}, areAppCardPropsEqual);
