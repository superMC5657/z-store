/** 待收录与本地库领域模型、线格式转换及「移入收录」操作入口。 */
import type { AppSummary } from '../types';
import { DEFAULT_ICON_BG } from '../styles/tokens';
import { tauriApi } from './api';
import { resolveRemoteIconUrl } from './iconStore';
import { canonicalAppId } from './normalizeId';

/** 草稿状态：`local_collected` 为存储层兼容同义值（判定与 `collected` 等同）。 */
export type DraftStatus = 'draft' | 'submitted' | 'collected' | 'local_collected';

/** 草稿条目（领域形状）：表单、列表、卡片摘要共用。 */
export interface DraftItem {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  /** 空串表示未填（线格式 `null` 在转换口归一）。 */
  description_en: string;
  category: string;
  category_name: string;
  aliases: string[];
  default_version: string;
  license: string;
  /** 空串表示未填（线格式 `null` 在转换口归一）。 */
  homepage: string;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
  identifiers: Record<string, string[]>;
  /** 后端真值透传，表单不编辑。 */
  stars?: number;
  forks?: number;
  /** 后端只读投影的入库日 `YYYY-MM-DD`；`itemToWire` 不写回。 */
  added_at?: string;
}

/** 草稿条目（领域形状）：status 已归一到 `DraftStatus`。 */
export interface DraftEntry {
  id: string;
  item: DraftItem;
  status: DraftStatus;
  pr_url?: string | null;
  archived: boolean;
  /** 本地新建条目缺席（后端行为必有）。 */
  updated_at?: number;
}

/** 草稿 payload 线格式（与后端 `CatalogItem` 同形，`is_verified` 入库强制 false）。 */
export interface DraftItemWire {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  description_en?: string | null;
  category: string;
  category_name: string;
  aliases: string[];
  default_version: string;
  license: string;
  stars: number;
  forks: number;
  is_verified: boolean;
  homepage?: string | null;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
  identifiers: Record<string, string[]>;
  /** 后端只读投影，读取时可能携带；保存 payload 永不包含。 */
  added_at?: string | null;
}

/** 后端 `custom_apps` 行（线格式）：与 Rust `CustomAppEntry` 同形。 */
export interface DraftEntryWire {
  id: string;
  item: DraftItemWire;
  status: string;
  pr_url?: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
}

/** 本地收录态判定唯一口径（`collected` 与磁盘残留 `local_collected` 同义；归档与否由调用方另判）。 */
export function isCollectedStatus(status: unknown): boolean {
  return status === 'collected' || status === 'local_collected';
}

function draftStatusFromWire(status: string): DraftStatus {
  if (status === 'submitted') return 'submitted';
  if (isCollectedStatus(status)) return 'collected';
  return 'draft';
}

function itemFromWire(wire: DraftItemWire): DraftItem {
  return {
    id: wire.id,
    name: wire.name ?? '',
    owner: wire.owner ?? '',
    repo: wire.repo ?? '',
    icon: wire.icon ?? '',
    icon_bg: wire.icon_bg ?? '',
    description: wire.description ?? '',
    description_en: typeof wire.description_en === 'string' ? wire.description_en : '',
    category: wire.category ?? '',
    category_name: wire.category_name ?? '',
    aliases: wire.aliases ?? [],
    default_version: wire.default_version ?? 'v0.1.0',
    license: wire.license ?? '',
    homepage: typeof wire.homepage === 'string' ? wire.homepage : '',
    install_dirs: wire.install_dirs ?? [],
    search_subdirs: wire.search_subdirs ?? [],
    publishers: wire.publishers ?? [],
    platforms: wire.platforms ?? [],
    identifiers: wire.identifiers ?? {},
    stars: typeof wire.stars === 'number' && Number.isFinite(wire.stars) ? wire.stars : 0,
    forks: typeof wire.forks === 'number' && Number.isFinite(wire.forks) ? wire.forks : 0,
  };
}

/** epoch 秒 → UTC `YYYY-MM-DD`；非正或非有限数返回 `undefined`。 */
function formatUtcYmd(epochSecs?: number): string | undefined {
  if (typeof epochSecs !== 'number' || !Number.isFinite(epochSecs) || epochSecs <= 0) {
    return undefined;
  }
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
}

/** 后端行 → 领域条目（视图与 App 状态一律持有此形状）；`added_at` 优先取 item 投影，缺省由 `created_at` 推导。 */
export function entryFromWire(wire: DraftEntryWire): DraftEntry {
  const item = itemFromWire(wire.item);
  const explicitAddedAt =
    typeof wire.item.added_at === 'string' ? wire.item.added_at.trim() : '';
  const addedAt = explicitAddedAt || formatUtcYmd(wire.created_at);
  if (addedAt) item.added_at = addedAt;
  return {
    id: wire.id,
    item,
    status: draftStatusFromWire(wire.status),
    pr_url: wire.pr_url ?? null,
    archived: wire.archived,
    updated_at: wire.updated_at,
  };
}

/** 领域 item 转为保存 payload（空串归 `null`，`is_verified` 恒 false，`stars/forks` 保留已有行真值）。 */
export function itemToWire(
  item: DraftItem,
  existing?: Pick<DraftItem, 'stars' | 'forks'>,
): DraftItemWire {
  return {
    id: item.id,
    name: item.name,
    owner: item.owner,
    repo: item.repo,
    icon: item.icon,
    icon_bg: item.icon_bg,
    description: item.description,
    description_en: item.description_en.trim() ? item.description_en : null,
    category: item.category,
    category_name: item.category_name,
    aliases: item.aliases,
    default_version: item.default_version,
    license: item.license,
    stars: existing?.stars ?? item.stars ?? 0,
    forks: existing?.forks ?? item.forks ?? 0,
    is_verified: false,
    homepage: item.homepage.trim() ? item.homepage : null,
    install_dirs: item.install_dirs,
    search_subdirs: item.search_subdirs,
    publishers: item.publishers,
    platforms: item.platforms,
    identifiers: item.identifiers,
  };
}

/** 草稿转为卡片摘要；纯 `draft` 且未归档时不带 `source` 以免误标为本地收录。 */
export function itemToSummary(
  item: DraftItem,
  status: DraftStatus,
  archived?: boolean,
): AppSummary & { source?: 'local'; status: string; archived?: boolean } {
  const hasCollectionRecord = archived === true || status !== 'draft';
  return {
    id: item.id,
    name: item.name || item.id,
    owner: item.owner,
    repo: item.repo,
    icon: item.icon,
    icon_bg: item.icon_bg || DEFAULT_ICON_BG,
    description: item.description,
    description_en: item.description_en || undefined,
    stars: typeof item.stars === 'number' && Number.isFinite(item.stars) ? item.stars : 0,
    forks: typeof item.forks === 'number' && Number.isFinite(item.forks) ? item.forks : 0,
    license: item.license,
    latest_version: item.default_version || 'v0.1.0',
    category: item.category || 'dev',
    category_name: item.category_name || item.category || 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: item.homepage || null,
    platforms: [...(item.platforms ?? [])],
    ...(item.added_at ? { added_at: item.added_at } : {}),
    ...(hasCollectionRecord ? { source: 'local' as const } : {}),
    status,
    ...(archived === undefined ? {} : { archived }),
  };
}

/** 本地收录行 → 合并视图摘要（保留 status/archived，供去重与黄标）。 */
export function entryToCollectedSummary(
  entry: DraftEntry,
): AppSummary & { status: string; archived: boolean } {
  return itemToSummary(entry.item, entry.status, entry.archived) as AppSummary & {
    status: string;
    archived: boolean;
  };
}

const DRAFT_DESKTOP_PLATFORMS = ['windows', 'macos', 'linux'];
const DRAFT_SEARCH_SUBDIRS = ['bin'];
const DRAFT_CATEGORY_NAMES: Record<string, string> = {
  system: '系统实用',
  network: '网络工具',
  media: '影音视听',
  security: '安全隐私',
  dev: '开发工具',
  graphics: '图形设计',
  office: '效率办公',
  reading: '学习阅读',
  ops: '极客运维',
  games: '休闲游戏',
};

function cleanCoord(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

function canonicalDraftId(owner: string, repo: string): string {
  return `${cleanCoord(owner).toLowerCase()}/${cleanCoord(repo).toLowerCase()}`;
}

function homepageOrGithub(owner: string, repo: string, homepage?: string | null): string {
  const h = (homepage ?? '').trim();
  if (h.startsWith('http://') || h.startsWith('https://')) return h;
  return `https://github.com/${cleanCoord(owner)}/${cleanCoord(repo)}`;
}

/** 草稿 icon 归一：仅保留远程 http(s) 真值，base64/data:/空/相对路径一律置空走详情 icon 链回填。 */
function normalizeDraftIcon(icon: unknown): string {
  if (typeof icon !== 'string') return '';
  const v = icon.trim();
  return /^https?:\/\//i.test(v) ? v : '';
}

function normalizeDraftPlatforms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of input) {
    if (typeof p !== 'string') continue;
    const key = p.trim().toLowerCase();
    if (!key || key === 'other' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function guessDraftPlatformsFromName(repo: string, name: string, extra = ''): string[] {
  const text = `${repo} ${name} ${extra}`.toLowerCase();
  const hasAndroid = text.includes('android');
  const hasIos = text.includes('ios') || text.includes('iphone') || text.includes('ipad');
  if (hasAndroid && !hasIos) return ['android'];
  if (hasIos && !hasAndroid) return ['ios'];
  const hasWin =
    text.includes('windows') ||
    text.includes('win32') ||
    text.includes('win64') ||
    text.includes('winui') ||
    text.includes('wpf');
  const hasMac =
    text.includes('macos') ||
    text.includes('mac os') ||
    text.includes('darwin') ||
    text.includes('appkit') ||
    text.includes('cocoa');
  const hasLinux =
    text.includes('linux') ||
    text.includes('appimage') ||
    text.includes('flatpak') ||
    /(?:^|[\W_])deb(?:$|[\W_])/.test(text);
  const hits = [
    hasWin ? 'windows' : '',
    hasMac ? 'macos' : '',
    hasLinux ? 'linux' : '',
  ].filter((s): s is string => s !== '');
  if (hits.length === 1) return hits;
  return [...DRAFT_DESKTOP_PLATFORMS];
}

function draftExeCandidates(base: string): string[] {
  const b = cleanCoord(base);
  if (!b) return [];
  const lower = b.toLowerCase();
  const clean = lower.replace(/[.\-]+/g, '');
  const out = [`${b}.exe`, `${lower}.exe`];
  if (clean && clean !== lower) out.push(`${clean}.exe`);
  return [...new Set(out.filter((s) => s.trim() !== ''))];
}

function draftBareCandidates(base: string): string[] {
  const b = cleanCoord(base);
  if (!b) return [];
  const lower = b.toLowerCase();
  const clean = lower.replace(/[.\-]+/g, '');
  return [...new Set([b, lower, clean].filter((s) => s && s.trim() !== ''))];
}

function buildDraftIdentifiers(
  base: string,
  platforms: string[],
): Record<string, string[]> {
  const keys = platforms.length > 0 ? platforms : [...DRAFT_DESKTOP_PLATFORMS];
  const out: Record<string, string[]> = {};
  for (const k of keys) {
    const key = k.trim().toLowerCase();
    if (!key || key === 'other' || out[key]) continue;
    const candidates =
      key === 'windows' ? draftExeCandidates(base) : draftBareCandidates(base);
    if (candidates.length > 0) out[key] = candidates;
  }
  return out;
}

function buildDraftInstallDirs(repo: string): string[] {
  const r = cleanCoord(repo);
  if (!r) return [];
  const lower = r.toLowerCase();
  return r === lower ? [r] : [r, lower];
}

function buildDraftPublishers(owner: string): string[] {
  const t = cleanCoord(owner);
  if (!t) return [];
  const parts = t.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const beautified = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return beautified ? [beautified] : [];
}

function buildDraftAliases(name: string, repo: string, owner: string): string[] {
  const id = canonicalDraftId(owner, repo);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [cleanCoord(name), cleanCoord(repo), id]) {
    const lower = c.toLowerCase();
    if (!lower || lower === '/' || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

function guessDraftCategoryKey(text: string): string {
  const t = text.toLowerCase();
  if (
    t.includes('remote') ||
    t.includes('desktop') ||
    t.includes('cleaner') ||
    t.includes('launcher') ||
    t.includes('file manager')
  ) {
    return 'system';
  }
  if (
    t.includes('network') ||
    t.includes('transfer') ||
    t.includes('download') ||
    t.includes('torrent') ||
    t.includes('proxy') ||
    t.includes('vpn')
  ) {
    return 'network';
  }
  if (
    t.includes('player') ||
    t.includes('video') ||
    t.includes('audio') ||
    t.includes('music') ||
    t.includes('stream') ||
    t.includes('record')
  ) {
    return 'media';
  }
  if (
    t.includes('password') ||
    t.includes('security') ||
    t.includes('crypto') ||
    t.includes('2fa') ||
    t.includes('otp') ||
    t.includes('authenticator')
  ) {
    return 'security';
  }
  if (
    t.includes('editor') ||
    t.includes('terminal') ||
    t.includes('git') ||
    t.includes('code') ||
    t.includes('developer') ||
    t.includes('api')
  ) {
    return 'dev';
  }
  if (
    t.includes('image') ||
    t.includes('paint') ||
    t.includes('photo') ||
    t.includes('screenshot') ||
    t.includes('3d') ||
    t.includes('svg')
  ) {
    return 'graphics';
  }
  if (
    t.includes('note') ||
    t.includes('markdown') ||
    t.includes('pdf') ||
    t.includes('office') ||
    t.includes('todo') ||
    t.includes('calendar')
  ) {
    return 'office';
  }
  if (
    t.includes('book') ||
    t.includes('reader') ||
    t.includes('rss') ||
    t.includes('epub') ||
    t.includes('feed')
  ) {
    return 'reading';
  }
  if (
    t.includes('docker') ||
    t.includes('kubernetes') ||
    t.includes('monitor') ||
    t.includes('database') ||
    t.includes('server')
  ) {
    return 'ops';
  }
  if (t.includes('game') || t.includes('emulator') || t.includes('arcade')) {
    return 'games';
  }
  return 'dev';
}

function resolveDraftCategory(
  rawCategory: string,
  rawCategoryName: string,
  guessText: string,
): { category: string; category_name: string } {
  if (rawCategory) {
    return { category: rawCategory, category_name: rawCategoryName || rawCategory };
  }
  const key = guessDraftCategoryKey(guessText);
  return { category: key, category_name: DRAFT_CATEGORY_NAMES[key] ?? key };
}

/** 暂存草稿的 forge 校验：仅允许 GitHub `owner/repo` 形式。 */
export function draftForgeGateError(app: Pick<AppSummary, 'id' | 'forge'>): string | null {
  const forge = typeof app.forge === 'string' ? app.forge.trim().toLowerCase() : '';
  const id = typeof app.id === 'string' ? app.id.trim() : '';
  if (forge && forge !== 'github') {
    return `仅支持 GitHub 仓库移入收录，${forge} 仓库暂不收录：${id}`;
  }
  if (id.includes(':')) {
    if (canonicalAppId(id) === null) {
      return `无法识别的应用标识: ${id}`;
    }
    return `仅支持 GitHub owner/repo，forge 形态 id 暂不收录：${id}`;
  }
  return null;
}

/** 由在线 `AppSummary` 合成草稿 payload（一键“移入收录”入口）。 */
export function buildCustomDraftItemFromSummary(
  app: AppSummary,
  iconRemote?: unknown,
): DraftItemWire {
  const gateError = draftForgeGateError(app);
  if (gateError) throw new Error(gateError);
  const owner = cleanCoord(app.owner) || cleanCoord(app.id.split('/')[0] ?? '');
  const repo =
    cleanCoord(app.repo) ||
    cleanCoord(app.id.split('/').slice(1).join('/')) ||
    cleanCoord(app.name);
  const id = canonicalDraftId(owner, repo);
  const draftName = cleanCoord(app.name) || repo;
  const description = cleanCoord(app.description) || cleanCoord(app.name) || id;
  const descriptionEn =
    typeof app.description_en === 'string' && app.description_en.trim()
      ? app.description_en
      : null;
  const { category, category_name } = resolveDraftCategory(
    cleanCoord(app.category),
    cleanCoord(app.category_name),
    `${draftName} ${repo} ${description} ${descriptionEn ?? ''}`,
  );
  const srcPlatforms = normalizeDraftPlatforms(app.platforms);
  const platforms =
    srcPlatforms.length > 0
      ? srcPlatforms
      : guessDraftPlatformsFromName(repo, draftName, description);
  const idBase = repo || draftName;
  return {
    id,
    name: draftName,
    owner,
    repo,
    icon: normalizeDraftIcon(iconRemote) || normalizeDraftIcon(app.icon),
    icon_bg:
      typeof app.icon_bg === 'string' && app.icon_bg
        ? app.icon_bg
        : DEFAULT_ICON_BG,
    description,
    description_en: descriptionEn,
    category,
    category_name,
    aliases: buildDraftAliases(draftName, repo, owner),
    default_version: cleanCoord(app.latest_version) || 'v0.1.0',
    license: cleanCoord(app.license) || 'OpenSource',
    stars: typeof app.stars === 'number' && Number.isFinite(app.stars) ? app.stars : 0,
    forks: typeof app.forks === 'number' && Number.isFinite(app.forks) ? app.forks : 0,
    is_verified: false,
    homepage: homepageOrGithub(owner, repo, typeof app.homepage === 'string' ? app.homepage : null),
    install_dirs: buildDraftInstallDirs(repo),
    search_subdirs: [...DRAFT_SEARCH_SUBDIRS],
    publishers: buildDraftPublishers(owner),
    platforms,
    identifiers: buildDraftIdentifiers(idBase, platforms),
  };
}

/** 移入收录结果：成功时带回落库草稿（含 canonical id），失败带回原因供视图本地化提示。 */
export interface MoveInResult {
  ok: boolean;
  id: string;
  item?: DraftItemWire;
  error?: string;
}

/** 移入收录：校验 forge、按需拉取详情补齐许可/平台、保存草稿并广播变更事件。 */
export async function moveInToDraft(app: AppSummary): Promise<MoveInResult> {
  const gateError = draftForgeGateError(app);
  if (gateError) {
    return { ok: false, id: app.id, error: gateError };
  }

  let effectiveApp = app;
  const rawLic = typeof app.license === 'string' ? app.license.trim() : '';
  const isLicensePlaceholder =
    !rawLic ||
    rawLic.toLowerCase() === 'opensource' ||
    rawLic.toLowerCase() === 'unknown';

  if (isLicensePlaceholder) {
    const detail = await tauriApi.getAppDetails(app.id).catch(() => null);
    if (detail) {
      const realLic = typeof detail.license === 'string' ? detail.license.trim() : '';
      const isDetailPlaceholder =
        !realLic ||
        realLic.toLowerCase() === 'opensource' ||
        realLic.toLowerCase() === 'unknown';

      effectiveApp = {
        ...app,
        description: app.description || detail.description,
        description_en: detail.description_en || app.description_en,
        license: !isDetailPlaceholder ? realLic : (rawLic || 'OpenSource'),
        homepage: detail.homepage || app.homepage,
        platforms:
          detail.platforms && detail.platforms.length > 0
            ? detail.platforms
            : app.platforms,
        latest_version: detail.latest_version || app.latest_version,
      };
    }
  }

  let iconRemote: string | undefined;
  const cycle = await tauriApi.restoreOrFetchIconCycle(effectiveApp.id).catch(() => null);
  const remote = resolveRemoteIconUrl(cycle);
  if (remote !== '') iconRemote = remote;
  const draft = buildCustomDraftItemFromSummary(effectiveApp, iconRemote);
  try {
    await tauriApi.saveCustomApp(draft);
  } catch (e) {
    return {
      ok: false,
      id: draft.id,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  window.dispatchEvent(
    new CustomEvent('zstore:custom-apps-changed', { detail: { id: draft.id } }),
  );
  return { ok: true, id: draft.id, item: draft };
}
