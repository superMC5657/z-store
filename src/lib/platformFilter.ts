/**
 * 设备平台多选过滤器（决策方案 B 语义 + 前端虚拟 Other 桶）。
 *
 * - 空选择是有效状态，表示“不选任何平台”（各视图据此渲染平台筛选为空的引导状态）。
 * - 无论在构建还是消费选择集合时，未知平台 ID 均会被直接忽略。
 * - `platforms` 缺失或为空的应用（类库等非可安装应用，后端保持 `[]` 不打标）
 *   归入前端虚拟 `other` 桶：仅当选中 `other` 时匹配。`other` 纯前端存在，
 *   从不经过 IPC，也从不参与安装目标匹配。
 *
 * ica3-3：pending 生命周期深模块收归于此（唯一深模块）。
 * 收编：inflight 集合 + seq 守卫 + lite 批量（5/批、上限 20）+ settle 定时（15s）
 * + confirmed 并集 + 键归一唯一实现 + 主列表目标选择/快照 + 趋势富卡行判定。
 * `services/pendingLifecycle` 降为声明式兼容外观（重导出，无实现），
 * `app/selectors` 经单 seam 直引本模块，不再经服务中转。
 */

export type PlatformId = 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other';

/** 渲染顺序即侧栏宫格顺序：5 端 + 其他（3+2 → 3+3 两排）。 */
export const PLATFORM_IDS: readonly PlatformId[] = [
  'windows',
  'macos',
  'linux',
  'ios',
  'android',
  'other',
] as const;

export const PLATFORM_META: Record<PlatformId, { label: string }> = {
  windows: { label: 'Windows' },
  macos: { label: 'macOS' },
  linux: { label: 'Linux' },
  ios: { label: 'iOS' },
  android: { label: 'Android' },
  // 兜底文案（英文 proper-noun 无需翻译）；侧栏实际经 i18n 取“其他 / Other”。
  other: { label: '其他' },
};

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

function isPlatformId(value: string): value is PlatformId {
  return KNOWN_PLATFORMS.has(value);
}

export function normalizePlatform(p: string): string {
  return p.toLowerCase();
}

/** 待确认判定的最小行形态（`AppSummary`/`AppDetail` 均满足；本模块唯一行形态）。 */
export interface PendingRow {
  id?: string;
  platforms?: string[];
}

/** 平台列表是否为空（缺失或空数组即视为空，后端保持 `[]` 不打标）。 */
export function isPlatformEmpty(app: PendingRow): boolean {
  return !app.platforms || app.platforms.length === 0;
}

/** pending 键归一（lower-trim；空串表示无效，调用方自行跳过）。全模块键归一唯一实现。 */
export function normalizePendingKey(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/** 小写归一的应用 id（缺失返回空串；与 pending 键同口径，经唯一实现）。 */
export function normalizeAppId(id: unknown): string {
  return normalizePendingKey(id);
}

/**
 * 待确认态判定：summary 为空且尚未经详情确认。
 * - `resolvedOtherIds` 缺席时沿用旧语义（空即视为已确认 other，不产生 pending），
 *   保证纯函数单测与未接入追踪的调用方零变化。
 * - 传入集合（含空集合）时，空 + 未在集合中即为 pending（含在途与尚未发起），
 *   空 + 已在集合中即为已确认 other。
 */
export function isPlatformPending(
  app: PendingRow,
  resolvedOtherIds?: ReadonlySet<string>,
): boolean {
  if (!isPlatformEmpty(app)) return false;
  if (!resolvedOtherIds) return false;
  const key = normalizeAppId(app.id);
  if (!key) return true;
  return !resolvedOtherIds.has(key);
}

/** 已确认 other：为空且已有详情背书（无追踪集合时空即视为已确认，保持旧语义）。 */
export function isConfirmedOther(
  app: PendingRow,
  resolvedOtherIds?: ReadonlySet<string>,
): boolean {
  if (!isPlatformEmpty(app)) return false;
  if (!resolvedOtherIds) return true;
  const key = normalizeAppId(app.id);
  if (!key) return false;
  return resolvedOtherIds.has(key);
}

/**
 * 待确认行过滤：pending 行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
 * 未传入追踪集合时直接退化为 matchPlatformSet（旧行为）。
 */
export function matchPlatformSetWithPending(
  app: PendingRow,
  selected: ReadonlySet<string>,
  resolvedOtherIds?: ReadonlySet<string>,
): boolean {
  if (resolvedOtherIds && isPlatformPending(app, resolvedOtherIds)) return true;
  return matchPlatformSet(app, selected);
}

/** 从传入的选择集合中仅保留已知的规范化平台 ID。 */
function knownSelected(selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of selected) {
    const n = normalizePlatform(id);
    if (KNOWN_PLATFORMS.has(n)) out.add(n);
  }
  return out;
}

/**
 * 当应用支持至少一个已选中的已知平台时返回 true。
 * `platforms` 缺失或为空（类库等非可安装应用）仅归入虚拟 `other` 桶；
 * 未知平台字符串不匹配任何桶。
 * 空选择集合（或仅含未知平台）时不匹配任何应用。
 */
export function matchPlatformSet(app: PendingRow, selected: ReadonlySet<string>): boolean {
  const wanted = knownSelected(selected);
  if (wanted.size === 0) return false;
  if (!app.platforms || app.platforms.length === 0) return wanted.has('other');
  return app.platforms.some((p) => wanted.has(normalizePlatform(p)));
}

/**
 * 在选择集合中切换某个平台的状态。空选择为有效状态，表示不选任何平台。
 * 若传入未知平台 ID，则原样返回副本。
 */
export function togglePlatformSet(prev: ReadonlySet<PlatformId>, id: string): Set<PlatformId> {
  const n = normalizePlatform(id);
  const next = new Set<PlatformId>();
  for (const entry of prev) {
    const normalized = normalizePlatform(entry);
    if (isPlatformId(normalized)) next.add(normalized);
  }
  if (!isPlatformId(n)) return next;
  if (next.has(n)) {
    next.delete(n);
  } else {
    next.add(n);
  }
  return next;
}

/**
 * 将持久化选择结果（已解码的字符串数组）解析为已知平台 ID 集合。
 * 空数组 / 仅未知项 / null / undefined 均解析为空 Set（绝不回退至全选），
 * 确保 `[]` 能完整往返持久化。
 *
 * 注意：此函数与 `src/App.tsx` 中的 `parseSelectedPlatforms` 有所区别——
 * 后者接收原始 localStorage 字符串（string | null | undefined），并在缺失或损坏时回退至全选集合；
 * 而本数组版本从不回退，null 即表示空选择。
 */
export function parseSelectedPlatformArray(input: readonly string[] | null | undefined): Set<PlatformId> {
  const out = new Set<PlatformId>();
  if (input === null || input === undefined) return out;
  for (const raw of input) {
    const n = normalizePlatform(raw);
    if (isPlatformId(n)) out.add(n);
  }
  return out;
}

/**
 * 待确认落定超时：lite 不可用/stale/失败的行至多等待此后降级为已确认 Other，
 * 而非无限 shimmer。待确认期间行恒可见，落定后走正常 Other 过滤/计数/徽标。
 * App 主列表与 Trends 榜单共用同一超时（TrendsView 经 `TREND_PENDING_SETTLE_MS` 重导出保持兼容）。
 */
export const PENDING_SETTLE_MS = 15_000;

/** lite 通道分批大小（与 `resolvePendingPlatformsLite` 内步长同源）。 */
export const LITE_BATCH_SIZE = 5;
/** lite 单次目标上限（App 列表与趋势榜单同值，调用方切片前 20）。 */
export const LITE_TARGET_CAP = 20;

/** lite 批量确认的目标行（key 为小写归一 id，liteId 为取数用原始 id）。 */
export interface PendingLiteTarget {
  key: string;
  liteId: string;
}

/** lite 通道返回（与 `getPlatformsLite` 对齐：stale 即无权威，空非 stale 即已确认）。 */
export interface PendingLiteResult {
  platforms?: readonly string[] | null;
  is_stale?: boolean | null;
}

/**
 * 待确认行 lite 批量确认的唯一实现（App 主列表与 Trends 榜单共用，杜绝第三份拷贝）。
 * 分批 5、上限由调用方切片（约定 20），批次间检查 `shouldAbort` 即整批丢弃。
 * stale/失败/异常一律保持 pending（既不治愈也不确认，交由 settle 超时兜底）；
 * 非空治愈进 `patched`，空非 stale 进 `confirmedEmpty`。
 */
export async function resolvePendingPlatformsLite(
  targets: readonly PendingLiteTarget[],
  fetchLite: (liteId: string) => Promise<PendingLiteResult | null | undefined>,
  shouldAbort?: () => boolean,
): Promise<{ patched: Map<string, string[]>; confirmedEmpty: string[] }> {
  const patched = new Map<string, string[]>();
  const confirmedEmpty: string[] = [];
  for (let i = 0; i < targets.length; i += 5) {
    if (shouldAbort?.()) return { patched: new Map(), confirmedEmpty: [] };
    const batch = targets.slice(i, i + 5);
    const settled = await Promise.all(
      batch.map(async (t) => {
        try {
          const d = await fetchLite(t.liteId);
          if (!d || d.is_stale) {
            return { key: t.key, platforms: undefined as string[] | undefined, empty: false };
          }
          if (d.platforms && d.platforms.length > 0) {
            return { key: t.key, platforms: [...d.platforms], empty: false };
          }
          return { key: t.key, platforms: undefined as string[] | undefined, empty: true };
        } catch {
          return { key: t.key, platforms: undefined as string[] | undefined, empty: false };
        }
      }),
    );
    for (const r of settled) {
      if (r.platforms && r.platforms.length > 0) patched.set(r.key, r.platforms);
      else if (r.empty) confirmedEmpty.push(r.key);
    }
  }
  return { patched, confirmedEmpty };
}

/* ------------------------------------------------------------------ */
/* pending 生命周期（ica3-3 自 `services/pendingLifecycle` 收编，语义逐字一致） */
/* ------------------------------------------------------------------ */

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
 * 调用方（主列表/榜单）经此同一口。
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
