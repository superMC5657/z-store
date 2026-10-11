/**
 * 双维目录筛选 pending 生命周期兼容外观（deprecated shallow facade，ica3-3）。
 *
 * 实现唯一深模块为 `lib/platformFilter`：inflight 集合 + seq 守卫 + lite 批量
 * （5/批、上限 20）+ settle 定时（15s）+ confirmed 并集 + 键归一，locality
 * 已全部收归该模块，本文件不再持有任何实现（零 `leverage`，待迁移后删除）。
 *
 * 本文件仅声明式重导出（`export ... from`，无函数包装、无透传 adapter）：
 * 未迁移调用方（`app/hooks/usePlatformBackfill`、`app/favoritesUncataloged`、
 * 旧单测）经此兼容口继续工作；新代码请直引 `lib/platformFilter`
 * （`isPlatformPending` / `matchPlatformSetWithPending` 为规范名，
 * `isPendingFor` / `matchSelectedWithPending` 仅为此处别名）。
 *
 * 语义锁（CONTEXT 双维目录筛选行）见 `lib/platformFilter`。
 * P1 约束：不碰 `icon-ready → applyHit` 写路径；平台判定为只读，不读写图标缓冲。
 */
export {
  PENDING_SETTLE_MS,
  LITE_BATCH_SIZE,
  LITE_TARGET_CAP,
  /** 规范名 `isPlatformPending` 的兼容别名（旧单测/视图经此口）。 */
  isPlatformPending as isPendingFor,
  /** 规范名 `matchPlatformSetWithPending` 的兼容别名（旧单测/视图经此口）。 */
  matchPlatformSetWithPending as matchSelectedWithPending,
  isEnrichedRowPending,
  unionConfirmedSets,
  normalizePendingKey,
  normalizeAppId,
  isPlatformPending,
  matchPlatformSetWithPending,
  isPlatformEmpty,
  createInflightGuard,
  createSeqGuard,
  runLiteBatch,
  selectListLiteTargets,
  collectListPendingKeys,
  scheduleSettleConfirm,
} from '../lib/platformFilter';
export type {
  PendingLiteTarget,
  PendingLiteResult,
  PendingRow,
  InflightGuard,
  SeqGuard,
  LiteFetch,
  SettleSchedule,
} from '../lib/platformFilter';
