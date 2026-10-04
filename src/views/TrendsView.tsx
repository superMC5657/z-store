import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import '../styles/components-trends.css';
import { TrendingUp, WifiOff } from 'lucide-react';
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
  boardGainKey,
  fetchTrendsResult,
  formatStars,
  matchCatalogApp,
  normalizeProxyPrefix,
  resolveTrendBoard,
  TREND_BOARD_IDS,
  type TrendBoardId,
  type TrendRepo,
  type TrendsErrorKind,
  type TrendsResult,
} from '../services/trends';

/**
 * 趋势榜单一榜一源：调 `fetchTrendsResult(board, { proxyPrefix })`，
 * 排序口径以后端 ranker 为准，前端不再做 fork/star 加权复算；
 * gh-proxy 前缀来自设置库 `active_mirror`（见下），service 内归一化。
 * 远端为空一律走空状态，绝不回退本地加权假榜。
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

/** 错误种类 → 描述文案键一处映射，避免渲染处散落四分支。 */
type TrendsErrorDescKey =
  | 'trends.error_network'
  | 'trends.error_timeout'
  | 'trends.error_rate_limited'
  | 'trends.error_unavailable';

const ERROR_DESC_KEY: Record<TrendsErrorKind, TrendsErrorDescKey> = {
  network: 'trends.error_network',
  timeout: 'trends.error_timeout',
  'rate-limited': 'trends.error_rate_limited',
  unavailable: 'trends.error_unavailable',
};

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
  // null = 加载中；非 null 按 status 分流：error → 错误面板，empty/ok → 列表或空状态。
  const [trendResult, setTrendResult] = useState<TrendsResult | null>(null);
  // 重试计数：递增即重触发抓取 effect。
  const [retryCount, setRetryCount] = useState(0);
  // gh-proxy 前缀：`active_mirror` 持久化在 Rust 侧设置库，前端经 getSettings 异步读；
  // 就绪前不抓取，避免先直连闪一次再带代理重抓。
  const [proxyPrefix, setProxyPrefix] = useState<string | undefined>(undefined);
  const [proxyReady, setProxyReady] = useState(false);

  // 陈旧榜兜底经 trends SSOT 回落（如已下线的 'top' / 'category' 残留 → 'weekly'）。
  const activeBoard: TrendBoardId = resolveTrendBoard(board);

  const gainKey = boardGainKey(activeBoard);
  const isLoading = trendResult === null;
  // 仅 status==='error' 才展示错误文案； genuine empty（status==='empty'）绝不走错误面板。
  const errorKind: TrendsErrorKind | undefined =
    trendResult?.status === 'error' ? (trendResult.errorKind ?? 'unavailable') : undefined;

  useEffect(() => {
    let cancelled = false;
    tauriApi
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        // 经 trends SSOT 归一化（'direct'/空 → 直连；其余透传，抓取恒直连忽略）。
        setProxyPrefix(normalizeProxyPrefix(s?.active_mirror));
        setProxyReady(true);
      })
      .catch(() => {
        // 非 Tauri 环境（浏览器预览/单测）无设置库：直连。
        if (cancelled) return;
        setProxyPrefix(undefined);
        setProxyReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 一榜一源：board / 代理 / 重试任一变化均触发重抓。
  useEffect(() => {
    if (!proxyReady) return;
    let isMounted = true;
    setTrendResult(null);

    fetchTrendsResult(activeBoard, proxyPrefix ? { proxyPrefix } : {})
      .then((res) => {
        if (!isMounted) return;
        setTrendResult(res);
      })
      .catch(() => {
        // service 按契约应总 resolve；此处兜底未知异常，归为 unavailable。
        if (!isMounted) return;
        setTrendResult({ repos: [], status: 'error', errorKind: 'unavailable' });
      });

    return () => {
      isMounted = false;
    };
  }, [activeBoard, proxyPrefix, proxyReady, retryCount]);

  const handleRetry = () => setRetryCount((c) => c + 1);

  // 与本地 catalog 预过滤后的 apps 交叉匹配：有则完整卡片，无则名 + 星数。
  // catalog 匹配（matchCatalogApp）保留——下掉的只是分类榜单，不是收录对照展示。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (trendResult === null || trendResult.status === 'error') return [];

    const repos = trendResult.repos;

    if (repos.length === 0) return [];

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
      items.push({
        type: 'uncataloged',
        repo: trend,
        rank: items.length + 1,
        gain,
      });
    });

    return items;
  }, [trendResult, apps]);

  const gainTextFor = (gain?: number): string | undefined => {
    if (!gain || gain <= 0) return undefined;
    const count = formatStars(gain);
    if (gainKey === 'today') return t('trends.stars_gained_today', { count });
    if (gainKey === 'month') return t('trends.stars_gained_month', { count });
    return t('trends.stars_gained_week', { count });
  };

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
            value={activeBoard}
            onChange={(next) => setBoard(next)}
            options={TREND_BOARD_IDS.map((id) => ({
              value: id,
              label: t(`trends.board_${id}`),
              title: t(`trends.board_${id}_desc`),
            }))}
          />
        </div>
      </div>

      <div className="trends-meta">
        <span className="trends-board-desc">{t(`trends.board_${activeBoard}_desc`)}</span>
        {displayItems.length > 0 && (
          <span className="trends-count">
            {t('trends.results_count', { count: displayItems.length })}
          </span>
        )}
      </div>

      <div className="fluent-list-container">
        {isLoading ? null : errorKind ? (
          <FilterEmptyState
            className="trends-empty trends-error"
            icon={<WifiOff size={40} strokeWidth={1.5} />}
            title={t('trends.error_title')}
            description={t(ERROR_DESC_KEY[errorKind])}
            resetLabel={t('trends.retry')}
            onReset={handleRetry}
          />
        ) : apps.length === 0 || displayItems.length === 0 ? (
          <FilterEmptyState
            className="trends-empty"
            icon={<TrendingUp size={40} strokeWidth={1.5} />}
            title={t('trends.empty_title')}
            description={t('trends.empty_desc')}
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
