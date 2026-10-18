import { listen } from '@tauri-apps/api/event';
import { zlogWarn } from '../../lib/z-log';
import type { IconReadyPayload } from '../iconStore';
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
export type SearchIconUpgradePayload = IconReadyPayload;

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

// ---------- Lane C：本地自维护草稿 overlay（ADR-0017） ----------
// 后端已落盘（Lane A）：custom_apps 表 + catalog_custom commands + 合并视图。
// 此处仅做 IPC 封装（CMD 表驱动），视图层禁直调 invoke（见 noDirectInvoke.test.ts）。

/** 自维护草稿 payload（与后端 CatalogItem 同形，is_verified 入库强制 false）。 */
export interface CustomCatalogItem {
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
  identifiers: Record<string, string[]>;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
}

/** 自维护草稿条目（与后端 CustomAppEntry 同形）。 */
export interface CustomAppEntry {
  id: string;
  item: CustomCatalogItem;
  status: string;
  pr_url?: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
}

/** 转正提示（与后端 GraduationNotice 同形）。 */
export interface GraduationNotice {
  id: string;
  message: string;
}

/** 合并目录视图行：AppSummary 扁平 + 来源标记（remote/custom，is_cataloged 恒 true）。 */
export type MergedCatalogEntry = AppSummary & {
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
 * Lane D 一键 PR 链路：批量收录申请预填链接（二期开关）。
 * 选中多条合并为一个 JSON 数组，经一个预填 URL 提交（批量合一 PR）。
 */
export async function getCustomAppsBatchPrUrl(ids: string[]): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppsBatchPrUrl, { ids });
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

// ---------- Lane D：一键 PR 链路纯函数（无 IPC，视图/单测可直用） ----------
// 与后端 build_single_pr_url / build_batch_pr_url 同形：目标同为
// superMC5657/z-store-catalog 预填页，正文含 JSON codeblock + 校验说明；
// 后端不可达（浏览器预览/单测）时的本地同形兜底。

/** 清单仓库收录申请预填页（与后端 CATALOG_REPO_ISSUES_URL 同值）。 */
export const CATALOG_PR_ISSUES_URL =
  'https://github.com/superMC5657/z-store-catalog/issues/new';

/** 本地校验说明（与后端 PR_BODY_CHECK_NOTE 同义）。 */
export const PR_CHECK_NOTE =
  '本地校验：已通过提交档 `validate_custom_item(strict)`（canonical id / 必填字段 / OSI 协议），payload 见下方 JSON。';

/** 预填 URL 的最小条目形态（前后端条目结构均满足此接口）。 */
export interface LocalPrItem {
  name: string;
  owner: string;
  repo: string;
  homepage?: string | null;
  license: string;
  category: string;
  category_name: string;
  default_version: string;
}

export interface LocalPrEntry {
  id: string;
  status?: string;
  item: LocalPrItem;
}

function encodePrUrl(title: string, body: string): string {
  return `${CATALOG_PR_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function homepageOf(item: LocalPrItem): string {
  const h = (item.homepage ?? '').trim();
  return h || `https://github.com/${item.owner.trim()}/${item.repo.trim()}`;
}

/** 单条 PR payload JSON（标准 CatalogItem 片段，pretty 供复制/预填）。 */
export function buildSinglePrPayloadJson(item: unknown): string {
  return JSON.stringify(item, null, 2);
}

/** 批量 PR payload JSON 数组（多条合并为一个预填 URL）。 */
export function buildBatchPrPayloadJson(items: unknown[]): string {
  return JSON.stringify(items, null, 2);
}

/** 本地同形单条预填 URL（与后端 build_single_pr_url 同形）。 */
export function buildLocalSinglePrUrl(entry: LocalPrEntry, payloadJson?: string): string {
  const item = entry.item;
  const payload = payloadJson ?? buildSinglePrPayloadJson(item);
  const body = [
    '## 收录申请（本地自维护草稿预填）',
    '',
    `- 应用：${item.name} (\`${entry.id}\`)`,
    `- 仓库：${item.owner}/${item.repo}`,
    `- 主页：${homepageOf(item)}`,
    `- 协议：${item.license}`,
    `- 分类：${item.category}（${item.category_name}）`,
    `- 版本：${item.default_version}`,
    `- 状态：${entry.status ?? 'draft'}`,
    '',
    PR_CHECK_NOTE,
    '',
    '### payload_json',
    '',
    '```json',
    payload,
    '```',
    '',
  ].join('\n');
  return encodePrUrl(`[收录申请] ${entry.id}`, body);
}

/** 本地同形批量预填 URL（与后端 build_batch_pr_url 同形）。 */
export function buildLocalBatchPrUrl(entries: LocalPrEntry[], payloadJson?: string): string {
  const title = entries.length <= 1 ? '[批量收录申请]' : `[批量收录申请] ${entries.length} 项`;
  const checklist =
    entries.length === 0
      ? '- （暂无条目）'
      : entries.map((e) => `- \`${e.id}\`：校验通过`).join('\n');
  const payload = payloadJson ?? buildBatchPrPayloadJson(entries.map((e) => e.item));
  const body = [
    `## 批量收录申请（本地自维护草稿预填，共 ${entries.length} 项）`,
    '',
    checklist,
    '',
    PR_CHECK_NOTE,
    '',
    '### payload_json',
    '',
    '```json',
    payload,
    '```',
    '',
  ].join('\n');
  return encodePrUrl(title, body);
}

/**
 * 文本复制（剪贴板 API 优先，失败回退 textarea + execCommand；永远不抛异常）。
 * Lane D 单卡“提交 PR”先复制 JSON 再打开预填页。
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

/**
 * 由在线 AppSummary 合成草稿 payload（一键“移入收录”入口）：
 * - id 取 canonical（小写 owner/repo），与坐标对齐；
 * - status 由后端定为 draft，此处仅备 payload；
 * - platforms 恒 []（loading 加载中，复用 lite 确认链，编辑页可手改）；
 * - homepage 缺失回退 `https://github.com/owner/repo`；license 缺失回退 `OpenSource`
 *   占位（诚实占位，不伪造 MIT；后端暂存档放行，提交前须在编辑页补真实 SPDX）；
 * - category 为空回退 dev（external 原样保留，不强制改写）。
 */
export function buildCustomDraftItemFromSummary(app: AppSummary): CustomCatalogItem {
  const owner = cleanCoord(app.owner) || cleanCoord(app.id.split('/')[0] ?? '');
  const repo =
    cleanCoord(app.repo) ||
    cleanCoord(app.id.split('/').slice(1).join('/')) ||
    cleanCoord(app.name);
  const id = canonicalDraftId(owner, repo);
  const category = cleanCoord(app.category) || 'dev';
  return {
    id,
    name: cleanCoord(app.name) || repo,
    owner,
    repo,
    icon: typeof app.icon === 'string' ? app.icon : '',
    icon_bg:
      typeof app.icon_bg === 'string' && app.icon_bg
        ? app.icon_bg
        : 'linear-gradient(135deg, #475569, #334155)',
    description: cleanCoord(app.description) || cleanCoord(app.name) || id,
    description_en:
      typeof app.description_en === 'string' && app.description_en.trim()
        ? app.description_en
        : null,
    category,
    category_name: cleanCoord(app.category_name) || category,
    aliases: [],
    default_version: cleanCoord(app.latest_version) || 'v0.1.0',
    // 未知协议诚实占位（未收录卡本就携带 `OpenSource`）：暂存档放行，提交前补真实 SPDX。
    license: cleanCoord(app.license) || 'OpenSource',
    stars: typeof app.stars === 'number' && Number.isFinite(app.stars) ? app.stars : 0,
    forks: typeof app.forks === 'number' && Number.isFinite(app.forks) ? app.forks : 0,
    is_verified: false,
    homepage: homepageOrGithub(owner, repo, typeof app.homepage === 'string' ? app.homepage : null),
    identifiers: {},
    install_dirs: [],
    search_subdirs: [],
    publishers: [],
    platforms: [],
  };
}

/**
 * 由趋势未收录行（TrendRepo）合成草稿 payload：同上，stars/forks 取榜单值，
 * 描述缺失回退名称，homepage 回退 GitHub 坐标页；榜单无协议信息，license 恒
 * `OpenSource` 占位（暂存档放行，提交前须在编辑页补真实 SPDX）。
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
  return {
    id,
    name: cleanCoord(repo.name) || repoName,
    owner,
    repo: repoName,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: cleanCoord(repo.description ?? '') || repoName,
    description_en: null,
    category: 'dev',
    category_name: 'dev',
    aliases: [],
    default_version: 'v0.1.0',
    license: 'OpenSource',
    stars,
    forks,
    is_verified: false,
    homepage,
    identifiers: {},
    install_dirs: [],
    search_subdirs: [],
    publishers: [],
    platforms: [],
  };
}
