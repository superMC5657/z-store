/**
 * 趋势榜会话：榜单选择与抓取（SWR / 手动强刷）、榜单行与目录交叉匹配、全局设备平台过滤，
 * 以及未收录行富卡会话（enrich / lite / settle）。强刷落定后自动以强制位跟随一次 enrich。
 */
import { useMemo, useRef } from 'react';
import type { AppSummary, TrendBoardId, TrendRepo } from '../../types';
import { matchCatalogApp } from '../../services/trends';
import { isEnrichedRowLoading } from '../../app/selectors';
import { matchPlatformSet, matchPlatformSetWithLoading } from '../../lib/platformFilter';
import { useTrendBoard } from './useTrendBoard';
import { useTrendEnrichment, type DisplayTrendItem } from './useTrendEnrichment';

export type { DisplayTrendItem };

const NO_CONFIRMED: ReadonlySet<string> = new Set<string>();

/** 读取后端 `starsGained`：缺失或非正数返回 undefined（不渲染徽标）。 */
function getStarsGained(repo: TrendRepo): number | undefined {
  const n = repo.starsGained;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

interface UseTrendSessionParams {
  /** 身份匹配用的全量收录。 */
  matchingBase: AppSummary[];
  /** 全局设备平台选择：传入即按其过滤榜单行（含未收录行）；缺省不过滤。 */
  selectedPlatforms?: ReadonlySet<string>;
  /** 已确认 other（App 懒回填落定集合）。 */
  platformResolvedOtherIds?: ReadonlySet<string>;
  initialBoard?: TrendBoardId;
}

export function useTrendSession({
  matchingBase,
  selectedPlatforms,
  platformResolvedOtherIds,
  initialBoard = 'weekly',
}: UseTrendSessionParams) {
  const board = useTrendBoard(initialBoard);
  const { trendResult, activeBoard, boardReady, refreshEnrichForceRef } = board;

  // 与本地收录交叉匹配：有则完整卡片，无则名 + 星数。
  const rawDisplayItems = useMemo<DisplayTrendItem[]>(() => {
    if (trendResult === null || trendResult.status === 'error') return [];
    const matchedAppIds = new Set<string>();
    const items: DisplayTrendItem[] = [];
    for (const trend of trendResult.repos) {
      const matched = matchCatalogApp(trend, matchingBase);
      const gain = getStarsGained(trend);
      if (matched && !matchedAppIds.has(matched.id)) {
        matchedAppIds.add(matched.id);
        items.push({ type: 'catalog', app: matched, gain });
      } else {
        items.push({ type: 'uncataloged', repo: trend, gain });
      }
    }
    return items;
  }, [trendResult, matchingBase]);

  // enrich 按当前可见行排队；可见行又依赖 enrich 结果过滤，故经会话内 ref 读取最新值。
  const displayItemsRef = useRef<DisplayTrendItem[]>([]);
  const { enrichedApps, combinedConfirmed } = useTrendEnrichment({
    trendResult,
    rawItems: rawDisplayItems,
    getDisplayItems: () => displayItemsRef.current,
    activeBoard,
    boardReady,
    refreshEnrichForceRef,
    globalConfirmed: platformResolvedOtherIds,
  });

  // 全局设备平台过滤接入榜单行（含未收录行）：加载中行恒可见，落定后再走 matchPlatformSet。
  const displayItems = useMemo<DisplayTrendItem[]>(() => {
    if (!selectedPlatforms) return rawDisplayItems;
    return rawDisplayItems.filter((item) => {
      if (item.type === 'catalog') {
        return matchPlatformSetWithLoading(item.app, selectedPlatforms, platformResolvedOtherIds ?? NO_CONFIRMED);
      }
      const key = item.repo.id.toLowerCase();
      const enriched = enrichedApps[key];
      if (isEnrichedRowLoading(key, enriched, combinedConfirmed)) return true;
      return matchPlatformSet(enriched ?? { platforms: [] }, selectedPlatforms);
    });
  }, [rawDisplayItems, selectedPlatforms, enrichedApps, platformResolvedOtherIds, combinedConfirmed]);
  displayItemsRef.current = displayItems;

  return {
    setBoard: board.setBoard,
    activeBoard,
    trendResult,
    gainKey: board.gainKey,
    isLoading: board.isLoading,
    errorKind: board.errorKind,
    handleRetry: board.handleRetry,
    isRefreshing: board.isRefreshing,
    handleRefresh: board.handleRefresh,
    rawDisplayItems,
    displayItems,
    enrichedApps,
    combinedConfirmed,
  };
}
