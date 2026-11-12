/**
 * 趋势域唯一对外公开门面。
 *
 * 视图、组件与跨特性模块统一经此导入趋势抓榜、会话控制、富卡摘要映射、
 * 占位简介判定与详情治愈事件，避免穿透到 `services/trends/*` 内部实现。
 */

export {
  TREND_BOARD_IDS,
  boardGainKey,
  createTrendBoardSession,
  fetchTrendsResult,
  persistBoardCacheFromDetailIfPresent,
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
