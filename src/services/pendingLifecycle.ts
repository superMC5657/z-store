/**
 * 双维目录筛选 pending 生命周期深模块（ticket 11，唯一深模块）。
 *
 * 收编：inflight 集合 + seq 守卫 + lite 批量（5/批、上限 20）+ settle 定时（15s）+ confirmed 并集。
 * 藏于现有 selector interface（`app/selectors`）之后：视图/选择器只调本模块统一接口，
 * 不直引 `lib/platformFilter` 纯函数（lib 降为本模块内部 seam；其对外导出保持不动，
 * 纯函数单测照旧经同一导出通过）。
 *
 * 语义锁（CONTEXT 双维目录筛选行）：
 * - 显式 `[]` 为有效空选择（渲染空筛选状态，绝不回退全选）；
 * - 缺键/损坏才回退全选（见 `app/platformStorage`，本模块不动该逻辑）。
 * - 未收录行 pending→确认语义不变：空 + 未确认即 pending（恒可见、不计数），
 *   空非 stale 落定/15s settle 超时才记已确认 Other；具平台行永不 pending。
 * P1 约束：不碰 `icon-ready → applyHit` 写路径；平台判定为只读，不读写图标缓冲。
 */
import {
  PENDING_SETTLE_MS,
  isPlatformPending,
  matchPlatformSetWithPending,
  resolvePendingPlatformsLite,
  type PendingLiteResult,
  type PendingLiteTarget,
} from '../lib/platformFilter';

/** settle 超时与主列表/榜单同值（15s；`lib` 单值，此处透出为深模块统一口）。 */
export { PENDING_SETTLE_MS };
/** lite 通道分批大小（与 `lib.resolvePendingPlatformsLite` 内步长同源）。 */
export const LITE_BATCH_SIZE = 5;
/** lite 单次目标上限（App 列表与趋势榜单同值，调用方切片前 20）。 */
export const LITE_TARGET_CAP = 20;

export type { PendingLiteTarget, PendingLiteResult };

/** 待确认判定的最小行形态（`AppSummary`/`AppDetail` 均满足）。 */
export interface PendingRow {
  id?: string;
  platforms?: string[];
}

/**
 * 统一 pending 判定（唯一口）：具平台永不 pending；空 + 未传确认集沿用旧语义（非 pending）；
 * 空 + 已传确认集（含空集合）时，未在集合中即 pending。
 * 替代各视图 3 行 `isPending` lambda 与 `App.tsx` 明细弹窗判定。
 */
export function isPendingFor(
  app: PendingRow,
  confirmed?: ReadonlySet<string>,
): boolean {
  return isPlatformPending(app, confirmed);
}

/**
 * 统一平台过滤（含 pending 恒可见）：pending 行不看 Other 勾选直接放行，
 * 落定后走正常 `matchPlatformSet`。未传确认集时退化为纯平台匹配（旧行为）。
 */
export function matchSelectedWithPending(
  app: PendingRow,
  selected: ReadonlySet<string>,
  confirmed?: ReadonlySet<string>,
): boolean {
  return matchPlatformSetWithPending(app, selected, confirmed);
}

/**
 * 趋势未收录行 pending 判定（目录/富卡/裸行三处同口径）：
 * - 无 enrich（裸行）：未确认即 pending，恒可见；
 * - 有 enrich 且具真实平台：已落定；
 * - 有 enrich 但空：坐标键或 id 别名任一已确认即落定，否则 pending。
 */
export function isEnrichedRowPending(
  repoKeyLower: string,
  enriched: PendingRow | undefined,
  combined: ReadonlySet<string>,
): boolean {
  if (!enriched) return !combined.has(repoKeyLower);
  if (enriched.platforms && enriched.platforms.length > 0) return false;
  const alias = typeof enriched.id === 'string' ? enriched.id.trim().toLowerCase() : '';
  if (combined.has(repoKeyLower)) return false;
  if (alias !== '' && combined.has(alias)) return false;
  return true;
}

/**
 * confirmed 并集（全局 ∪ 榜单内，跳过缺席集合；保序去重）。
 * 替代 `TrendsView` 内联 union memo 与各处手动合并。
 */
export function unionConfirmedSets(
  ...sets: readonly (ReadonlySet<string> | undefined)[]
): Set<string> {
  const out = new Set<string>();
  for (const s of sets) {
    if (!s) continue;
    for (const k of s) out.add(k);
  }
  return out;
}

/** pending 键归一（lower-trim；空串表示无效调用方自行跳过）。 */
export function normalizePendingKey(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/* ------------------------------------------------------------------ */
/* inflight 守卫：在途集合（同键不重复发起，落定即释放）                */
/* ------------------------------------------------------------------ */

export interface InflightGuard {
  has(key: string): boolean;
  /** 快照当前在途键（供目标选择时跳过在途；选择后仍须经 `take` 认领防竞态）。 */
  snapshot(): Set<string>;
  /** 批量认领：跳过已在途，返回本次新认领的键（保序去重）。 */
  take(keys: readonly string[]): string[];
  release(keys: readonly string[]): void;
  clear(): void;
  readonly size: number;
}

/** 在途守卫工厂（调用方经 `useRef` 持稳；纯内存，无 React 依赖，可单测）。 */
export function createInflightGuard(): InflightGuard {
  const inflight = new Set<string>();
  return {
    has: (key: string) => inflight.has(key),
    snapshot: () => new Set(inflight),
    take: (keys: readonly string[]) => {
      const taken: string[] = [];
      const seen = new Set<string>();
      for (const raw of keys) {
        const k = normalizePendingKey(raw);
        if (!k || seen.has(k) || inflight.has(k)) continue;
        seen.add(k);
        inflight.add(k);
        taken.push(k);
      }
      return taken;
    },
    release: (keys: readonly string[]) => {
      for (const raw of keys) inflight.delete(normalizePendingKey(raw));
    },
    clear: () => inflight.clear(),
    get size() {
      return inflight.size;
    },
  };
}

/* ------------------------------------------------------------------ */
/* seq 守卫：切榜/重搜时旧在途落定直接丢弃，不阻塞首绘                 */
/* ------------------------------------------------------------------ */

export interface SeqGuard {
  /** 快照当前 seq（发起时调用）。 */
  capture(): number;
  /** 快照是否已过期（落定时调用）。 */
  isStale(captured: number): boolean;
}

/**
 * seq 守卫工厂：`readCurrent` 指向调用方拥有的计数器
 * （App 侧为搜索 seq ref，趋势侧为榜单 seq ref；计数器归调用方，守卫模式归本模块）。
 */
export function createSeqGuard(readCurrent: () => number): SeqGuard {
  return {
    capture: () => readCurrent(),
    isStale: (captured: number) => readCurrent() !== captured,
  };
}

/* ------------------------------------------------------------------ */
/* lite 批量：分批 5、上限 20（cap 由目标选择处切片，本处再守一次）     */
/* ------------------------------------------------------------------ */

/** lite 通道取数形态（与 `getPlatformsLite` 回包对齐）。 */
export type LiteFetch = (liteId: string) => Promise<PendingLiteResult | null | undefined>;

/**
 * lite 批量确认唯一实现（分批 5，超 `LITE_TARGET_CAP` 截断；stale/失败保持 pending 交 settle 兜底）。
 * `lib.resolvePendingPlatformsLite` 的深模块薄包：调用方（主列表/榜单）经此同一口。
 */
export async function runLiteBatch(
  targets: readonly PendingLiteTarget[],
  fetchLite: LiteFetch,
  shouldAbort?: () => boolean,
): Promise<{ patched: Map<string, string[]>; confirmedEmpty: string[] }> {
  return resolvePendingPlatformsLite(targets.slice(0, LITE_TARGET_CAP), fetchLite, shouldAbort);
}

/** 主列表 lite 目标选择：空平台 + 未确认 + 非在途，取前 `cap`（默认 20）。 */
export function selectListLiteTargets(
  summaries: readonly PendingRow[],
  opts: { resolved: ReadonlySet<string>; inflight: Pick<InflightGuard, 'has'>; cap?: number },
): { key: string; liteId: string }[] {
  const cap = opts.cap ?? LITE_TARGET_CAP;
  const out: { key: string; liteId: string }[] = [];
  for (const s of summaries) {
    if (s.platforms && s.platforms.length > 0) continue;
    const key = normalizePendingKey((s as { id?: unknown }).id);
    if (!key || opts.resolved.has(key) || opts.inflight.has(key)) continue;
    out.push({ key, liteId: typeof (s as { id?: unknown }).id === 'string' ? String((s as { id?: string }).id) : key });
    if (out.length >= cap) break;
  }
  return out;
}

/** 主列表 pending 快照：多列表去重合并，跳过具平台与已确认（含空集合启用 pending 语义）。 */
export function collectListPendingKeys(
  lists: readonly (readonly PendingRow[])[],
  resolved: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const s of list) {
      if (s.platforms && s.platforms.length > 0) continue;
      const key = normalizePendingKey((s as { id?: unknown }).id);
      if (!key || seen.has(key) || resolved.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* settle 定时：15s 后仍 pending 即降级为已确认 Other（杜绝永久 pending） */
/* ------------------------------------------------------------------ */

export interface SettleSchedule {
  /** 发起时快照的 pending 键（去重保序后）。 */
  keys: string[];
  /**
   * 落定时复核：按最新状态过滤出仍 pending 的键
   * （具平台/已确认一律剔除，永不覆盖具平台）。
   */
  recheck: (keys: readonly string[]) => string[];
  /** 确认提交（仅仍 pending 非空时调用一次）。 */
  onConfirm: (stillPending: string[]) => void;
}

/**
 * settle 定时唯一实现：`PENDING_SETTLE_MS` 后复核快照，仍 pending 才确认提交；
 * 无 pending 直接返回空清理函数。返回清理函数（调用方 effect 返回，超时前卸载即取消）。
 */
export function scheduleSettleConfirm(schedule: SettleSchedule): () => void {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of schedule.keys) {
    const k = normalizePendingKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  if (keys.length === 0) return () => {};
  const timer = setTimeout(() => {
    let still: string[] = [];
    try {
      still = schedule.recheck(keys).map((k) => normalizePendingKey(k)).filter((k) => k !== '');
    } catch {
      return;
    }
    if (still.length === 0) return;
    try {
      schedule.onConfirm(still);
    } catch {
      // 确认提交失败不影响主流程（下次列表变化重排定时）
    }
  }, PENDING_SETTLE_MS);
  return () => {
    clearTimeout(timer);
  };
}
