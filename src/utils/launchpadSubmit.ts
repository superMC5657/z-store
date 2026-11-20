import type {
  LaunchpadEntry,
  LaunchpadPreflightResult,
  LaunchpadTier,
  OAuthUser,
} from '../types';

export const MAKER_NOTE_MAX_LENGTH = 140;

export const DEFAULT_LAUNCHPAD_SUBMIT_ISSUE_URL =
  'https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml';

export const LAUNCHPAD_CATEGORIES = [
  'dev',
  'system',
  'network',
  'media',
  'security',
  'graphics',
  'office',
  'reading',
  'ops',
  'games',
] as const;

export type LaunchpadCategoryKey = (typeof LAUNCHPAD_CATEGORIES)[number];

/** 与 `z-store-launchpad/.github/ISSUE_TEMPLATE/submit-launchpad.yml` 完全一致的分类下拉原文。 */
export const LAUNCHPAD_ISSUE_CATEGORY_OPTIONS: Readonly<Record<LaunchpadCategoryKey, string>> = {
  dev: 'dev — 开发编程 / Developer tools',
  system: 'system — 系统实用 / System utilities',
  network: 'network — 网络工具 / Networking',
  media: 'media — 影音播放 / Media',
  security: 'security — 安全加密 / Security',
  graphics: 'graphics — 图形创作 / Graphics',
  office: 'office — 办公协同 / Productivity',
  reading: 'reading — 阅读学习 / Reading',
  ops: 'ops — 运维部署 / DevOps',
  games: 'games — 休闲游戏 / Games',
};

export const LAUNCHPAD_TIERS: readonly LaunchpadTier[] = [
  'free',
  'spotlight-7d',
  'spotlight-14d',
  'spotlight-30d',
] as const;

/** 与 `submit-launchpad.yml` `launch_tier` 下拉项完全一致。 */
export const LAUNCHPAD_ISSUE_TIER_OPTIONS: Readonly<Record<LaunchpadTier, string>> = {
  free: 'free — 免费加入「最新上架」新品池 / Free listing in Recent Launches',
  'spotlight-7d': 'spotlight-7d — 申请顶部「置顶推荐」7 天赞助位 / Spotlight for 7 days',
  'spotlight-14d': 'spotlight-14d — 申请顶部「置顶推荐」14 天赞助位 / Spotlight for 14 days',
  'spotlight-30d': 'spotlight-30d — 申请顶部「置顶推荐」30 天赞助位 / Spotlight for 30 days',
};

export const CATEGORY_ZH_NAMES: Readonly<Record<LaunchpadCategoryKey, string>> = {
  dev: '开发编程',
  system: '系统实用',
  network: '网络工具',
  media: '影音播放',
  security: '安全加密',
  graphics: '图形创作',
  office: '办公协同',
  reading: '阅读学习',
  ops: '运维部署',
  games: '休闲游戏',
};

export interface MakerNoteValidation {
  ok: boolean;
  sanitized: string;
  length: number;
  hasNewline: boolean;
  error: 'empty' | 'newline' | 'too_long' | null;
}

export function unicodeLength(text: string): number {
  return [...text].length;
}

/** 单行折叠清洗：去除换行并折叠连续空白。 */
export function sanitizeMakerNote(raw: string): string {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateMakerNoteCore(
  raw: string | undefined,
  required: boolean,
): MakerNoteValidation {
  const source = String(raw ?? '');
  const hasNewline = /[\r\n]/.test(source);
  const sanitized = sanitizeMakerNote(source);
  const length = unicodeLength(source.trim());
  let error: MakerNoteValidation['error'] = null;
  if (hasNewline) error = 'newline';
  else if (required && length === 0) error = 'empty';
  else if (length > MAKER_NOTE_MAX_LENGTH) error = 'too_long';
  return { ok: error === null, sanitized, length, hasNewline, error };
}

/** 校验中文自荐语（禁止换行，去除前后空白后 1..=140 Unicode 字符）。 */
export function validateMakerNote(raw: string): MakerNoteValidation {
  return validateMakerNoteCore(raw, true);
}

/** 校验可选英文自荐语（空串合法；非空禁止换行且 ≤ 140 字符）。 */
export function validateMakerNoteEn(raw: string | undefined): {
  ok: boolean;
  sanitized: string;
  length: number;
  hasNewline: boolean;
  error: 'newline' | 'too_long' | null;
} {
  const res = validateMakerNoteCore(raw, false);
  return {
    ...res,
    error: res.error === 'empty' ? null : res.error,
  };
}

/** 校验可选自定义图标直链（空串合法；非空仅接受无空白 `https://` URL）。 */
export function validateCustomIconUrl(raw: string | undefined): {
  ok: boolean;
  clean: string;
  error: 'invalid_https' | null;
} {
  const clean = String(raw ?? '').trim();
  if (!clean) return { ok: true, clean: '', error: null };
  if (!/^https:\/\/\S+$/i.test(clean) || /\s/.test(clean)) {
    return { ok: false, clean, error: 'invalid_https' };
  }
  return { ok: true, clean, error: null };
}

export interface LaunchpadSubmitFormInput {
  repoUrl: string;
  appName: string;
  category: LaunchpadCategoryKey;
  makerNote: string;
  makerNoteEn?: string;
  launchTier: LaunchpadTier;
  customIconUrl?: string;
}

/** 将用户输入的坐标或预检结果归一化为标准 `https://<host>/<owner>/<repo>` 地址供 Issue Form 填表。 */
export function resolveIssueRepoUrl(
  rawInput: string,
  preflight?: LaunchpadPreflightResult | null,
): string {
  if (preflight && preflight.owner && preflight.repo) {
    const host = preflight.forge_host || 'github.com';
    return `https://${host}/${preflight.owner}/${preflight.repo}`;
  }
  const trimmed = rawInput.trim().replace(/^@(?![^/]*:)/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^http:\/\//i, 'https://').replace(/\.git$/i, '').replace(/\/+$/, '');
  }
  const shortMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  if (shortMatch) {
    return `https://github.com/${shortMatch[1]}/${shortMatch[2]}`;
  }
  return trimmed;
}

/** 按 `submit-launchpad.yml` 字段 ID 构造编码后的 GitHub Issue Form URL。 */
export function buildLaunchpadIssueUrl(
  baseIssueUrl: string | undefined,
  form: LaunchpadSubmitFormInput,
): string {
  const base = (baseIssueUrl ?? '').trim() || DEFAULT_LAUNCHPAD_SUBMIT_ISSUE_URL;
  const url = new URL(base);
  if (!url.searchParams.has('template')) {
    url.searchParams.set('template', 'submit-launchpad.yml');
  }
  const cleanName = form.appName.trim();
  const cleanRepo = form.repoUrl.trim();
  const cleanNote = sanitizeMakerNote(form.makerNote);
  const cleanNoteEn = sanitizeMakerNote(form.makerNoteEn ?? '');
  const cleanIcon = (form.customIconUrl ?? '').trim();

  url.searchParams.set('title', `[Launchpad] ${cleanName}`);
  url.searchParams.set('repo_url', cleanRepo);
  url.searchParams.set('app_name', cleanName);
  url.searchParams.set(
    'category',
    LAUNCHPAD_ISSUE_CATEGORY_OPTIONS[form.category] ?? form.category,
  );
  url.searchParams.set('maker_note', cleanNote);
  if (cleanNoteEn) {
    url.searchParams.set('maker_note_en', cleanNoteEn);
  }
  url.searchParams.set(
    'launch_tier',
    LAUNCHPAD_ISSUE_TIER_OPTIONS[form.launchTier] ?? form.launchTier,
  );
  if (cleanIcon) {
    url.searchParams.set('custom_icon_url', cleanIcon);
  }
  return url.toString();
}

/** 将预检结果与当前表单状态实时组装为用于 `<LaunchpadCard>` 所见即所得预览的 `LaunchpadEntry`。 */
export function buildPreviewLaunchpadEntry(
  form: LaunchpadSubmitFormInput,
  preflight: LaunchpadPreflightResult | null,
  oauthUser?: OAuthUser | null,
): LaunchpadEntry {
  const owner = preflight?.owner || oauthUser?.login || 'maker';
  const repo = preflight?.repo || 'open-app';
  const id = preflight?.canonical_id || `${owner}/${repo}`.toLowerCase();
  const name = form.appName.trim() || preflight?.repo_name || repo;
  const customIcon = validateCustomIconUrl(form.customIconUrl);
  const icon = preflight
    ? preflight.resolved_icon_url
    : customIcon.ok && customIcon.clean
      ? customIcon.clean
      : '';
  const pinned = form.launchTier !== 'free';

  return {
    summary: {
      id,
      name,
      owner,
      repo,
      icon,
      icon_bg: '',
      description: preflight?.description || '',
      stars: preflight?.stars ?? 0,
      forks: preflight?.forks ?? 0,
      license: preflight?.license || 'MIT',
      latest_version: preflight?.latest_version || 'v0.1.0',
      category: form.category,
      category_name: CATEGORY_ZH_NAMES[form.category] ?? form.category,
      is_verified: false,
      is_cataloged: preflight?.already_in_catalog ?? false,
      forge: preflight?.forge || 'github',
      forge_host: preflight?.forge_host || 'github.com',
      homepage: preflight?.homepage ?? null,
      platforms: preflight?.platforms ?? [],
    },
    maker_note: sanitizeMakerNote(form.makerNote),
    maker_note_en: sanitizeMakerNote(form.makerNoteEn ?? '') || null,
    maker: {
      login: owner,
      name: null,
      avatar_url: preflight?.maker_avatar_url || oauthUser?.avatar_url || '',
      html_url: `https://${preflight?.forge_host || 'github.com'}/${owner}`,
    },
    launched_at: new Date().toISOString(),
    latest_release_at: null,
    stars_7d_delta: 0,
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 0,
    discussion_node_id: null,
    discussion_url: '',
    discussion_comments_count: 0,
    discussion_upvotes: 0,
    is_pinned: pinned,
    pin_until: null,
    pin_tier: pinned ? 'sponsor' : null,
    viewer_has_starred: false,
    viewer_has_upvoted: false,
  };
}
