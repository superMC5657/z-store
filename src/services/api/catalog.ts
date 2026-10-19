import { listen } from '@tauri-apps/api/event';
import { zlogWarn } from '../../lib/z-log';
import type { IconReadyPayload } from '../iconStore';
import type { DraftEntryWire, DraftItemWire } from '../custom/types';
import type {
  AppDetail,
  AppMatchResult,
  AppSummary,
  CacheUsageStats,
  ForgeRepoInfo,
  ImportAppRequest,
  SyncCatalogResult,
} from '../../types';
import {
  CMD,
  type AppIconCycleResult,
  type HomeFeedRaw,
  type HomeFeedResult,
  type PlatformsLiteResult,
  type ReadmeVariant,
  type ReadmeVariantsResult,
  type TauriCommand,
} from '../api';
import { isTauri, tauriInvoke } from './client';

export async function searchApps(query: string, limit?: number, offset?: number): Promise<AppSummary[]> {
  const args: Record<string, unknown> = { query };
  if (limit !== undefined && limit !== null) args.limit = limit;
  if (offset !== undefined && offset !== null) args.offset = offset;
  return tauriInvoke<AppSummary[]>(CMD.search, args);
}

export async function getHomeFeed(
  limit: number,
  offset: number,
  seed?: number,
  strategy?: string,
): Promise<HomeFeedResult> {
  const args: Record<string, unknown> = { limit, offset };
  if (seed !== undefined && seed !== null) args.seed = seed;
  if (strategy !== undefined && strategy !== null) args.strategy = strategy;
  const raw = await tauriInvoke<HomeFeedRaw>(CMD.getHomeFeed, args);
  // 发现页 feed 分页视图：后端返回 snake_case。
  const items = Array.isArray(raw?.items) ? (raw as { items: AppSummary[] }).items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  return { items, total, has_more: raw?.has_more === true };
}

export async function searchAppsOnline(
  query: string,
  searchId?: string,
  page?: number,
  perPage?: number,
  // 显式手动提交（搜索提交/加载更多）传 true 走网络；缺席即后端 DB-only 回退。
  forceRefresh = false,
): Promise<{ rows: AppSummary[]; sid: string }> {
  try {
    const args: Record<string, unknown> = { query, searchId, forceRefresh };
    if (page !== undefined && page !== null) args.page = page;
    if (perPage !== undefined && perPage !== null) args.perPage = perPage;
    const res = await tauriInvoke<AppSummary[] | { rows: AppSummary[]; sid: string }>(
      CMD.searchOnline,
      args,
    );
    if (Array.isArray(res)) return { rows: res, sid: '' };
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      sid: typeof res.sid === 'string' ? res.sid : '',
    };
  } catch (err) {
    zlogWarn(
      `search_apps_online is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return { rows: [], sid: '' };
  }
}

export async function enrichTrendRepos(
  repos: { owner: string; repo: string }[],
  // 趋势刷新链传 true 走网络 + 流式；缺席即后端 DB-only（读 enrich 缓存）。
  forceRefresh = false,
): Promise<(AppSummary | null)[]> {
  const fallback = repos.map(() => null);
  try {
    const res = await tauriInvoke<(AppSummary | null)[]>(CMD.enrichTrendRepos, {
      repos,
      forceRefresh,
    });
    if (!Array.isArray(res)) return fallback;
    return repos.map((_, i) => res[i] ?? null);
  } catch (err) {
    zlogWarn(
      `enrich_trend_repos is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return fallback;
  }
}

/**
 * 只听统一事件 `zstore://icon-ready{id,icon,level,via,context}`：
 * 前端只订阅此事件（`via`透传，M2首屏直填不走emit）。
 * 世代门控走 `services/iconStore.admitIconHit`（读 `context.search_id` vs `currentSearchId`），
 * `level`纯L单调，调用方只做载荷适配 + React 列表 `patch` 注入。
 */
type SearchIconUpgradePayload = IconReadyPayload;

export async function onSearchIconUpgraded(
  callback: (payload: SearchIconUpgradePayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<IconReadyPayload>('zstore://icon-ready', (e) => {
    callback(e.payload);
  });
}

export async function getAppDetails(id: string, forceRefresh = false): Promise<AppDetail> {
  return tauriInvoke<AppDetail>(CMD.getAppDetails, { id, forceRefresh });
}

// 收藏/关注未收录行富卡回填（DB-only，零网络零写盘）：与入参一一对齐的
// `(AppSummary | null)[]`，无缓存行即 `None -> null`。调用方以 Array.isArray 防御后端缺席。
export async function getCachedAppDetailsBatch(ids: string[]): Promise<(AppSummary | null)[]> {
  return tauriInvoke<(AppSummary | null)[]>(CMD.getCachedAppDetailsBatch, { ids });
}

// 趋势榜重挂图标自愈（DB-only，零网络零写盘）：与入参一一对齐的 `(string | null)[]`，
// 无确认图标即 `None -> null`（cycle 表 + 本地文件，M2 dataURI 或 L1..L3 远端；L4 即 null）。
// 空入参直接回空，不进 IPC；调用方以 Array.isArray 防御后端缺席。
export async function getConfirmedIconsBatch(ids: string[]): Promise<(string | null)[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  return tauriInvoke<(string | null)[]>(CMD.getConfirmedIconsBatch, { ids });
}

export async function getPlatformsLite(
  id: string,
  // 手动重试传 true 走 ETag 条件请求；缺席即读 TTL 缓存/DB（默认 DB-only）。
  forceRefresh = false,
): Promise<PlatformsLiteResult> {
  try {
    const res = await tauriInvoke<PlatformsLiteResult>(CMD.getPlatformsLite, { id, forceRefresh });
    if (!res || !Array.isArray((res as PlatformsLiteResult).platforms)) {
      zlogWarn(`get_platforms_lite returned invalid shape for id=${id}, treating as stale loading`);
      return { id, platforms: [], is_stale: true };
    }
    return res;
  } catch (err) {
    zlogWarn(
      `get_platforms_lite is not available or failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    return { id, platforms: [], is_stale: true };
  }
}

export async function getReadmeVariants(appId: string): Promise<ReadmeVariantsResult> {
  try {
    const raw = await tauriInvoke<ReadmeVariantsResult | ReadmeVariant[] | null>(
      CMD.getReadmeVariants,
      { appId },
    );
    if (!raw) return { variants: [] };
    if (Array.isArray(raw)) return { variants: raw };
    if (Array.isArray((raw as ReadmeVariantsResult).variants)) {
      return { variants: (raw as ReadmeVariantsResult).variants };
    }
    return { variants: [] };
  } catch {
    return { variants: [] };
  }
}

// 图片磁盘缓存查询：返回 asset 本地路径或原 https，失败时回退原链。
export async function fetchOrCacheAssetUrl(url: string, appId: string): Promise<string> {
  try {
    const res = await tauriInvoke<string>(CMD.fetchOrCacheAssetUrl, { appId, url });
    if (typeof res === 'string' && res) return res;
    return url;
  } catch {
    return url;
  }
}

// 查询通用图片磁盘缓存占用。
export async function getAssetCacheStats(): Promise<CacheUsageStats | null> {
  try {
    return await tauriInvoke<CacheUsageStats>(CMD.getAssetCacheStats);
  } catch {
    return null;
  }
}

// 清空通用图片磁盘缓存，返回已删除文件数。
export async function clearAssetCache(): Promise<number> {
  return tauriInvoke<number>(CMD.clearAssetCache);
}

// 查询图标磁盘缓存占用。
export async function getIconCacheStats(): Promise<CacheUsageStats | null> {
  try {
    return await tauriInvoke<CacheUsageStats>(CMD.getIconCacheStats);
  } catch {
    return null;
  }
}

// 清空图标磁盘缓存，返回已删除文件数。
export async function clearIconCache(): Promise<number> {
  return tauriInvoke<number>(CMD.clearIconCache);
}

/**
 * 类别页默认页大小：与发现页 `HOME_FEED_PAGE`、在线搜索 `ONLINE_SEARCH_PER_PAGE` 对齐（20/页）。
 */
export const CATEGORY_APPS_PER_PAGE = 20;

export async function getCategoryApps(
  category: string,
  page?: number,
  perPage?: number,
): Promise<HomeFeedResult> {
  const args: Record<string, unknown> = { category };
  if (page !== undefined && page !== null) args.page = page;
  if (perPage !== undefined && perPage !== null) args.perPage = perPage;
  // 类别页分页与发现页同形 `{ items, total, has_more }`（请求 key camel，经 command rename 桥接；回包字段 snake，serde 不动）。
  const raw = await tauriInvoke<HomeFeedRaw>(CMD.getCategoryApps, args);
  const items = Array.isArray(raw?.items) ? (raw as { items: AppSummary[] }).items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  return { items, total, has_more: raw?.has_more === true };
}

export async function getCatalogCount(): Promise<number> {
  return tauriInvoke<number>(CMD.getCatalogCount);
}

export async function scanAndMatchLocalApps(): Promise<AppMatchResult[]> {
  return tauriInvoke<AppMatchResult[]>(CMD.scanAndMatchLocalApps);
}

export async function importMatchedApps(apps: ImportAppRequest[]): Promise<number> {
  return tauriInvoke<number>(CMD.importMatchedApps, { apps });
}

export async function recordSearchQuery(query: string): Promise<void> {
  return tauriInvoke<void>(CMD.recordSearchQuery, { query });
}

export async function getSearchHistory(): Promise<string[]> {
  return tauriInvoke<string[]>(CMD.getSearchHistory);
}

export async function clearSearchHistory(): Promise<void> {
  return tauriInvoke<void>(CMD.clearSearchHistory);
}

export async function removeSearchQuery(query: string): Promise<void> {
  return tauriInvoke<void>(CMD.removeSearchQuery, { query });
}

export async function recordAppView(appId: string): Promise<void> {
  return tauriInvoke<void>(CMD.recordAppView, { appId });
}

export async function getRecentlyViewedApps(): Promise<AppSummary[]> {
  return tauriInvoke<AppSummary[]>(CMD.getRecentlyViewedApps);
}

export async function clearViewHistory(): Promise<void> {
  return tauriInvoke<void>(CMD.clearViewHistory);
}

export async function searchForgeRepos(
  forge: string,
  query: string,
  host?: string,
): Promise<ForgeRepoInfo[]> {
  return tauriInvoke<ForgeRepoInfo[]>(CMD.searchForgeRepos, { forge, host, query });
}

export async function syncCatalog(force?: boolean): Promise<SyncCatalogResult> {
  return tauriInvoke<SyncCatalogResult>(CMD.syncCatalog, { force });
}

export async function getOrFetchIcon(appId: string | undefined, remoteUrl: string): Promise<string> {
  return tauriInvoke<string>(CMD.getOrFetchIcon, { appId: appId ?? null, remoteUrl });
}

// 请求轮换到下一档：用户手动切换图标档位（L1→L2→…→L5→L1），选中态落盘。
export async function cycleAppIcon(appId: string): Promise<AppIconCycleResult> {
  return tauriInvoke<AppIconCycleResult>(CMD.cycleAppIcon, { appId });
}

// 恢复+探测+落盘：读库命中即返，无则后端补探回填后返回当前轮换态。
export async function restoreOrFetchIconCycle(appId: string): Promise<AppIconCycleResult | null> {
  try {
    return await tauriInvoke<AppIconCycleResult | null>(CMD.restoreOrFetchIconCycle, {
      appId,
    });
  } catch {
    return null;
  }
}

// 自维护草稿 overlay：仅做 IPC 封装（CMD 表驱动），视图层禁直调 invoke（见 noDirectInvoke.test.ts）。

/**
 * 草稿线格式别名（唯一定义见 `services/custom/types.ts`）：
 * `CustomCatalogItem` = payload，`CustomAppEntry` = 后端行。
 */
export type CustomCatalogItem = DraftItemWire;
export type CustomAppEntry = DraftEntryWire;


/** 转正提示（与后端 GraduationNotice 同形）。 */
interface GraduationNotice {
  id: string;
  message: string;
}

/** 合并目录视图行：AppSummary 扁平 + 来源标记（remote/custom，is_cataloged 恒 true）。 */
type MergedCatalogEntry = AppSummary & {
  source: string;
  is_cataloged: boolean;
};

/** 草稿列表（默认仅未归档；includeArchived=true 含转正归档行）。 */
export async function listCustomApps(includeArchived = false): Promise<CustomAppEntry[]> {
  return tauriInvoke<CustomAppEntry[]>(CMD.listCustomApps, {
    includeArchived,
  });
}

/**
 * 草稿暂存（新建行 status=draft；已存在行仅刷新 payload）。
 * 调用方须保证 id 为 canonical 小写且与 owner/repo 对齐（见 buildCustomDraftItem）。
 */
export async function saveCustomApp(item: CustomCatalogItem): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.saveCustomApp, { item });
}

/** 草稿删除（二次确认由调用方完成，后端直接删）：返回是否命中。 */
export async function deleteCustomApp(id: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.deleteCustomApp, { id });
}

/** 标记已提交：status=submitted + 落 pr_url；已转正归档行拒绝。 */
export async function markCustomSubmitted(id: string, prUrl: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.markCustomSubmitted, { id, prUrl });
}

/**
 * 本地收录（收录档校验后 status=collected，已收录仍 is_verified=false）：
 * 仅发 {id}（camelCase 单键，snake 后端桥接）。
 */
async function collectByCommand(cmd: TauriCommand, id: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(cmd, { id });
}

export async function collectCustomApp(id: string): Promise<CustomAppEntry> {
  return collectByCommand(CMD.collectCustomApp, id);
}

/** 本地收录视图入口（收录档校验后 status=collected，已收录仍 is_verified=false；直调 collect_local_app 真身）。 */
export async function collectLocalApp(id: string): Promise<CustomAppEntry> {
  return collectByCommand(CMD.collectLocalApp, id);
}

/**
 * 本地收录退回草稿（后端 `revert_collected_to_draft` 落盘：status=draft + pr_url 清空）：
 * 仅发 {id}（camelCase 单键，snake 后端桥接）。失败由调用方 toast 报错，禁止静默本地翻态。
 */
export async function revertCollectedApp(id: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.revertCollectedApp, { id });
}

/**
 * 转正退役：远端 id 集合命中未归档草稿即 archived=1，返回转正提示。
 * remoteIds 缺席时后端以当前内存目录为准（sync_catalog 成功路径已自动调用）。
 */
export async function retireOnSync(remoteIds?: string[]): Promise<GraduationNotice[]> {
  const args: Record<string, unknown> =
    remoteIds === undefined ? {} : { remoteIds };
  return tauriInvoke<GraduationNotice[]>(CMD.retireOnSync, args);
}

/** 合并目录视图：内存远端目录 + 未归档草稿 overlay（远端优先去重）。 */
export async function getMergedCatalogView(): Promise<MergedCatalogEntry[]> {
  return tauriInvoke<MergedCatalogEntry[]>(CMD.getMergedCatalogView);
}

/** 收录申请预填链接：由草稿 payload 生成清单仓库 Issue 预填 URL。 */
export async function getCustomAppPrUrl(id: string): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppPrUrl, { id });
}

/**
 * 批量收录申请预填链接：选中多条合并为一个 JSON 数组，经一个预填 URL 提交（批量合一）。
 */
export async function getCustomAppsBatchPrUrl(ids: string[]): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppsBatchPrUrl, { ids });
}

/**
 * 单条提交载荷（后端序列化的 JSON 对象文本）：预填链接超长时直接复制给用户。
 * 前端只原样透传字符串，不自行拼装/格式化 JSON。
 */
export async function getCustomAppPrPayload(id: string): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppPrPayload, { id });
}

/**
 * 批量提交载荷（后端序列化的 JSON 数组文本）：批量预填链接超长时直接复制给用户。
 * 前端只原样透传字符串，不自行拼装/格式化 JSON。
 */
export async function getCustomAppsBatchPrPayload(ids: string[]): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppsBatchPrPayload, { ids });
}

/**
 * 许可名单只读查询（ADR-0018）：名单唯一源头为后端编译时配置。
 * 前端 SubmitStrict 校验（提交/预填 PR 前）经此拉取；调用失败由调用方视为
 * 加载失败（放行暂存、提交提示重试），绝不在前端回退一份写死名单。
 */
export interface LicenseAllowlistResult {
  enabled: boolean;
  allowed: string[];
}

export async function getLicenseAllowlist(): Promise<LicenseAllowlistResult> {
  const raw = await tauriInvoke<{ enabled?: unknown; allowed?: unknown }>(
    CMD.getLicenseAllowlist,
  );
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.allowed)) {
    throw new Error('invalid license allowlist response');
  }
  return {
    enabled: raw.enabled !== false,
    allowed: raw.allowed.filter((s): s is string => typeof s === 'string'),
  };
}

/**
 * 文本复制（剪贴板 API 优先，失败回退 textarea + execCommand；永远不抛异常）。
 * 供轻量文本（应用标识）、超长预填链接及后端提交载荷的复制兜底使用；
 * 载荷文本由后端命令产出，调用方只原样复制，不重新格式化。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退 textarea 方案
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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

// 移入草稿启发式预填（仅预填可编辑，提交前人工校对）：有真值绝不覆盖（源非空优先），仅空时填猜测。
// 参考后端 scanner/guess_category 的轻量前端版（不照抄后端）：
// - platforms：源非空即用（归一小写去重，过滤 `other`），否则按名猜桌面最小集；
// - identifiers：按有效 platforms（未知则 windows/macos/linux）填 exe/裸名候选；
// - install_dirs：`[Repo, lower]` 去重；search_subdirs：默认 8 项中高频子集 `["bin"]`；
// - publishers：无源不猜，保守填 owner 美化（首字母大写，可编辑）；
// - aliases：`[name, repo, owner/repo]` 小写去重；
// - category：源非空原样保留，仅空时用轻量关键词表猜 + `category_name` 同步。

/** 桌面默认三端（platforms 未知 + identifiers 未知键回退共用）。 */
const DRAFT_DESKTOP_PLATFORMS = ['windows', 'macos', 'linux'];

/** 默认检索子目录高频子集（后端 `default_search_subdirs` 8 项中的最高频）。 */
const DRAFT_SEARCH_SUBDIRS = ['bin'];

/** 分类 key → 中文名（与后端 `guess_category` 的 `CategoryMeta.name` 同值）。 */
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

/** platforms 为空时按名猜桌面最小集（显式单端命中即收窄，否则回退三端；保持可编辑）。 */
function guessDraftPlatformsFromName(repo: string, name: string, extra = ''): string[] {
  const text = `${repo} ${name} ${extra}`.toLowerCase();
  const hasAndroid = text.includes('android');
  const hasIos =
    text.includes('ios') || text.includes('iphone') || text.includes('ipad');
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

/** Windows 可执行候选（原生大小写 + 小写 + 去分隔小写，轻量版不含 `64/-x64` 变体）。 */
function draftExeCandidates(base: string): string[] {
  const b = cleanCoord(base);
  if (!b) return [];
  const lower = b.toLowerCase();
  const clean = lower.replace(/[.\-]+/g, '');
  const out = [`${b}.exe`, `${lower}.exe`];
  if (clean && clean !== lower) out.push(`${clean}.exe`);
  return [...new Set(out.filter((s) => s.trim() !== ''))];
}

/** 非 Windows 裸名候选（原生 + 小写 + 去分隔小写，去重保序）。 */
function draftBareCandidates(base: string): string[] {
  const b = cleanCoord(base);
  if (!b) return [];
  const lower = b.toLowerCase();
  const clean = lower.replace(/[.\-]+/g, '');
  return [...new Set([b, lower, clean].filter((s) => s && s.trim() !== ''))];
}

/** 按有效 platforms 生成 identifiers（windows 取 exe，其余取裸名；`other` 永不进键）。 */
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

/** owner 美化为发行商（按 `-/_/./空格` 切分后首字母大写，其余保持；保守可编辑）。 */
function buildDraftPublishers(owner: string): string[] {
  const t = cleanCoord(owner);
  if (!t) return [];
  const parts = t.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const beautified = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return beautified ? [beautified] : [];
}

/** 别名预填（`[name, repo, owner/repo]` 小写去重，空项丢弃）。 */
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

/** 轻量分类关键词表（与后端 `guess_category` 同序：system/network/media/security/dev/graphics/office/reading/ops/games）。 */
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

/**
 * 由在线 AppSummary 合成草稿 payload（一键“移入收录”入口）：
 * - id 取 canonical（小写 owner/repo），与坐标对齐；
 * - status 由后端定为 draft，此处仅备 payload；
 * - icon 仅保留远程 http(s) 真值，base64/data:/空/相对路径一律置空（后续详情 icon 链回填），有真值不覆盖；
 * - platforms 源非空即用（归一小写），否则按名猜桌面最小集（可编辑）；
 * - identifiers/install_dirs/search_subdirs/publishers/aliases/category 仅空时启发式预填，
 *   有真值绝不覆盖，提交前须在编辑页人工校对；
 * - homepage 缺失回退 `https://github.com/owner/repo`；license 缺失回退 `OpenSource`
 *   占位（诚实占位，不伪造 MIT；后端暂存档放行，提交前须在编辑页补真实 SPDX）；
 * - category 非空原样保留（含 external/dev），为空才按关键词猜 + `category_name` 同步。
 */
// iconRemote: restoreOrFetchIconCycle().remote_url remote truth (http only), takes precedence over app.icon (M2 data: display state).
export function buildCustomDraftItemFromSummary(app: AppSummary, iconRemote?: unknown): CustomCatalogItem {
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
        : 'linear-gradient(135deg, #475569, #334155)',
    description,
    description_en: descriptionEn,
    category,
    category_name,
    aliases: buildDraftAliases(draftName, repo, owner),
    default_version: cleanCoord(app.latest_version) || 'v0.1.0',
    // 未知协议诚实占位（未收录卡本就携带 `OpenSource`）：暂存档放行，提交前补真实 SPDX。
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

/**
 * 由趋势未收录行（TrendRepo）合成草稿 payload：同上，stars/forks 取榜单值，
 * 描述缺失回退名称，homepage 回退 GitHub 坐标页；榜单无协议信息，license 恒
 * `OpenSource` 占位（暂存档放行，提交前须在编辑页补真实 SPDX）。
 * icon 恒置空（仅允许远程 http(s)，榜单无图标输入，后续详情 icon 链回填）。
 * 空字段按 repo/name 启发式预填（platforms 按名猜桌面最小集，category 按关键词猜），
 * 均为可编辑预填，提交前人工校对。
 */
export function buildCustomDraftItemFromTrendRepo(repo: {
  owner: string;
  repo: string;
  name?: string;
  stars?: number;
  forks?: number;
  description?: string | null;
  url?: string | null;
}): CustomCatalogItem {
  const owner = cleanCoord(repo.owner);
  const repoName = cleanCoord(repo.repo) || cleanCoord(repo.name ?? '');
  const id = canonicalDraftId(owner, repoName);
  const stars = typeof repo.stars === 'number' && Number.isFinite(repo.stars) ? repo.stars : 0;
  const forks = typeof repo.forks === 'number' && Number.isFinite(repo.forks) ? repo.forks : 0;
  const homepage =
    typeof repo.url === 'string' && repo.url.trim().startsWith('http')
      ? repo.url.trim()
      : `https://github.com/${owner}/${repoName}`;
  const draftName = cleanCoord(repo.name) || repoName;
  const description = cleanCoord(repo.description ?? '') || repoName;
  const { category, category_name } = resolveDraftCategory(
    '',
    '',
    `${draftName} ${repoName} ${description}`,
  );
  const platforms = guessDraftPlatformsFromName(repoName, draftName, description);
  const idBase = repoName || draftName;
  return {
    id,
    name: draftName,
    owner,
    repo: repoName,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description,
    description_en: null,
    category,
    category_name,
    aliases: buildDraftAliases(draftName, repoName, owner),
    default_version: 'v0.1.0',
    license: 'OpenSource',
    stars,
    forks,
    is_verified: false,
    homepage,
    install_dirs: buildDraftInstallDirs(repoName),
    search_subdirs: [...DRAFT_SEARCH_SUBDIRS],
    publishers: buildDraftPublishers(owner),
    platforms,
    identifiers: buildDraftIdentifiers(idBase, platforms),
  };
}
