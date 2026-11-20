/** 趋势域公开门面：统一导出抓榜、会话控制、富卡摘要映射与缓存清理接口。 */

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
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  appSummaryFromDetail,
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  detailHealKeysFor,
  evictTrendEnrichCachesForDetail,
  formatStars,
  isPlaceholderDescription,
  matchCatalogApp,
  putTrendEnrichMemory,
  snapshotTrendEnrichCache,
  upsertTrendEnrichFromDetail,
  upsertTrendEnrichRichcard,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
} from './trends/enrich';

export {
  TREND_DB_PAYLOAD_MAX_BYTES,
  clearTrendsCache,
  utf8ByteLength,
} from './trends/cache';
