/**
 * Pending 草稿表单折叠分节偏好模块（PendingView 从此读写 `supplemental` / `runtime` 展开状态）。
 *
 * - 存储键为点分形态：`zstore:pending.sectionPrefs`；
 * - 读取时兼容下划线别名键（`zstore:pending_section_prefs`）及字段别名 `optional`，命中即迁移写标准键。
 */

export const PENDING_SECTION_PREFS_STORAGE_KEY = 'zstore:pending.sectionPrefs';
/** 兼容读取用的存储键别名。 */
export const PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY = 'zstore:pending_section_prefs';

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

/** 表单 B/C 分节展开偏好（A 核心必填恒展开，不进持久化）。 */
interface PendingSectionPrefs {
  /** B 补充信息（默认展开）。 */
  supplemental: boolean;
  /** C 运行时与目录（默认折叠）。 */
  runtime: boolean;
}

const DEFAULT_SECTION_PREFS: PendingSectionPrefs = { supplemental: true, runtime: false };

function normalizeSectionPrefs(parsed: unknown): PendingSectionPrefs {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  // 兼容别名字段 `optional`（按 supplemental 语义解析）。
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

/** 读分节偏好：标准 key 优先，别名 key 命中则迁移写标准 key，缺省回退默认值。 */
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

/** 写分节偏好到标准 key（同步清理别名 key）。 */
export function setPendingSectionPrefs(prefs: PendingSectionPrefs): void {
  writeStored(PENDING_SECTION_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  removeStored(PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY);
}
