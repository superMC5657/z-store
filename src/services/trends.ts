/** 趋势域公开门面：统一导出抓榜、会话控制与缓存清理接口（富卡池本体见 `repoEnrichCache`）。 */

export {
  TREND_BOARD_IDS,
  boardGainKey,
  createTrendBoardSession,
  fetchTrendsResult,
  resolveTrendBoard,
  subscribeBoardHydrated,
  type DisplayTrendItem,
  type TrendBoardSession,
  type TrendBoardSessionOptions,
  type TrendMirrorState,
} from './trends/board';

export { normalizeProxyPrefix } from './trends/parse';

export {
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  formatStars,
  isPlaceholderDescription,
  matchCatalogApp,
  putTrendEnrichMemory,
  snapshotTrendEnrichCache,
} from './trends/enrich';

export {
  TREND_DB_PAYLOAD_MAX_BYTES,
  clearTrendsCache,
  utf8ByteLength,
} from './trends/cache';
