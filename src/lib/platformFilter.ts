/**
 * 设备平台多选过滤器（决策方案 B 语义 + 前端虚拟 Other 桶）。
 *
 * - 空选择是有效状态，表示“不选任何平台”（各视图据此渲染平台筛选为空的引导状态）。
 * - 无论在构建还是消费选择集合时，未知平台 ID 均会被直接忽略。
 * - `platforms` 缺失或为空的应用（类库等非可安装应用，后端保持 `[]` 不打标）
 *   归入前端虚拟 `other` 桶：仅当选中 `other` 时匹配。`other` 纯前端存在，
 *   从不经过 IPC，也从不参与安装目标匹配。
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

interface PlatformApp {
  id?: string;
  platforms?: string[];
}

/** 平台列表是否为空（缺失或空数组即视为空，后端保持 `[]` 不打标）。 */
export function isPlatformEmpty(app: PlatformApp): boolean {
  return !app.platforms || app.platforms.length === 0;
}

/** 小写归一的应用 id（缺失返回空串）。 */
export function normalizeAppId(id: unknown): string {
  return typeof id === 'string' ? id.toLowerCase() : '';
}

/**
 * 待确认态判定：summary 为空且尚未经详情确认。
 * - `resolvedOtherIds` 缺席时沿用旧语义（空即视为已确认 other，不产生 pending），
 *   保证纯函数单测与未接入追踪的调用方零变化。
 * - 传入集合（含空集合）时，空 + 未在集合中即为 pending（含在途与尚未发起），
 *   空 + 已在集合中即为已确认 other。
 */
export function isPlatformPending(
  app: PlatformApp,
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
  app: PlatformApp,
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
  app: PlatformApp,
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
export function matchPlatformSet(app: PlatformApp, selected: ReadonlySet<string>): boolean {
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
