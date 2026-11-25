import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Compass,
  Eye,
  LayoutGrid,
  Lock,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { AppCard } from '../components/AppCard';
import { AppIcon } from '../components/AppIcon';
import { EmptyState } from '../components/EmptyState';
import { VerifiedBadge, resolveVerifiedBadgeVariant } from '../components/VerifiedBadge';
import type { AppSummary, FeaturedPick, FeaturedShelf, FeedbackScope } from '../types';
import { EMPTY_IDS, FilterEmptyState, ViewAppActions, ViewShell, noopAction, resolvePlatformReset } from './ViewShell';
import { useAppContextProps } from '../app/AppContext';
import { isPlatformLoading } from '../lib/platformFilter';
import { isInstalled as selectIsInstalled, selectManagedState } from '../app/selectors';
import { normalizeId } from '../services/normalizeId';
import { tauriApi } from '../services/api';
import { visitSeed } from '../services/visitSeed';
import { notifyToast } from '../useToasts';
import { getAppDescription } from '../utils/appHelper';
import { isPlaceholderDescription } from '../services/trends';
import { useRowAnnotator, useRowIconBackfill } from './shared/useRowAnnotations';
import { useFeaturedPage } from './FeaturedView/useFeaturedPage';
import { InterestPicker } from './FeaturedView/InterestPicker';
import { categoryName, formatReasons, seedDisplayName, seedPhrase } from './FeaturedView/reasons';

/** 「最近浏览 / 继续查看」区块最多展示的卡片数量。 */
const RECENT_SECTION_MAX = 8;

// 会话内记住用户关掉的提示（不落库：下次启动再出现一次）。
let interestPickerSkipped = false;
let affinityOffHintClosed = false;

interface FeaturedViewProps extends ViewAppActions {
  recentlyViewedApps?: AppSummary[];
  onClearRecentViews?: () => void;
  onOpenCategory: (category: string) => void;
  onNavigateLatest: () => void;
  /** 打开设置页隐私看板（`#settings-affinity`）。 */
  onOpenAffinitySettings: () => void;
}

export const FeaturedView: React.FC<FeaturedViewProps> = (props) => {
  const {
    apps,
    platformResolvedOtherIds = EMPTY_IDS,
    installedIds = EMPTY_IDS,
    installingIds,
    favoriteIds = EMPTY_IDS,
    managedIds = null,
    watchedIds,
    recentlyViewedApps = [],
    onOpenDetail = noopAction,
    onQuickInstall = noopAction,
    onToggleFavorite = noopAction,
    onToggleWatch,
    onClearRecentViews,
    onResetPlatformFilter,
    localApps,
    onOpenCategory,
    onNavigateLatest,
    onOpenAffinitySettings,
  } = useAppContextProps(props);
  const { t, i18n } = useTranslation();
  const seed = useMemo(() => visitSeed(), []);
  const allowedIds = useMemo(() => apps.map((a) => a.id), [apps]);
  const { page, loading, failed, reload, dismissedIds, dismiss } = useFeaturedPage(allowedIds, seed);
  const annotate = useRowAnnotator(apps, localApps);

  const appById = useMemo(() => {
    const m = new Map<string, AppSummary>();
    for (const a of apps) {
      const k = a.id.toLowerCase();
      if (!m.has(k)) m.set(k, a);
    }
    return m;
  }, [apps]);

  const state = page?.profile_state ?? 'off';
  const personalized = state === 'warm' || state === 'rich';

  // 推荐行以合并目录中的同 id 行为准（图标、星数、平台随目录补齐），再叠加收录标记。
  const toRow = useCallback(
    (pick: FeaturedPick): AppSummary => annotate(appById.get(pick.app.id.toLowerCase()) ?? pick.app),
    [annotate, appById],
  );
  const visible = useCallback(
    (pick: FeaturedPick) => !dismissedIds.has(pick.app.id.toLowerCase()),
    [dismissedIds],
  );

  const [pickerHidden, setPickerHidden] = useState(interestPickerSkipped);
  // 冷启动时兴趣选择卡占 hero 位；跳过后 hero 回到该位置。
  const showPicker = state === 'cold' && !pickerHidden;

  // hero 位置固定：大卡与小卡各自就地移除，不互相补位。
  const heroSlots = useMemo(() => (showPicker ? [] : (page?.hero ?? [])), [showPicker, page]);
  const mainHero = heroSlots[0] && visible(heroSlots[0]) ? heroSlots[0] : undefined;
  const sideHero = useMemo(() => heroSlots.slice(1).filter(visible), [heroSlots, visible]);
  const hero = useMemo(() => (mainHero ? [mainHero, ...sideHero] : sideHero), [mainHero, sideHero]);
  const shelves = useMemo(
    () =>
      (page?.shelves ?? [])
        .map((s) => ({ ...s, items: s.items.filter(visible) }))
        .filter((s) => s.items.length > 0),
    [page, visible],
  );
  const recentRows = useMemo(
    () =>
      recentlyViewedApps
        .slice(0, RECENT_SECTION_MAX)
        .map((r) => annotate(appById.get(r.id.toLowerCase()) ?? r)),
    [recentlyViewedApps, appById, annotate],
  );

  const iconRows = useMemo(
    () => [
      ...hero.map(toRow),
      ...shelves.flatMap((s) => s.items.map(toRow)),
      ...recentRows,
    ],
    [hero, shelves, toRow, recentRows],
  );
  useRowIconBackfill(iconRows);

  const handleDismiss = useCallback(
    (app: AppSummary, scope: FeedbackScope) => {
      void dismiss(app.id, scope, app.category).then((ok) => {
        if (!ok) notifyToast(t('featured.feedback.failed'), 'error');
      });
    },
    [dismiss, t],
  );

  const [offHintHidden, setOffHintHidden] = useState(affinityOffHintClosed);
  const saveInterests = useCallback(
    async (categories: string[]) => {
      try {
        await tauriApi.saveInterestSeeds(categories);
        reload();
        return true;
      } catch {
        notifyToast(t('featured.interest.failed'), 'error');
        return false;
      }
    },
    [reload, t],
  );

  if (apps.length === 0) {
    return (
      <ViewShell viewClass="home-view featured-view">
        <FilterEmptyState
          style={{ marginTop: '40px' }}
          icon={<Search size={40} strokeWidth={1.5} />}
          title={t('featured.empty_title')}
          description={t('featured.empty_desc')}
          resetLabel={t('featured.reset_device_filter')}
          onReset={resolvePlatformReset(onResetPlatformFilter)}
        />
      </ViewShell>
    );
  }

  const card = (app: AppSummary, reasonText?: string, withDismiss = false, eager = false) => {
    const appKey = normalizeId(app.id);
    return (
      <AppCard
        key={app.id}
        app={app}
        eager={eager}
        reasonText={reasonText}
        onDismiss={withDismiss ? handleDismiss : undefined}
        platformLoading={isPlatformLoading(app, platformResolvedOtherIds)}
        isInstalled={selectIsInstalled(app.id, installedIds)}
        isManaged={selectManagedState(app.id, managedIds)}
        isInstalling={installingIds?.has(appKey)}
        isFavorite={favoriteIds.has(appKey)}
        isWatched={watchedIds?.has(appKey)}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onToggleWatch={onToggleWatch}
      />
    );
  };

  const shelfHeader = (shelf: FeaturedShelf) => {
    switch (shelf.kind) {
      case 'because_you':
        return {
          icon: <Sparkles size={16} />,
          title: seedPhrase(t, shelf.seed_relation ?? 'favorite', seedDisplayName(shelf.seed_id ?? '', appById)),
        };
      case 'category_pick': {
        const cat = categoryName(t, shelf.category ?? '');
        return {
          icon: <LayoutGrid size={16} />,
          title: personalized
            ? t('featured.shelf.category_for_you', { category: cat })
            : t('featured.shelf.category_editorial', { category: cat }),
          action: shelf.category
            ? { label: t('featured.shelf.open_category'), onClick: () => onOpenCategory(shelf.category!) }
            : undefined,
        };
      }
      case 'explore':
        return {
          icon: <Compass size={16} />,
          title: t('featured.shelf.explore'),
          subtitle: t('featured.shelf.explore_desc'),
        };
      case 'fresh':
        return {
          icon: <Clock size={16} />,
          title: t('featured.shelf.fresh'),
          action: { label: t('featured.shelf.view_all'), onClick: onNavigateLatest },
        };
      default:
        return { icon: <Sparkles size={16} />, title: '' };
    }
  };

  return (
    <ViewShell viewClass="home-view featured-view">
      {page && personalized && (
        <div className="featured-status" data-testid="featured-status">
          <span className="featured-status-text">
            <Lock size={13} aria-hidden="true" />
            <span>{t('featured.status.signals', { count: page.signal_count })}</span>
          </span>
          <span className="featured-status-side">
            {page.top_categories.map((c) => (
              <span key={c} className="featured-chip">
                {categoryName(t, c)}
              </span>
            ))}
            <button
              type="button"
              className="btn-fluent btn-secondary btn-sm"
              data-testid="featured-open-preferences"
              onClick={onOpenAffinitySettings}
            >
              <SlidersHorizontal size={12} aria-hidden="true" />
              <span>{t('featured.status.preferences')}</span>
            </button>
          </span>
        </div>
      )}
      {page && state === 'off' && !offHintHidden && (
        <div className="featured-status" data-testid="featured-off-hint">
          <span className="featured-status-text">
            <Lock size={13} aria-hidden="true" />
            <span>{t('featured.status.off')}</span>
          </span>
          <span className="featured-status-side">
            <button type="button" className="btn-fluent btn-secondary btn-sm" onClick={onOpenAffinitySettings}>
              <span>{t('featured.status.turn_on')}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-ghost btn-sm"
              aria-label={t('featured.status.close_hint')}
              title={t('featured.status.close_hint')}
              onClick={() => {
                affinityOffHintClosed = true;
                setOffHintHidden(true);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
      )}

      {showPicker && (
        <InterestPicker
          onSave={saveInterests}
          onSkip={() => {
            interestPickerSkipped = true;
            setPickerHidden(true);
          }}
        />
      )}

      {!page && loading && (
        <div className="hero-banner featured-hero-skeleton" data-testid="featured-skeleton" aria-hidden="true">
          <div className="feed-skeleton-lines">
            <div className="skeleton-box feed-skeleton-line-main" />
            <div className="skeleton-box feed-skeleton-line-sub" />
          </div>
        </div>
      )}

      {!page && !loading && failed && (
        <EmptyState
          icon={<AlertTriangle size={40} strokeWidth={1.5} />}
          title={t('latest.list_error')}
          action={
            <button
              type="button"
              className="btn-fluent btn-secondary"
              data-testid="featured-retry"
              onClick={reload}
            >
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
              <span>{t('latest.retry')}</span>
            </button>
          }
        />
      )}

      {hero.length > 0 && (
        <>
          <div className="section-header">
            <h3 className="section-title">
              <Sparkles size={16} />
              <span>{personalized ? t('featured.hero_title') : t('featured.hero_title_editorial')}</span>
            </h3>
          </div>
          {mainHero && (
            <HeroBanner
              pick={mainHero}
              row={toRow(mainHero)}
              reasonText={formatReasons(t, mainHero.reasons, appById)}
              installed={selectIsInstalled(mainHero.app.id, installedIds)}
              installing={Boolean(installingIds?.has(normalizeId(mainHero.app.id)))}
              language={i18n.language}
              onOpenDetail={onOpenDetail}
              onQuickInstall={onQuickInstall}
              onDismiss={handleDismiss}
            />
          )}
          {sideHero.length > 0 && (
            <div className="app-grid" data-testid="featured-hero-side">
              {sideHero.map((p) => card(toRow(p), formatReasons(t, p.reasons, appById), true, true))}
            </div>
          )}
        </>
      )}

      {shelves.map((shelf, i) => {
        const head = shelfHeader(shelf);
        return (
          <section key={`${shelf.kind}-${shelf.seed_id ?? shelf.category ?? i}`} data-testid={`featured-shelf-${shelf.kind}`}>
            <div className="section-header">
              <h3 className="section-title">
                {head.icon}
                <span>{head.title}</span>
              </h3>
              {head.action && (
                <button type="button" className="btn-fluent btn-ghost btn-sm" onClick={head.action.onClick}>
                  <span>{head.action.label}</span>
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            {head.subtitle && <p className="featured-shelf-subtitle">{head.subtitle}</p>}
            <div className="app-grid">
              {shelf.items.map((p) => card(toRow(p), formatReasons(t, p.reasons, appById), true))}
            </div>
          </section>
        );
      })}

      {recentRows.length > 0 && (
        <section className="featured-recent-section" data-testid="featured-recent">
          <div className="section-header">
            <h3 className="section-title">
              <Eye size={16} aria-hidden="true" />
              <span>{t('featured.recent')}</span>
            </h3>
            {onClearRecentViews && (
              <button
                type="button"
                className="btn-fluent btn-secondary btn-sm"
                data-testid="featured-clear-recent"
                onClick={onClearRecentViews}
                aria-label={t('featured.clear_recent')}
                title={t('featured.clear_recent')}
              >
                <Trash2 size={12} aria-hidden="true" />
                <span>{t('featured.clear_recent')}</span>
              </button>
            )}
          </div>
          <div className="app-grid">
            {recentRows.map((app) => card(app))}
          </div>
        </section>
      )}
    </ViewShell>
  );
};

interface HeroBannerProps {
  pick: FeaturedPick;
  row: AppSummary;
  reasonText?: string;
  installed: boolean;
  installing: boolean;
  language: string;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onDismiss?: (app: AppSummary, scope: FeedbackScope) => void;
}

const HeroBanner: React.FC<HeroBannerProps> = ({
  row,
  reasonText,
  installed,
  installing,
  language,
  onOpenDetail,
  onQuickInstall,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const isValid = (v: unknown): v is string =>
    typeof v === 'string' && v.trim() !== '' && !isPlaceholderDescription(v);
  const langDesc = getAppDescription(row, language);
  const desc = isValid(langDesc)
    ? langDesc
    : isValid(row.description_en)
      ? row.description_en
      : isValid(row.description)
        ? row.description
        : t('trends.no_desc');
  const badge = resolveVerifiedBadgeVariant(row as { is_verified?: unknown; source?: unknown; status?: unknown });
  return (
    <div
      className="hero-banner featured-hero"
      data-testid="featured-hero"
      onClick={() => onOpenDetail(row.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.key === ' ') e.preventDefault();
          onOpenDetail(row.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="hero-content">
        <h2 className="hero-title">
          <span>{row.name}</span>
          <span className="featured-hero-category"> · {categoryName(t, row.category)}</span>
          {badge && <VerifiedBadge size="sm" variant={badge} />}
        </h2>
        <p className="hero-desc">{desc}</p>
        {reasonText && (
          <p className="featured-hero-reason" data-testid="featured-hero-reason">
            <Sparkles size={12} aria-hidden="true" />
            <span>{reasonText}</span>
          </p>
        )}
        <div className="hero-actions">
          <button
            type="button"
            className={`btn-fluent ${installed ? 'btn-secondary' : 'btn-primary'}`}
            disabled={installing}
            onClick={(e) => {
              e.stopPropagation();
              if (installed) onOpenDetail(row.id);
              else onQuickInstall(row.id);
            }}
          >
            {installing ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span className="spinner-icon" style={{ width: '12px', height: '12px', borderWidth: '1.5px' }} />
                <span>{t('app.installing')}</span>
              </span>
            ) : installed ? (
              <>
                <Play size={14} />
                <span>{t('featured.ready_open')}</span>
              </>
            ) : (
              <>
                <Zap size={14} />
                <span>{t('app.install')}</span>
              </>
            )}
          </button>
          {onDismiss && (
            <button
              type="button"
              className="btn-fluent btn-ghost"
              data-testid={`dismiss-app-${row.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(row, 'app');
              }}
            >
              <ThumbsDown size={14} aria-hidden="true" />
              <span>{t('featured.feedback.not_interested')}</span>
            </button>
          )}
        </div>
      </div>
      <div className="hero-visual">
        <div className="hero-icon-card">
          <AppIcon
            icon={row.icon}
            name={row.name}
            appId={row.id}
            iconBg={row.icon_bg}
            style={{ width: '100%', height: '100%', borderRadius: 'inherit' }}
            loading="eager"
          />
        </div>
      </div>
    </div>
  );
};
