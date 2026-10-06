// UI 兼容：榜单契约类型定义以 `../types` 为 SSOT，此处原样 re-export，
// 因此从 `services/trends` 或 `types` 导入均可。
export type {
  FetchTrendsOptions,
  TrendBoardId,
  TrendRepo,
  TrendsErrorKind,
  TrendsResult,
  TrendsStatus,
} from '../types';

export * from './trends/cache';
export * from './trends/parse';
export * from './trends/enrich';
export * from './trends/boards';
