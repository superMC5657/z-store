/**
 * 设备平台多选过滤器（决策方案 B 语义）。
 *
 * - 空选择是有效状态，表示“不选任何平台”（各视图据此渲染平台筛选为空的引导状态）。
 * - 无论在构建还是消费选择集合时，未知平台 ID 均会被直接忽略。
 * - 单选匹配语义与 CategoriesView.matchPlatform 保持一致：
 *   若应用的 `platforms` 缺失或为空，则默认视作仅支持 Windows；
 *   所有平台比较均忽略大小写。
 */

export type PlatformId = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export const PLATFORM_IDS: readonly PlatformId[] = [
  'windows',
  'android',
  'macos',
  'linux',
  'ios',
] as const;

export const PLATFORM_META: Record<PlatformId, { label: string }> = {
  windows: { label: 'Windows' },
  android: { label: 'Android' },
  macos: { label: 'macOS' },
  linux: { label: 'Linux' },
  ios: { label: 'iOS' },
};

export interface PlatformFilterSelection {
  selectedPlatforms: ReadonlySet<PlatformId>;
  platformCounts: Readonly<Record<PlatformId, number>>;
  onTogglePlatform: (id: PlatformId) => void;
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_IDS);

function isPlatformId(value: string): value is PlatformId {
  return KNOWN_PLATFORMS.has(value);
}

export function normalizePlatform(p: string): string {
  return p.toLowerCase();
}

interface PlatformApp {
  platforms?: string[];
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
 * 若应用的 `platforms` 缺失或为空，默认计为仅 Windows。
 * 空选择集合（或仅含未知平台）时不匹配任何应用。
 */
export function matchPlatformSet(app: PlatformApp, selected: ReadonlySet<string>): boolean {
  const wanted = knownSelected(selected);
  if (wanted.size === 0) return false;
  const actual = !app.platforms || app.platforms.length === 0 ? ['windows'] : app.platforms;
  return actual.some((p) => wanted.has(normalizePlatform(p)));
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
