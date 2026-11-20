import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '../../i18n';
import { ArrowBigUp, ExternalLink, Inbox, MessageSquare, Share2 } from 'lucide-react';
import type { AppSummary, LaunchpadEntry } from '../../types';
import { AppIconFrame } from '../../components/AppIconFrame';
import { CachedAvatar } from '../../components/CachedAvatar';
import { VerifiedBadge, resolveVerifiedBadgeVariant } from '../../components/VerifiedBadge';
import { ForgeIcon, PlatformIcon } from '../../components/icons/PlatformIcons';
import { PLATFORM_META, type PlatformId } from '../../lib/platformFilter';
import { getAppDescription, getCategoryLabel, isAppCataloged } from '../../utils/appHelper';
import { formatStars, isPlaceholderDescription } from '../../services/trends';

export interface LaunchpadCardProps {
  entry: LaunchpadEntry;
  variant: 'spotlight' | 'recent';
  highlighted?: boolean;
  platformLoading: boolean;
  isInstalled: boolean;
  isManaged: boolean | null;
  isInstalling?: boolean;
  isStarring?: boolean;
  isUpvoting?: boolean;
  upvoted?: boolean;
  isMovingIn?: boolean;
  isCustomExisting?: boolean;
  /** 卡片主点击（讨论优先，无讨论回落详情）。 */
  onOpen: (entry: LaunchpadEntry) => void;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onOpenMaker: (entry: LaunchpadEntry) => void;
  onToggleStar: (entry: LaunchpadEntry) => void;
  onUpvote: (entry: LaunchpadEntry) => void;
  onOpenDiscussion: (entry: LaunchpadEntry) => void;
  onOpenSource: (entry: LaunchpadEntry) => void;
  onMoveInApp?: (app: AppSummary) => void;
  onShareBadge?: (entry: LaunchpadEntry) => void;
}

const DAY_MS = 86_400_000;

/** 广场上架相对时间（今天 / N 天前）。 */
export function launchedDaysAgo(launchedAt: string, nowMs: number = Date.now()): number | null {
  const t = Date.parse(launchedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

export function formatLaunchedLabel(launchedAt: string, t: TFunction): string {
  const days = launchedDaysAgo(launchedAt);
  if (days === null) return '';
  return days === 0 ? t('launchpad.launched_today') : t('launchpad.launched_days_ago', { count: days });
}

export interface LaunchpadStarButtonProps {
  starred: boolean;
  stars: number;
  disabled?: boolean;
  label: string;
  testId?: string;
  onClick: () => void;
}

export const LaunchpadStarButton: React.FC<LaunchpadStarButtonProps> = ({
  starred,
  stars,
  disabled = false,
  label,
  testId,
  onClick,
}) => (
  <button
    type="button"
    className={`btn-fluent btn-secondary btn-compact launchpad-action${starred ? ' starred' : ''}`}
    data-testid={testId}
    aria-pressed={starred}
    disabled={disabled}
    title={label}
    aria-label={label}
    onClick={onClick}
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={starred ? '#eab308' : 'none'}
      stroke={starred ? '#eab308' : 'currentColor'}
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
    <span>{formatStars(stars)}</span>
  </button>
);

/** 当前界面语言下的作者自荐语（英文界面优先非空 `maker_note_en`）。 */
export function makerNoteFor(entry: LaunchpadEntry, language: string | undefined): string {
  const en = entry.maker_note_en?.trim();
  if (en && (language ?? '').toLowerCase().startsWith('en')) return en;
  return entry.maker_note;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const normalizeText = (s: string) => s.replace(/\s+/g, '').replace(/[.。…!！]+$/u, '').toLowerCase();

/** 描述与自荐语同义（相同或互为包含）时只展示自荐语，避免卡片重复两遍同一句话。 */
export function isRedundantDescription(desc: string, note: string): boolean {
  const d = normalizeText(desc);
  const n = normalizeText(note);
  if (!d || !n) return false;
  return d === n || n.includes(d) || d.includes(n);
}

export const LaunchpadCard: React.FC<LaunchpadCardProps> = ({
  entry,
  variant,
  highlighted = false,
  platformLoading,
  isInstalled,
  isManaged,
  isInstalling = false,
  isStarring = false,
  isUpvoting = false,
  upvoted = false,
  isMovingIn = false,
  isCustomExisting = false,
  onOpen,
  onOpenDetail,
  onQuickInstall,
  onOpenMaker,
  onToggleStar,
  onUpvote,
  onOpenDiscussion,
  onOpenSource,
  onMoveInApp,
  onShareBadge,
}) => {
  const { t, i18n } = useTranslation();
  const app = entry.summary;
  const isGithub = (app.forge || 'github') === 'github';
  const note = makerNoteFor(entry, i18n.language);
  const desc = getAppDescription(app, i18n.language);
  const displayDesc =
    typeof desc === 'string' && desc.trim() && !isPlaceholderDescription(desc) ? desc : '';
  const launchedText = formatLaunchedLabel(entry.launched_at, t);
  const badgeVariant = resolveVerifiedBadgeVariant(app as { is_verified?: unknown; source?: unknown; status?: unknown });
  const hasPlatforms = app.platforms.length > 0;
  const showUnknown = isInstalled && isManaged === null;
  const showManaged = !showUnknown && isManaged === true;
  const showDetailOnly = !isInstalled && !hasPlatforms;
  const showMoveIn =
    Boolean(onMoveInApp) && !isAppCataloged(app) && badgeVariant === null && !isCustomExisting;
  const makerLogin = entry.maker.login || app.owner;
  const makerLabel = t('launchpad.maker_profile', { login: makerLogin });
  const supportedLabel = t('app.supported_devices');
  const starLabel = entry.viewer_has_starred ? t('launchpad.unstar') : t('launchpad.star');
  const upvoteLabel = upvoted ? t('launchpad.upvoted') : t('launchpad.upvote');
  const installLabel = showUnknown
    ? t('app.loading')
    : showDetailOnly
      ? t('app.view_details')
      : isInstalling
        ? t('app.installing_app', { name: app.name })
        : showManaged
          ? t('app.installed_details', { name: app.name })
          : t('app.get_app', { name: app.name });

  const classes = ['app-card', 'launchpad-card', `launchpad-card-${variant}`];
  if (highlighted) classes.push('launchpad-card-highlight');

  return (
    <div
      className={classes.join(' ')}
      data-testid={`launchpad-card-${app.id}`}
      data-launchpad-id={app.id.toLowerCase()}
      onClick={() => onOpen(entry)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(entry);
        }
      }}
    >
      <div className="app-card-header">
        <AppIconFrame size="md" icon={app.icon} name={app.name} appId={app.id} iconBg={app.icon_bg} />
        <div className="app-meta">
          <div className="app-title">
            <span className="app-name">{app.name}</span>
            {badgeVariant === 'verified' && <VerifiedBadge size="sm" variant="verified" />}
            {badgeVariant === 'local' && <VerifiedBadge size="sm" variant="local" />}
            {entry.is_pinned && <span className="status-tag">{t('launchpad.spotlight_tag')}</span>}
          </div>
          <div className="launchpad-maker">
            <button
              type="button"
              className="launchpad-maker-link"
              title={makerLabel}
              aria-label={makerLabel}
              onClick={(e) => {
                stop(e);
                onOpenMaker(entry);
              }}
              onKeyDown={stop}
            >
              <CachedAvatar src={entry.maker.avatar_url} login={makerLogin} size={18} />
              <span>@{makerLogin}</span>
            </button>
            {launchedText && <span className="launchpad-launched">· {launchedText}</span>}
            <span className="launchpad-category">· {getCategoryLabel(app.category, app.category_name, t)}</span>
          </div>
        </div>
      </div>

      {note && (
        <blockquote className="launchpad-maker-note" title={note}>
          {note}
        </blockquote>
      )}
      {displayDesc && !isRedundantDescription(displayDesc, note) && (
        <p className="app-desc" title={displayDesc}>{displayDesc}</p>
      )}

      <div className="app-card-footer launchpad-card-footer">
        <div className="app-tags">
          {platformLoading && !hasPlatforms ? (
            <span className="app-tag app-tag-platforms app-tag-platforms-loading" title={supportedLabel} aria-label={supportedLabel}>
              <span aria-hidden="true" className="launchpad-platform-skeleton" />
            </span>
          ) : (
            <span
              className="app-tag app-tag-platforms"
              title={`${supportedLabel}: ${
                hasPlatforms
                  ? app.platforms.map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p).join(', ')
                  : t('nav.platforms_other')
              }`}
            >
              {hasPlatforms
                ? app.platforms.map((p) => <PlatformIcon key={p} platform={p} size={11} />)
                : <PlatformIcon platform="other" size={11} />}
            </span>
          )}
          {app.latest_version && app.latest_version !== 'latest' && (
            <span className="app-tag">{app.latest_version}</span>
          )}
          {entry.stars_7d_delta > 0 && (
            <span className="app-tag trend-gain">
              {t('launchpad.stars_week', { count: entry.stars_7d_delta })}
            </span>
          )}
          {!isGithub && (
            <span className="app-tag" title={`${t('app.code_source')}: ${app.forge_host || app.forge}`}>
              <ForgeIcon forge={app.forge} size={12} />
              <span>{app.forge_host || app.forge}</span>
            </span>
          )}
        </div>

        <div className="launchpad-actions" onClick={stop} onKeyDown={stop}>
          <button
            type="button"
            className={`btn-fluent btn-secondary btn-compact launchpad-action${upvoted ? ' active' : ''}`}
            data-testid={`launchpad-upvote-${app.id}`}
            aria-pressed={upvoted}
            disabled={isUpvoting}
            title={upvoteLabel}
            aria-label={upvoteLabel}
            onClick={() => onUpvote(entry)}
          >
            <ArrowBigUp
              size={13}
              strokeWidth={1.5}
              fill={upvoted ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
            <span>{entry.discussion_upvotes}</span>
          </button>
          <button
            type="button"
            className="btn-fluent btn-secondary btn-compact launchpad-action"
            data-testid={`launchpad-discussion-${app.id}`}
            title={t('launchpad.discussion')}
            aria-label={t('launchpad.discussion')}
            onClick={() => onOpenDiscussion(entry)}
          >
            <MessageSquare size={13} strokeWidth={1.5} aria-hidden="true" />
            <span>{entry.discussion_comments_count}</span>
          </button>
          {isGithub ? (
            <LaunchpadStarButton
              starred={entry.viewer_has_starred}
              stars={app.stars}
              disabled={isStarring}
              label={starLabel}
              testId={`launchpad-star-${app.id}`}
              onClick={() => onToggleStar(entry)}
            />
          ) : (
            <>
              {app.stars > 0 && (
                <span className="app-tag app-tag-star" data-testid={`launchpad-stars-${app.id}`}>
                  <span>{formatStars(app.stars)}</span>
                </span>
              )}
              <button
                type="button"
                className="btn-fluent btn-secondary btn-compact btn-icon-only launchpad-action"
                data-testid={`launchpad-source-${app.id}`}
                title={t('launchpad.open_source')}
                aria-label={t('launchpad.open_source')}
                onClick={() => onOpenSource(entry)}
              >
                <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </>
          )}
          {showMoveIn && (
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact launchpad-action"
              data-testid={`move-in-${app.id}`}
              disabled={isMovingIn}
              title={t('custom.move_in_hint')}
              aria-label={isMovingIn ? t('custom.moving_in') : t('custom.move_in')}
              onClick={() => onMoveInApp?.(app)}
            >
              <Inbox size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
          {onShareBadge && (
            <button
              type="button"
              className="btn-fluent btn-secondary btn-compact btn-icon-only launchpad-action"
              data-testid={`launchpad-share-${app.id}`}
              title={t('launchpad.share_badge')}
              aria-label={t('launchpad.share_badge')}
              onClick={() => onShareBadge(entry)}
            >
              <Share2 size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={`btn-install ${showManaged ? 'btn-installed' : ''}`}
            data-badge={showUnknown ? 'unknown' : showManaged ? 'managed' : 'none'}
            disabled={showUnknown || (!showDetailOnly && isInstalling)}
            title={installLabel}
            aria-label={installLabel}
            onClick={() => {
              if (showUnknown) return;
              if (showDetailOnly || showManaged) onOpenDetail(app.id);
              else if (!isInstalling) onQuickInstall(app.id);
            }}
          >
            <span>
              {showUnknown
                ? t('app.loading')
                : showDetailOnly
                  ? t('app.view_details')
                  : isInstalling
                    ? t('app.installing')
                    : showManaged
                      ? t('app.installed')
                      : t('app.get')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
