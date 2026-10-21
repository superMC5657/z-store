/**
 * 待收录草稿领域模型（纯函数与类型，无 React）：
 * 从 PendingView 拆出的校验/归一/分组判定单一实现；
 * PendingView 保留同名重导出，既有调用方与测试 import 不需迁移。
 */
import type { AppSummary } from '../../types';
import type { DraftEntry, DraftItem, DraftStatus } from '../../services/custom/types';
import { itemToSummary } from '../../services/custom/mappers';
import { isCollectedStatus, isLocalLibraryStatus } from '../../app/selectors';
import type { LicenseAllowlistResult } from '../../services/api/catalog';

export type { LicenseAllowlistResult };

/** 草稿领域形状（唯一定义见 `services/custom/types.ts`）。 */
export type PendingDraftItem = DraftItem;

/** 草稿状态（`local_collected` 与 `collected` 同义）。 */
export type PendingDraftStatus = DraftStatus;

/** 视图条目 = 草稿领域形状（唯一定义见 `services/custom/types.ts`）。 */
export type CustomDraftEntry = DraftEntry;

export type PendingGroupId = 'draft' | 'library' | 'archived';

/**
 * 「本地收录」内部分段（Issue 进度）：全部 = 收录系 + submitted；
 * 待提交 = 收录系（collected/local_collected）；已提交 = submitted。
 */
export type PendingSegmentId = 'all' | 'to_submit' | 'submitted';

/** 收录态判定唯一口径收敛于 selectors。 */
export const isPendingCollectedStatus = isCollectedStatus;

/**
 * 待收录草稿转富卡展示态（collected/submitted/archived 右侧富卡化复用 AppCard）：
 * 黄标只属于收录及其后链路（由 mappers 投影决定，草稿无 source）；
 * 投影唯一口径在 `services/custom/mappers`。
 */
export function pendingDraftToAppSummary(
  item: PendingDraftItem,
  status: PendingDraftStatus,
  archived?: boolean,
): AppSummary & { status: string; archived?: boolean } {
  return itemToSummary(item, status, archived);
}

/**
 * 待收录草稿简介按当前语言取展示文案（列表/富卡预览/空态共用）：
 * - 英文环境优先 description_en，非中文环境外优先 description；
 * - 主语言为空回退另一语言，两空返回 ''（调用方以 trends.no_desc 兜底，不新增文案）；
 * - 仅 trim 判空，不改表单两框可编辑性。
 */
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

/**
 * 协议归一（与后端 `normalize_license` 逐字符同口径）：去首尾空白 → 大写 →
 * 每个空格/下划线单独折 `-`（连续空白因此各出一个 `-`，不做 run 折叠）→
 * 尾 `+` 视为或后续版本。
 */
export function normalizeLicense(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[ _]/g, '-');
  if (s.endsWith('+')) {
    s = s.slice(0, -1);
    if (!s.endsWith('-OR-LATER')) s += '-OR-LATER';
  }
  return s;
}

/**
 * 后端许可名单输入（经 `get_license_allowlist` 拉取的唯一源头）：
 * 完整快照、纯名单数组（视为门禁开）、`Set` 均可；`null/undefined` 表示
 * 名单未加载——调用方不得回退写死名单（提交提示重试，暂存直接放行）。
 */
export type LicenseAllowlistInput =
  | LicenseAllowlistResult
  | readonly string[]
  | Set<string>
  | null
  | undefined;

/**
 * 名单命中判定（SubmitStrict license 口径）：两侧均经 `normalizeLicense`
 * 归一后比对，大小写/空格形态同样命中。名单缺席一律不命中（fail-closed，
 * 调用方在提交前先保证已加载，加载失败走重试提示）。
 */
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

/**
 * 草稿校验档位（与后端 `ValidateMode` 同语义）：
 * - `draft`：暂存档，仅校验身份（`id==canonical` 且与 `owner/repo` 对齐）；
 *   `license` 占位/空 `homepage`/不完整字段均放行，不触许可名单；
 * - `submit`：提交档，全量校验（必填 + `homepage` http(s) + 许可名单 D1），
 *   名单取后端 `get_license_allowlist` 快照。
 */
export type PendingValidateMode = 'draft' | 'submit';

/**
 * 草稿全字段校验（与后端 `validate_custom_item` 同口径的 UI 镜像）：
 * 暂存松（身份即可）、提交严（另查必填/homepage/license 名单）。
 * 提交档缺名单时报 `license_gate_unavailable`（fail-closed，不回退写死名单；
 * 组件侧加载失败直接提示重试，不会走到此处）。
 */
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
  if (!item.category.trim()) errors.category = 'category_required';
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
  // 归档优先（权威已交给远端）；库内成员 = collected 系 + submitted，其余（draft/未知）归草稿。
  if (e.archived) return 'archived';
  if (isLocalLibraryStatus(e.status)) return 'library';
  return 'draft';
}

/** 库内行的 Issue 进度分段；非库内行返回 null（不参与分段过滤）。 */
export function entrySegment(e: CustomDraftEntry): Exclude<PendingSegmentId, 'all'> | null {
  if (e.archived) return null;
  if (e.status === 'submitted') return 'submitted';
  if (isPendingCollectedStatus(e.status)) return 'to_submit';
  return null;
}

/** submitted（已提交）判定：归档行优先只读，不再按 submitted 处理。 */
export function isSubmittedEntry(e: CustomDraftEntry): boolean {
  return !e.archived && e.status === 'submitted';
}
