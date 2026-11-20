/**
 * 设备平台多选过滤器与平台 loading 生命周期管理。
 * 空选择为有效状态（不选任何平台）；缺失或空 `platforms` 归入前端虚拟 `other` 桶。
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

/** 平台展示名列表（大小写不敏感，未知平台原样保留），如 `Windows, macOS, Linux`；用于纯图标平台标签的提示文案。 */
export function formatPlatformLabels(platforms: readonly string[]): string {
  return platforms
    .map((p) => PLATFORM_META[p.toLowerCase() as PlatformId]?.label || p)
    .join(', ');
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

function isPlatformId(value: string): value is PlatformId {
  return KNOWN_PLATFORMS.has(value);
}

export function normalizePlatform(p: string): string {
  return p.toLowerCase();
}

/** 加载中判定的最小行形态（`AppSummary`/`AppDetail` 均满足；本模块唯一行形态）。 */
interface LoadingRow {
  id?: string;
  platforms?: string[];
}

/** 平台列表是否为空（缺失或空数组即视为空，后端保持 `[]` 不打标）。 */
function isPlatformEmpty(app: LoadingRow): boolean {
  return !app.platforms || app.platforms.length === 0;
}

/** loading 键归一（lower-trim；空串表示无效，调用方自行跳过）。全模块键归一唯一实现。
 * 应用 id 归一请直用 `services/normalizeId`（后端 canonical 为准，与本键同值）。 */
export function normalizeLoadingKey(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/** 判定 summary 平台为空且尚未确认归属的 loading 状态。 */
export function isPlatformLoading(
  app: LoadingRow,
  resolvedOtherIds: ReadonlySet<string>,
): boolean {
  if (!isPlatformEmpty(app)) return false;
  const key = normalizeLoadingKey(app.id);
  if (!key) return true;
  return !resolvedOtherIds.has(key);
}

/**
 * 加载中行过滤：loading 行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
 */
export function matchPlatformSetWithLoading(
  app: LoadingRow,
  selected: ReadonlySet<string>,
  resolvedOtherIds: ReadonlySet<string>,
): boolean {
  if (isPlatformLoading(app, resolvedOtherIds)) return true;
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

/** 应用支持至少一个已选平台时返回 true；空 `platforms` 仅匹配 `other` 桶。 */
export function matchPlatformSet(app: LoadingRow, selected: ReadonlySet<string>): boolean {
  const wanted = knownSelected(selected);
  if (wanted.size === 0) return false;
  if (!app.platforms || app.platforms.length === 0) return wanted.has('other');
  return app.platforms.some((p) => wanted.has(normalizePlatform(p)));
}

/** 切换平台选中状态；未知平台 ID 时返回原集合副本。 */
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

/** 将字符串数组解析为已知平台集合；null/undefined 或空数组均返回空 Set（不回退全选）。 */
export function parseSelectedPlatformArray(input: readonly string[] | null | undefined): Set<PlatformId> {
  const out = new Set<PlatformId>();
  if (input === null || input === undefined) return out;
  for (const raw of input) {
    const n = normalizePlatform(raw);
    if (isPlatformId(n)) out.add(n);
  }
  return out;
}

/** loading 落定超时：超时后仍未获平台信息则降级为已确认 Other，避免无限 shimmer。 */
export const LOADING_SETTLE_MS = 15_000;

/** lite 通道分批大小（与 `resolveLoadingPlatformsLite` 内步长同源）。 */
export const LITE_BATCH_SIZE = 5;
/** lite 单次目标上限（App 列表与趋势榜单同值，调用方切片前 20）。 */
export const LITE_TARGET_CAP = 20;

/** lite 批量确认的目标行（key 为小写归一 id，liteId 为取数用原始 id）。 */
export interface LoadingLiteTarget {
  key: string;
  liteId: string;
}

/** lite 通道返回（与 `getPlatformsLite` 对齐：stale 即无权威，空非 stale 即已确认）。 */
interface LoadingLiteResult {
  platforms?: readonly string[] | null;
  is_stale?: boolean | null;
}

/** 分批调用 `fetchLite` 解析平台；stale 或失败保持 loading（交由 settle 超时兜底）。 */
async function resolveLoadingPlatformsLite(
  targets: readonly LoadingLiteTarget[],
  fetchLite: (liteId: string) => Promise<LoadingLiteResult | null | undefined>,
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
/* loading 生命周期：inflight/seq 守卫、lite 批量、settle 定时归本模块。 */
/* ------------------------------------------------------------------ */

/** 判定趋势行是否仍处于平台 loading 状态。 */
export function isEnrichedRowLoading(
  repoKeyLower: string,
  enriched: LoadingRow | undefined,
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
 * confirmed 并集（全局 ∪ 榜单内，跳过缺席集合；保序去重），供榜单与列表统一复用。
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
        const k = normalizeLoadingKey(raw);
        if (!k || seen.has(k) || inflight.has(k)) continue;
        seen.add(k);
        inflight.add(k);
        taken.push(k);
      }
      return taken;
    },
    release: (keys: readonly string[]) => {
      for (const raw of keys) inflight.delete(normalizeLoadingKey(raw));
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

/** 创建 seq 守卫，用于在切榜或重搜时丢弃过期的在途结果。 */
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
export type LiteFetch = (liteId: string) => Promise<LoadingLiteResult | null | undefined>;

/** 执行 lite 批量确认（截断至 `LITE_TARGET_CAP`）；stale 或失败保持 loading。 */
export async function runLiteBatch(
  targets: readonly LoadingLiteTarget[],
  fetchLite: LiteFetch,
  shouldAbort?: () => boolean,
): Promise<{ patched: Map<string, string[]>; confirmedEmpty: string[] }> {
  return resolveLoadingPlatformsLite(targets.slice(0, LITE_TARGET_CAP), fetchLite, shouldAbort);
}

/** 主列表 lite 目标选择：空平台 + 未确认 + 非在途，取前 `cap`（默认 20）。 */
export function selectListLiteTargets(
  summaries: readonly LoadingRow[],
  opts: { resolved: ReadonlySet<string>; inflight: Pick<InflightGuard, 'has'>; cap?: number },
): { key: string; liteId: string }[] {
  const cap = opts.cap ?? LITE_TARGET_CAP;
  const out: { key: string; liteId: string }[] = [];
  for (const s of summaries) {
    if (s.platforms && s.platforms.length > 0) continue;
    const key = normalizeLoadingKey((s as { id?: unknown }).id);
    if (!key || opts.resolved.has(key) || opts.inflight.has(key)) continue;
    out.push({ key, liteId: typeof (s as { id?: unknown }).id === 'string' ? String((s as { id?: string }).id) : key });
    if (out.length >= cap) break;
  }
  return out;
}

/** 主列表 loading 快照：多列表去重合并，跳过具平台与已确认（含空集合启用 loading 语义）。 */
export function collectListLoadingKeys(
  lists: readonly (readonly LoadingRow[])[],
  resolved: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const s of list) {
      if (s.platforms && s.platforms.length > 0) continue;
      const key = normalizeLoadingKey((s as { id?: unknown }).id);
      if (!key || seen.has(key) || resolved.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* settle 定时：15s 后仍 loading 即降级为已确认 Other（杜绝永久 loading） */
/* ------------------------------------------------------------------ */

interface SettleSchedule {
  /** 发起时快照的 loading 键（去重保序后）。 */
  keys: string[];
  /** 落定时复核：仅保留仍处于 loading 的键，避免覆盖已获取到的平台。 */
  recheck: (keys: readonly string[]) => string[];
  /** 确认提交（仅仍 loading 非空时调用一次）。 */
  onConfirm: (stillLoading: string[]) => void;
}

/** 调度 settle 定时器：超时后复核快照并确认仍处于 loading 的键；返回清理函数。 */
export function scheduleSettleConfirm(schedule: SettleSchedule): () => void {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of schedule.keys) {
    const k = normalizeLoadingKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  if (keys.length === 0) return () => {};
  const timer = setTimeout(() => {
    let still: string[] = [];
    try {
      still = schedule.recheck(keys).map((k) => normalizeLoadingKey(k)).filter((k) => k !== '');
    } catch {
      return;
    }
    if (still.length === 0) return;
    try {
      schedule.onConfirm(still);
    } catch {
      // 确认提交失败不影响主流程（下次列表变化重排定时）
    }
  }, LOADING_SETTLE_MS);
  return () => {
    clearTimeout(timer);
  };
}

export const PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v2';
const PLATFORM_RESET_EVENT = 'zstore:reset-platform-filter';

/** 解析 localStorage 字符串为平台集合；仅在缺失或无效 JSON 时回退全选（有效 `[]` 保持为空）。 */
export function parseSelectedPlatforms(raw: string | null | undefined): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  if (!raw) return full;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return full;
  }
  if (!Array.isArray(parsed)) return full;
  const known = new Set<PlatformId>();
  for (const id of parsed) {
    if (typeof id !== 'string') continue;
    const n = normalizePlatform(id);
    if ((PLATFORM_IDS as readonly string[]).includes(n)) known.add(n as PlatformId);
  }
  return known;
}

/**
 * 首次渲染时读取持久化的平台选择（保证不抛错：缺失/损坏/存储异常回退至全选集合，有效空数组保持为空）。
 */
export function loadSelectedPlatforms(): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  try {
    if (typeof window === 'undefined' || !window.localStorage) return full;
    const current = window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY);
    if (current !== null) return parseSelectedPlatforms(current);
    return full;
  } catch {
    return full;
  }
}

/** 清理持久化存储并广播平台过滤器重置事件。 */
export function broadcastPlatformReset(): void {
  try {
    window.localStorage.removeItem(PLATFORM_FILTER_STORAGE_KEY);
  } catch {
    // 忽略：存储抛错时保持内存中的选择
  }
  window.dispatchEvent(new CustomEvent(PLATFORM_RESET_EVENT));
}
