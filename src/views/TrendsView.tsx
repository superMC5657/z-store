import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { TrendingUp } from 'lucide-react';
import { AppSummary } from '../types';
import { AppCard, getRankBadgeColor } from '../components/AppCard';
import { SegmentedControl } from '../components/SegmentedControl';
import { tauriApi } from '../services/api';
import {
  FilterEmptyState,
  PlatformResetOption,
  ViewAppActions,
  ViewShell,
  resolvePlatformReset,
} from './ViewShell';
import {
  enrichWithCatalogCategory,
  fetchTrends,
  formatStars,
  matchCatalogApp,
  sortByCategoryGroup,
  trendReposFromCatalog,
  type TrendBoardId,
  type TrendRepo,
} from '../services/trends';

/**
 * 趋势榜单一榜一源：直接调 `fetchTrends(board, { language })`，
 * 排序口径以后端 ranker 为准，前端不再做 fork/star 加权复算。
 *
 * 仅有的两处客户端分组（后端已预留）：
 * - category 榜：远端行默认无类目，经 `enrichWithCatalogCategory`
 *   用本地收录库补类目后，再用 `sortByCategoryGroup` 做最终分组；
 * - top 榜离线：远端为空时用 `trendReposFromCatalog(apps)` 本地快照
 *  （只按总星排序，不伪造涨星徽标）。
 * 其余榜远端为空一律走空状态，绝不回退本地加权假榜。
 */

interface TrendsViewProps
  extends
    Omit<ViewAppActions, 'favoriteIds' | 'installedIds' | 'installingIds' | 'onToggleFavorite'>,
    PlatformResetOption {
  favoriteIds?: Set<string>;
  installedIds?: Set<string>;
  installingIds?: Set<string>;
  onToggleFavorite?: (id: string) => void;
}

type DisplayTrendItem =
  | { type: 'catalog'; app: AppSummary; rank: number; gain?: number }
  | { type: 'uncataloged'; repo: TrendRepo; rank: number; gain?: number };

const BOARD_IDS: TrendBoardId[] = [
  'daily',
  'weekly',
  'monthly',
  'new',
  'rising',
  'category',
  'healthy',
  'top',
];

const CATEGORY_IDS = [
  'dev',
  'media',
  'office',
  'security',
  'graphics',
  'network',
  'system',
  'reading',
  'ops',
  'games',
];

const LANGUAGE_OPTIONS = [
  'TypeScript',
  'JavaScript',
  'Python',
  'Rust',
  'Go',
  'Java',
  'C++',
  'Swift',
  'Kotlin',
  'Dart',
];

const ALL = 'all';

/** 单一榜单分发映射：gain 文案口径（today/week/month）一处维护，避免分散三元分支。 */
const BOARD_TO_GAIN_KEY: Record<TrendBoardId, 'today' | 'week' | 'month'> = {
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
  new: 'week',
  rising: 'week',
  category: 'week',
  healthy: 'week',
  top: 'week',
};

function boardToGainKey(board: TrendBoardId): 'today' | 'week' | 'month' {
  return BOARD_TO_GAIN_KEY[board];
}

/** 读取后端 `starsGained`：缺失或非正数返回 undefined（不渲染徽标）。 */
function getStarsGained(repo: TrendRepo): number | undefined {
  const n = repo.starsGained;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

export const TrendsView: React.FC<TrendsViewProps> = ({
  apps,
  favoriteIds,
  installedIds,
  installingIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onResetPlatformFilter,
}) => {
  const { t } = useTranslation();
  const [board, setBoard] = useState<TrendBoardId>('weekly');
  const [language, setLanguage] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);
  // null = 加载中；[] = 远端为空（走空状态，绝不做本地加权假榜）。
  const [remoteTrends, setRemoteTrends] = useState<TrendRepo[] | null>(null);

  const gainKey = boardToGainKey(board);
  const isLoading = remoteTrends === null;

  // 一榜一源：category 榜透传 category（后端按 board+language+category 建缓存槽），
  // 其余榜只传 language；board/language/category 任一变化均触发重抓。
  useEffect(() => {
    let isMounted = true;
    setRemoteTrends(null);

    const opts: { language?: string; category?: string } = {};
    if (language !== ALL) opts.language = language;
    if (board === 'category' && category !== ALL) opts.category = category;
    fetchTrends(board, opts)
      .then((data) => {
        if (!isMounted) return;
        setRemoteTrends(data ?? []);
      })
      .catch(() => {
        if (!isMounted) return;
        setRemoteTrends([]);
      });

    return () => {
      isMounted = false;
    };
  }, [board, language, category]);

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (remoteTrends === null) return [];

    let repos = remoteTrends;

    if (board === 'category') {
      const enriched = enrichWithCatalogCategory(repos, apps);
      const grouped = sortByCategoryGroup(
        enriched,
        category === ALL ? undefined : category,
      );
      // 未能补齐类目的远端行沉底（保持相对顺序），避免无名分组抢占榜首。
      repos = [
        ...grouped.filter((r) => r.category),
        ...grouped.filter((r) => !r.category),
      ];
    }

    if (repos.length === 0) {
      // top 榜离线快照：只按总星排序，不伪造涨星徽标（gain 故意留空）。
      if (board === 'top' && apps.length > 0) {
        return trendReposFromCatalog(apps).map((repo, index) => {
          const matched = matchCatalogApp(repo, apps);
          if (matched) {
            return {
              type: 'catalog' as const,
              app: matched,
              rank: index + 1,
            };
          }
          return {
            type: 'uncataloged' as const,
            repo,
            rank: index + 1,
          };
        });
      }
      return [];
    }

    const matchedAppIds = new Set<string>();
    const items: DisplayTrendItem[] = [];

    repos.forEach((trend) => {
      const matched = matchCatalogApp(trend, apps);
      const gain = getStarsGained(trend);
      if (matched && !matchedAppIds.has(matched.id)) {
        matchedAppIds.add(matched.id);
        items.push({
          type: 'catalog',
          app: matched,
          rank: items.length + 1,
          gain,
        });
        return;
      }
      // 分类榜指定分类时：未收录且无类目的仓库直接略过。
      if (board === 'category' && category !== ALL && !trend.category) return;
      items.push({
        type: 'uncataloged',
        repo: trend,
        rank: items.length + 1,
        gain,
      });
    });

    return items;
  }, [remoteTrends, apps, board, category]);

  const gainTextFor = (gain?: number): string | undefined => {
    if (!gain || gain <= 0) return undefined;
    const count = formatStars(gain);
    if (gainKey === 'today') return t('trends.stars_gained_today', { count });
    if (gainKey === 'month') return t('trends.stars_gained_month', { count });
    return t('trends.stars_gained_week', { count });
  };

  const isFilteredEmpty =
    displayItems.length === 0 &&
    apps.length > 0 &&
    (board === 'category' || language !== ALL);

  // top 榜离线快照标记：远端为空但本地有快照时显式标注，避免伪装成远端榜。
  const isTopSnapshot =
    board === 'top' &&
    remoteTrends !== null &&
    remoteTrends.length === 0 &&
    displayItems.length > 0;

  return (
    <ViewShell viewClass="trends-view">
      <div className="section-header trends-header">
        <h3 className="section-title">
          <TrendingUp size={18} />
          <span>{t('trends.title')}</span>
        </h3>
        <p className="trends-subtitle">{t('trends.subtitle')}</p>
      </div>

      <div className="trends-toolbar">
        <div className="trends-boards" role="tablist" aria-label={t('trends.title')}>
          <SegmentedControl<TrendBoardId>
            value={board}
            onChange={(next) => setBoard(next)}
            options={BOARD_IDS.map((id) => ({
              value: id,
              label: t(`trends.board_${id}`),
              title: t(`trends.board_${id}_desc`),
            }))}
          />
        </div>
        <div className="trends-filters">
          <label className="trends-filter">
            <span className="trends-filter-label">{t('trends.filter_language')}</span>
            <select
              className="fluent-input trends-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label={t('trends.filter_language')}
            >
              <option value={ALL}>{t('trends.filter_language_all')}</option>
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </label>
          {board === 'category' && (
            <label className="trends-filter">
              <span className="trends-filter-label">{t('trends.filter_category')}</span>
              <select
                className="fluent-input trends-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                aria-label={t('trends.filter_category')}
              >
                <option value={ALL}>{t('trends.filter_category_all')}</option>
                {CATEGORY_IDS.map((id) => (
                  <option key={id} value={id}>
                    {t(`categories.cat_${id}_name`, { defaultValue: id })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="trends-meta">
        <span className="trends-board-desc">{t(`trends.board_${board}_desc`)}</span>
        {isTopSnapshot && (
          <span className="trends-snapshot-badge" title={t('trends.top_snapshot_desc')}>
            {t('trends.top_snapshot_badge')}
          </span>
        )}
        {displayItems.length > 0 && (
          <span className="trends-count">
            {t('trends.results_count', { count: displayItems.length })}
          </span>
        )}
      </div>

      <div className="fluent-list-container">
        {isLoading ? null : apps.length === 0 || displayItems.length === 0 ? (
          <FilterEmptyState
            className="trends-empty"
            icon={<TrendingUp size={40} strokeWidth={1.5} />}
            title={t(isFilteredEmpty ? 'trends.empty_filter_title' : 'trends.empty_title')}
            description={t(isFilteredEmpty ? 'trends.empty_filter_desc' : 'trends.empty_desc')}
            resetLabel={t('trends.reset_device_filter')}
            onReset={resolvePlatformReset(onResetPlatformFilter)}
          />
        ) : (
          displayItems.map((item, index) => {
            if (item.type === 'catalog') {
              return (
                <AppCard
                  key={item.app.id}
                  app={item.app}
                  rank={item.rank}
                  className="fluent-list-row"
                  eager={index < 6}
                  trendGain={item.gain}
                  trendGainText={gainTextFor(item.gain)}
                  isInstalled={installedIds?.has(item.app.id) ?? false}
                  isInstalling={installingIds?.has(item.app.id) ?? false}
                  isFavorite={favoriteIds?.has(item.app.id) ?? false}
                  onOpenDetail={onOpenDetail}
                  onQuickInstall={onQuickInstall}
                  onToggleFavorite={onToggleFavorite}
                />
              );
            }

            const gainText = gainTextFor(item.gain);
            const owner = item.repo.owner?.trim();

            return (
              <div
                key={`uncataloged-${item.repo.id || item.repo.name}-${index}`}
                className="app-card fluent-list-row trend-uncataloged-row"
                role={item.repo.url ? 'button' : undefined}
                tabIndex={item.repo.url ? 0 : undefined}
                style={{ cursor: item.repo.url ? 'pointer' : 'default' }}
                onClick={() => {
                  if (item.repo.url) {
                    void tauriApi.openUrl(item.repo.url);
                  }
                }}
                onKeyDown={(e) => {
                  if (item.repo.url && (e.key === 'Enter' || e.key === ' ')) {
                    void tauriApi.openUrl(item.repo.url);
                  }
                }}
              >
                <div
                  className="app-rank"
                  style={{ color: getRankBadgeColor(index) }}
                  aria-label={`#${item.rank}`}
                >
                  #{item.rank}
                </div>
                <div className="app-card-header trend-uncataloged-main">
                  <div className="app-meta" style={{ minWidth: 0 }}>
                    <div className="app-title">
                      <span className="app-name">{item.repo.name}</span>
                    </div>
                    {owner && (
                      <div className="app-owner">
                        {t('trends.built_by', { owner })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="app-card-footer trend-uncataloged-side">
                  <div className="app-tags">
                    <span className="app-tag app-tag-star">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="1">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span>{formatStars(item.repo.stars)}</span>
                    </span>
                    {gainText && (
                      <span className="app-tag trend-gain" title={gainText}>
                        {gainText}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </ViewShell>
  );
};
