import { listen } from '@tauri-apps/api/event';
import { zlogWarn } from '../../lib/z-log';
import type { IconReadyPayload } from '../iconStore';
import type { DraftEntryWire, DraftItemWire } from '../custom';
import type {
  AffinityProfileSummary,
  AppDetail,
  AppMatchResult,
  AppSummary,
  FeaturedPage,
  FeedbackScope,
  ImportAppRequest,
  ProfileState,
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

export async function getAffinityProfileSummary(): Promise<AffinityProfileSummary> {
  const raw = await tauriInvoke<AffinityProfileSummary | null>(CMD.getAffinityProfileSummary);
  return {
    enabled: raw?.enabled !== false,
    starred_repo_count: Number(raw?.starred_repo_count) || 0,
    forked_repo_count: Number(raw?.forked_repo_count) || 0,
    owned_repo_count: Number(raw?.owned_repo_count) || 0,
    favorites_count: Number(raw?.favorites_count) || 0,
    watched_count: Number(raw?.watched_count) || 0,
    top_categories: Array.isArray(raw?.top_categories) ? raw.top_categories : [],
    top_languages: Array.isArray(raw?.top_languages) ? raw.top_languages : [],
    last_synced_at: typeof raw?.last_synced_at === 'number' ? raw.last_synced_at : null,
    installed_count: optionalCount(raw?.installed_count),
    viewed_count: optionalCount(raw?.viewed_count),
    search_query_count: optionalCount(raw?.search_query_count),
    interest_seeds: Array.isArray(raw?.interest_seeds) ? raw.interest_seeds : undefined,
    feedback_count: optionalCount(raw?.feedback_count),
    signal_count: optionalCount(raw?.signal_count),
  };
}

/** 旧后端缺字段时保持 `undefined`，供看板隐藏对应行。 */
function optionalCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const PROFILE_STATES: readonly ProfileState[] = ['off', 'cold', 'warm', 'rich'];

/**
 * 精选页整页货架。`allowedIds` 为 App 层平台筛选后的可见应用 id（缺省 = 不限制）。
 */
export async function getFeaturedPage(daySeed: number, allowedIds?: readonly string[]): Promise<FeaturedPage> {
  const args: Record<string, unknown> = { daySeed };
  if (allowedIds) args.allowedIds = [...allowedIds];
  const raw = await tauriInvoke<Partial<FeaturedPage> | null>(CMD.getFeaturedPage, args);
  const state = PROFILE_STATES.includes(raw?.profile_state as ProfileState)
    ? (raw?.profile_state as ProfileState)
    : 'off';
  return {
    profile_state: state,
    signal_count: Number(raw?.signal_count) || 0,
    top_categories: Array.isArray(raw?.top_categories) ? raw.top_categories : [],
    hero: Array.isArray(raw?.hero) ? raw.hero : [],
    shelves: Array.isArray(raw?.shelves) ? raw.shelves : [],
  };
}

export async function saveInterestSeeds(categories: readonly string[]): Promise<void> {
  await tauriInvoke<void>(CMD.saveInterestSeeds, { categories: [...categories] });
}

export async function getInterestSeeds(): Promise<string[]> {
  const raw = await tauriInvoke<string[] | null>(CMD.getInterestSeeds);
  return Array.isArray(raw) ? raw : [];
}

export async function dismissFeatured(target: string, scope: FeedbackScope): Promise<void> {
  await tauriInvoke<void>(CMD.dismissFeatured, { target, scope });
}

export async function clearFeedFeedback(): Promise<number> {
  return Number(await tauriInvoke<number>(CMD.clearFeedFeedback)) || 0;
}

export async function syncAffinitySignals(): Promise<number> {
  return tauriInvoke<number>(CMD.syncAffinitySignals);
}

export async function resetAffinityProfile(): Promise<boolean> {
  const res = await tauriInvoke<boolean>(CMD.resetAffinityProfile);
  return res !== false;
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

export async function onIconReady(
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

/** 最新入库应用分页默认页大小：与发现页/类别页对齐（20/页）。 */
export const LATEST_APPS_PER_PAGE = 20;

export interface LatestAppsWindow {
  minDays?: number;
  maxDays?: number;
  sinceDays?: number;
}

export async function getLatestCatalogApps(
  windowOrSince?: number | LatestAppsWindow,
  page?: number,
  perPage?: number,
): Promise<HomeFeedResult> {
  const args: Record<string, unknown> = {};
  if (typeof windowOrSince === 'number') {
    args.sinceDays = windowOrSince;
    args.maxDays = windowOrSince;
  } else if (windowOrSince && typeof windowOrSince === 'object') {
    if (windowOrSince.minDays !== undefined && windowOrSince.minDays !== null) {
      args.minDays = windowOrSince.minDays;
    }
    if (windowOrSince.maxDays !== undefined && windowOrSince.maxDays !== null) {
      args.maxDays = windowOrSince.maxDays;
    }
    if (windowOrSince.sinceDays !== undefined && windowOrSince.sinceDays !== null) {
      args.sinceDays = windowOrSince.sinceDays;
    }
  }
  if (page !== undefined && page !== null) args.page = page;
  if (perPage !== undefined && perPage !== null) args.perPage = perPage;
  const raw = await tauriInvoke<HomeFeedRaw>(CMD.getLatestCatalogApps, args);
  const items = Array.isArray(raw?.items) ? (raw as { items: AppSummary[] }).items : [];
  const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length;
  return { items, total, has_more: raw?.has_more === true };
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
 * 草稿线格式别名（唯一定义见 `services/custom.ts`）：
 * `CustomCatalogItem` = payload，`CustomAppEntry` = 后端行。
 */
type CustomCatalogItem = DraftItemWire;
type CustomAppEntry = DraftEntryWire;

/** 草稿列表（默认仅未归档；includeArchived=true 含转正归档行）。 */
export async function listCustomApps(includeArchived = false): Promise<CustomAppEntry[]> {
  return tauriInvoke<CustomAppEntry[]>(CMD.listCustomApps, {
    includeArchived,
  });
}

/**
 * 草稿暂存（新建行 status=draft；已存在行仅刷新 payload）。
 * 调用方须保证 id 为 canonical 小写且与 owner/repo 对齐（见 `services/custom.ts#buildCustomDraftItemFromSummary`）。
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
 * 本地收录（唯一命令面 `collect_local_app`：收录档校验后 status=collected，
 * 已收录仍 is_verified=false）：仅发 {id}（camelCase 单键，snake 后端桥接）。
 */
export async function collectLocalApp(id: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.collectLocalApp, { id });
}

/**
 * 本地收录退回草稿（后端 `revert_collected_to_draft` 落盘：status=draft + pr_url 清空）：
 * 仅发 {id}（camelCase 单键，snake 后端桥接）。失败由调用方 toast 报错，禁止静默本地翻态。
 */
export async function revertCollectedApp(id: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.revertCollectedApp, { id });
}

/**
 * 标记为未提交（后端 `withdraw_submitted` 落盘：submitted → collected、pr_url 清空，payload 不变）：
 * 仅发 {id}（camelCase 单键，snake 后端桥接）。Issue 需用户在 GitHub 自行关闭；失败由调用方 toast。
 */
export async function withdrawSubmitted(id: string): Promise<CustomAppEntry> {
  return tauriInvoke<CustomAppEntry>(CMD.withdrawSubmitted, { id });
}

/** 收录申请预填链接：由草稿 payload 生成清单仓库 Issue 预填 URL。 */
export async function getCustomAppPrUrl(id: string): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppPrUrl, { id });
}

/**
 * 单条提交载荷（后端序列化的 JSON 对象文本）：预填链接超长时直接复制给用户。
 * 前端只原样透传字符串，不自行拼装/格式化 JSON。
 */
export async function getCustomAppPrPayload(id: string): Promise<string> {
  return tauriInvoke<string>(CMD.getCustomAppPrPayload, { id });
}

/**
 * 许可名单只读查询（ADR-0018）：名单唯一源头为后端编译时配置。
 * 前端 SubmitStrict 校验（提交 Issue/预填前）经此拉取；调用失败由调用方视为
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
