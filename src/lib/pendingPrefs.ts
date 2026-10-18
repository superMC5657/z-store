/**
 * Pending 草稿盒偏好共享模块（P1 视图解耦：PendingView 与 SettingsView/AppearanceSection 均从此 import）。
 *
 * - 存储键统一为点分形态（P2）：`zstore:pending.showCoords` / `zstore:pending.sectionPrefs`，
 *   事件 `zstore:pending.showCoordsChanged`；读时兼容旧下划线/横杠 key，命中旧值即迁移写新 key。
 * - 文案键（`settings.pending_coords_*`）保持不变，只改底层 storage key。
 */

export const PENDING_SHOW_COORDS_STORAGE_KEY = 'zstore:pending.showCoords';
/** 旧键：仅迁移读取用，新写入不再使用。 */
export const PENDING_SHOW_COORDS_STORAGE_KEY_LEGACY = 'zstore:pending_show_coords';

export const PENDING_SECTION_PREFS_STORAGE_KEY = 'zstore:pending.sectionPrefs';
/** 旧键：仅迁移读取用，新写入不再使用。 */
export const PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY = 'zstore:pending_section_prefs';

/** 坐标显隐变更事件（新）。 */
export const PENDING_SHOW_COORDS_EVENT = 'zstore:pending.showCoordsChanged';
/** 旧事件名：仅监听兼容用，新写入只发新事件。 */
export const PENDING_SHOW_COORDS_EVENT_LEGACY = 'zstore:pending-show-coords-changed';

function readStored(key: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch {
    // localStorage 不可用时回退默认值
  }
  return null;
}

function writeStored(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // 持久化失败静默忽略（预览/隐私模式）
  }
}

function removeStored(key: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 忽略
  }
}

/** 仓库坐标与标识显隐（默认显示）。读旧 key 命中则迁移写新 key。 */
export function getPendingShowCoordsPref(): boolean {
  const fresh = readStored(PENDING_SHOW_COORDS_STORAGE_KEY);
  if (fresh !== null) return fresh === 'true';
  const legacy = readStored(PENDING_SHOW_COORDS_STORAGE_KEY_LEGACY);
  if (legacy !== null) {
    writeStored(PENDING_SHOW_COORDS_STORAGE_KEY, legacy);
    return legacy === 'true';
  }
  return true;
}

/** 写入新 key 并广播新事件（顺手清理旧 key，避免双源分歧）。 */
export function setPendingShowCoordsPref(show: boolean): void {
  writeStored(PENDING_SHOW_COORDS_STORAGE_KEY, String(show));
  removeStored(PENDING_SHOW_COORDS_STORAGE_KEY_LEGACY);
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PENDING_SHOW_COORDS_EVENT, { detail: { show } }));
    }
  } catch {
    // 非浏览器环境忽略
  }
}

/** 表单 B/C 分节展开偏好（A 核心必填恒展开，不进持久化）。 */
export interface PendingSectionPrefs {
  /** B 补充信息（默认展开）。 */
  supplemental: boolean;
  /** C 运行时与目录（默认折叠）。 */
  runtime: boolean;
}

export const DEFAULT_SECTION_PREFS: PendingSectionPrefs = { supplemental: true, runtime: false };

function normalizeSectionPrefs(parsed: unknown): PendingSectionPrefs {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  // 兼容旧字段名 `optional`（读到即按 supplemental 语义吸收）。
  const supplemental =
    typeof obj.supplemental === 'boolean'
      ? obj.supplemental
      : typeof obj.optional === 'boolean'
        ? obj.optional
        : DEFAULT_SECTION_PREFS.supplemental;
  const runtime = typeof obj.runtime === 'boolean' ? obj.runtime : DEFAULT_SECTION_PREFS.runtime;
  return { supplemental, runtime };
}

function parseSectionPrefs(raw: string | null): PendingSectionPrefs | null {
  if (!raw) return null;
  try {
    return normalizeSectionPrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 读分节偏好：新 key 优先，旧 key 命中则迁移写新 key，缺省回退默认值。 */
export function getPendingSectionPrefs(): PendingSectionPrefs {
  const fresh = parseSectionPrefs(readStored(PENDING_SECTION_PREFS_STORAGE_KEY));
  if (fresh) return fresh;
  const legacy = parseSectionPrefs(readStored(PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY));
  if (legacy) {
    setPendingSectionPrefs(legacy);
    return legacy;
  }
  return { ...DEFAULT_SECTION_PREFS };
}

/** 写分节偏好到新 key（顺手清理旧 key）。 */
export function setPendingSectionPrefs(prefs: PendingSectionPrefs): void {
  writeStored(PENDING_SECTION_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  removeStored(PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY);
}
