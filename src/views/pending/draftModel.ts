/** 待收录草稿领域纯函数与类型：负责表单校验、协议归一与分组判定。 */
import type { TFunction } from 'i18next';
import type { AppSummary } from '../../types';
import {
  itemToSummary,
  type DraftEntry,
  type DraftItem,
  type DraftStatus,
} from '../../services/custom';
import { isCollectedStatus } from '../../app/selectors';
import type { LicenseAllowlistResult } from '../../services/api/catalog';

/** 草稿领域形状（唯一定义见 `services/custom.ts`）。 */
export type PendingDraftItem = DraftItem;

/** 草稿状态（`local_collected` 与 `collected` 同义）。 */
type PendingDraftStatus = DraftStatus;

/** 视图条目 = 草稿领域形状（唯一定义见 `services/custom.ts`）。 */
export type CustomDraftEntry = DraftEntry;

/** 待收录页四个互斥顶层 Tab：草稿 / 待提交 / 已提交 / 已归档。 */
export type PendingGroupId = 'draft' | 'to_submit' | 'submitted' | 'archived';

/** Tab 渲染顺序，也是首次进入时智能默认落点的优先顺序。 */
export const PENDING_GROUP_ORDER: readonly PendingGroupId[] = ['draft', 'to_submit', 'submitted', 'archived'];

/** 收录态判定唯一口径收敛于 selectors。 */
export const isPendingCollectedStatus = isCollectedStatus;

/** 将待收录草稿转为富卡摘要投影。 */
export function pendingDraftToAppSummary(
  item: PendingDraftItem,
  status: PendingDraftStatus,
  archived?: boolean,
): AppSummary & { status: string; archived?: boolean } {
  return itemToSummary(item, status, archived);
}

/** 按当前语言选择待收录草稿简介（主语言为空时回退另一语言，均为空返回空串）。 */
export function resolvePendingDraftDescription(
  item: Pick<PendingDraftItem, 'description' | 'description_en'>,
  language?: string,
): string {
  const zh = item.description.trim();
  const en = item.description_en.trim();
  const isEn = typeof language === 'string' && language.toLowerCase().startsWith('en');
  if (isEn) return en || zh;
  return zh || en;
}

export const PENDING_OFFICIAL_CATEGORIES = [
  'system',
  'network',
  'media',
  'security',
  'dev',
  'graphics',
  'office',
  'reading',
  'ops',
  'games',
] as const;

type PendingOfficialCategory = (typeof PENDING_OFFICIAL_CATEGORIES)[number];

export const PENDING_EMPTY_DRAFT: PendingDraftItem = {
  id: '',
  name: '',
  owner: '',
  repo: '',
  icon: '',
  icon_bg: '',
  description: '',
  description_en: '',
  category: 'dev',
  category_name: '',
  aliases: [],
  default_version: 'v0.1.0',
  license: 'MIT',
  homepage: '',
  install_dirs: [],
  search_subdirs: [],
  publishers: [],
  platforms: ['windows'],
  identifiers: {},
};

/** 按后端同口径规范化开源协议字符串（空格/下划线转 `-`，尾部 `+` 转为 `-OR-LATER`）。 */
export function normalizeLicense(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[ _]/g, '-');
  if (s.endsWith('+')) {
    s = s.slice(0, -1);
    if (!s.endsWith('-OR-LATER')) s += '-OR-LATER';
  }
  return s;
}

/** 后端许可名单快照输入；`null`/`undefined` 表示尚未加载（不回退本地写死名单）。 */
export type LicenseAllowlistInput =
  | LicenseAllowlistResult
  | readonly string[]
  | Set<string>
  | null
  | undefined;

/** 判断协议是否命中许可名单（fail-closed：名单缺席一律返回 false）。 */
export function isOsiApprovedLicense(license: string, allowlist: LicenseAllowlistInput): boolean {
  const norm = normalizeLicense(license);
  if (!norm) return false;
  if (allowlist === null || allowlist === undefined) return false;
  const entries: Iterable<string> = Array.isArray(allowlist) || allowlist instanceof Set
    ? allowlist
    : (allowlist as LicenseAllowlistResult).allowed;
  for (const candidate of entries) {
    if (typeof candidate === 'string' && normalizeLicense(candidate) === norm) return true;
  }
  return false;
}

/** 由 owner/repo 推导 canonical id（小写 owner/repo）。 */
export function canonicalDraftId(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export type PendingDraftErrors = Partial<Record<'id' | 'name' | 'owner' | 'repo' | 'description' | 'category' | 'homepage' | 'license', string>>;

/** 校验档位：`draft` 仅校验身份坐标，`submit` 进行全量与许可名单校验。 */
type PendingValidateMode = 'draft' | 'submit';

/** 全字段校验草稿；`submit` 档缺少许可名单时返回 `license_gate_unavailable`。 */
export function validatePendingDraft(
  item: PendingDraftItem,
  mode: PendingValidateMode = 'submit',
  gate?: LicenseAllowlistInput,
): PendingDraftErrors {
  const errors: PendingDraftErrors = {};
  if (!item.owner.trim() || !item.repo.trim()) {
    if (!item.owner.trim()) errors.owner = 'owner_required';
    if (!item.repo.trim()) errors.repo = 'repo_required';
  } else {
    const expected = canonicalDraftId(item.owner, item.repo);
    const actual = item.id.trim();
    if (!actual) {
      errors.id = 'id_required';
    } else if (actual !== expected || actual !== actual.toLowerCase()) {
      errors.id = 'id_mismatch';
    }
    if (item.owner.includes('/') || item.repo.includes('/')) {
      errors.owner = errors.owner ?? 'coord_slash';
    }
    // 与 Rust 同口径：坐标不可含空白（否则 id 归一后与 owner/repo 失配）。
    if (/\s/.test(item.owner) || /\s/.test(item.repo)) {
      errors.owner = errors.owner ?? 'coord_whitespace';
    }
  }
  if (mode === 'draft') return errors;
  if (!item.name.trim()) errors.name = 'name_required';
  if (!item.description.trim()) errors.description = 'description_required';
  const category = item.category.trim();
  if (!category) {
    errors.category = 'category_required';
  } else if (!PENDING_OFFICIAL_CATEGORIES.includes(category as PendingOfficialCategory)) {
    errors.category = 'category_invalid';
  }
  const homepage = item.homepage.trim();
  if (!homepage) {
    errors.homepage = 'homepage_required';
  } else if (!homepage.startsWith('http://') && !homepage.startsWith('https://')) {
    errors.homepage = 'homepage_scheme';
  }
  const license = item.license.trim();
  if (!license) {
    errors.license = 'license_required';
  } else if (gate === undefined || gate === null) {
    errors.license = 'license_gate_unavailable';
  } else {
    const enabled =
      Array.isArray(gate) || gate instanceof Set
        ? true
        : (gate as LicenseAllowlistResult).enabled !== false;
    if (enabled && !isOsiApprovedLicense(license, gate)) {
      errors.license = 'license_osi';
    }
  }
  return errors;
}

export function splitCsv(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** identifiers 文本形态：每行 `platform=exe1, exe2`。 */
export function parseIdentifiersText(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    out[key] = splitCsv(t.slice(eq + 1));
  }
  return out;
}

export function stringifyIdentifiers(ids: Record<string, string[]>): string {
  return Object.entries(ids).map(([k, v]) => `${k}=${v.join(', ')}`).join('\n');
}

export function entryGroup(e: CustomDraftEntry): PendingGroupId {
  // 归档优先（权威已交给远端）；submitted 单列；收录系归待提交；其余（draft/未知）归草稿。
  if (e.archived) return 'archived';
  if (e.status === 'submitted') return 'submitted';
  if (isPendingCollectedStatus(e.status)) return 'to_submit';
  return 'draft';
}

/** submitted（已提交）判定：已归档行恒视为只读归档，不视为待合入 submitted。 */
export function isSubmittedEntry(e: CustomDraftEntry): boolean {
  return !e.archived && e.status === 'submitted';
}

/** 校验错误码 → 当前语言文案（缺键回退错误码本身）。 */
export function errorText(t: TFunction, code: string): string {
  return t(`pending.errors.${code}`, code);
}
