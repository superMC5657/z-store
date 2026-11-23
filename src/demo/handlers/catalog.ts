import {
  confidenceTierForScore,
  type AffinityProfileSummary,
  type AppDetail,
  type AppMatchResult,
  type AppSummary,
  type HydratedRepoCard,
  type ImportAppRequest,
  type MatchReason,
  type RecommendationReason,
  type SearchListCacheEntry,
  type SimilarAppItem,
  type SimilarAppsResponse,
  type SyncCatalogResult,
} from '../../types';
import type { AppIconCycleResult, PlatformsLiteResult, ReadmeVariantsResult } from '../../services/api';
import { resolveAlternatives } from '../alternatives';
import {
  catalogAliases,
  demoExternalFallback,
  findExternalTrend,
  findSummary,
  summaries,
  toDetail,
} from '../fixtures';
import { canonicalAppId } from '../../services/normalizeId';
import {
  demoStore,
  findCatalogedSummary,
  persistDemo,
  placeholderSummary,
  resolveAnyAppSummary,
  visibleCatalogSummaries,
} from '../demoState';
import { argNum, argStr, nowSecs, warnUnknownArgs, type InvokeArgs, rankSummariesForFeed } from './common';

function demoSearchScore(s: AppSummary, q: string): number {
  const nameLower = s.name.toLowerCase();
  if (nameLower === q || s.id.toLowerCase() === q) return 100;
  if (nameLower.startsWith(q)) return 60;
  if (nameLower.includes(q)) return 40;
  if ((s.alternatives ?? []).some((alt) => alt.toLowerCase().includes(q))) return 38;
  if (s.owner.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q)) return 30;
  if (
    q.length >= 2 &&
    (s.description.toLowerCase().includes(q) || (s.description_en ?? '').toLowerCase().includes(q))
  ) {
    return 20;
  }
  return 0;
}

export function handleSearchApps(a: InvokeArgs): AppSummary[] {
  const q = argStr(a, 'query').trim().toLowerCase();
  const summaries = visibleCatalogSummaries();
  let matched: AppSummary[];
  if (!q) {
    matched = [...summaries].sort((x, y) => y.stars - x.stars);
  } else {
    const catHits = summaries.filter(
      (s) => s.category.toLowerCase() === q || s.category_name.toLowerCase() === q,
    );
    if (catHits.length > 0) {
      matched = [...catHits].sort((x, y) => y.stars - x.stars);
    } else {
      matched = summaries
        .map((s) => ({ s, score: demoSearchScore(s, q) }))
        .filter((e) => e.score > 0)
        .sort((x, y) => y.score - x.score || y.s.stars - x.s.stars)
        .map((e) => e.s);
    }
  }
  const limit = argNum(a, 'limit');
  const offset = argNum(a, 'offset');
  if (limit === undefined && offset === undefined) return matched;
  const start = Math.max(0, Math.floor(offset ?? 0));
  const len = limit === undefined ? matched.length - start : Math.max(0, Math.floor(limit));
  return matched.slice(start, start + len);
}

export function handleGetHomeFeed(a: InvokeArgs): {
  items: AppSummary[];
  total: number;
  has_more: boolean;
} {
  const limit = Math.min(100, Math.max(1, Math.floor(argNum(a, 'limit') ?? 20)));
  const offset = Math.max(0, Math.floor(argNum(a, 'offset') ?? 0));
  const seed = Math.floor(argNum(a, 'seed') ?? 0);
  const ranked = rankSummariesForFeed(visibleCatalogSummaries(), seed, a['strategy']);
  const items = ranked.slice(offset, offset + limit);
  return { items, total: ranked.length, has_more: offset + items.length < ranked.length };
}

export function handleGetAffinityProfileSummary(): AffinityProfileSummary {
  const saved = demoStore().settings;
  const on = (key: string) => saved[key] !== 'false' && saved[key] !== '0';
  const localEnabled = on('enable_local_affinity');
  const githubEnabled = on('enable_github_affinity');
  return {
    enabled: localEnabled || githubEnabled,
    local_enabled: localEnabled,
    github_enabled: githubEnabled,
    starred_repo_count: 0,
    forked_repo_count: 0,
    owned_repo_count: 0,
    favorites_count: 0,
    watched_count: 0,
    top_categories: [],
    top_languages: [],
    last_synced_at: null,
  };
}

export function handleSearchAppsOnline(a: InvokeArgs): { rows: AppSummary[]; sid: string } {
  warnUnknownArgs(['query', 'searchId', 'page', 'perPage', 'forceRefresh'], a, 'handleSearchAppsOnline');
  // Mock 回声：直透前端 `searchId` 为 `sid`（与 Rust `OnlineSearchResult` 同形收敛）。
  const sid = argStr(a, 'searchId');
  const qRaw = argStr(a, 'query').trim();
  if (!qRaw) return { rows: [], sid };
  const rawPer = argNum(a, 'perPage');
  const rawPage = argNum(a, 'page');
  const perPage = rawPer === undefined ? 20 : Math.min(50, Math.max(1, Math.floor(rawPer)));
  const page =
    rawPage === undefined || !Number.isFinite(rawPage) || Math.floor(rawPage) < 1
      ? 1
      : Math.floor(rawPage);
  if (qRaw.includes('/')) {
    const exact = findSummary(qRaw);
    if (exact) return { rows: page === 1 ? [exact] : [], sid };
  }
  const q = qRaw.toLowerCase();
  const matched = summaries.filter((s) =>
    `${s.id} ${s.name} ${s.description} ${s.description_en ?? ''} ${s.owner} ${s.repo} ${s.category_name}`
      .toLowerCase()
      .includes(q),
  );
  const start = (page - 1) * perPage;
  return { rows: matched.slice(start, start + perPage), sid };
}

export function handleEnrichTrendRepos(a: InvokeArgs): (AppSummary | null)[] {
  const repos = Array.isArray(a['repos']) ? (a['repos'] as Array<{ owner?: string; repo?: string }>) : [];
  return repos.map((r) => {
    const owner = String(r?.owner ?? '').trim();
    const repo = String(r?.repo ?? '').trim();
    if (!owner || !repo) return null;
    const o = owner.toLowerCase();
    const ro = repo.toLowerCase();
    const hit = summaries.find((s) => s.owner.toLowerCase() === o && s.repo.toLowerCase() === ro) ?? null;
    if (hit) return hit;
    const ext = findExternalTrend(o, ro);
    if (ext) return demoExternalFallback(ext);
    return demoExternalFallback({
      owner,
      repo,
      desc: `${owner}/${repo}`,
      lang: 'TypeScript',
      stars: 0,
      forks: 0,
      gain: 0,
      icon: '',
      platforms: ['windows'],
    });
  });
}

export function handleGetPlatformsLite(a: InvokeArgs): PlatformsLiteResult {
  const id = argStr(a, 'id');
  const hit = findCatalogedSummary(id);
  if (hit) {
    return {
      id: hit.id,
      platforms: [...(hit.platforms ?? [])],
      from_cache: true,
      is_stale: null,
    };
  }
  // 快照里的趋势仓库：平台是离线探测结果，按缓存命中返回（空 = 确认无二进制发布），
  // 前端据此立即落定，而不是一直占位到 settle 兜底。其余未知仓库仍是「待探测」。
  const slash = id.indexOf('/');
  const ext = slash > 0 ? findExternalTrend(id.slice(0, slash), id.slice(slash + 1)) : undefined;
  if (ext) return { id, platforms: [...ext.platforms], is_stale: false, from_cache: true };
  return { id, platforms: [], is_stale: true, from_cache: false };
}

/** 已确认图标：目录应用取目录图标，趋势快照仓库取离线探测图标；都没有即 null（前端落 L5）。 */
export function handleGetConfirmedIconsBatch(a: InvokeArgs): (string | null)[] {
  warnUnknownArgs(['ids'], a, 'handleGetConfirmedIconsBatch');
  const ids = Array.isArray(a['ids']) ? (a['ids'] as unknown[]) : [];
  return ids.map((raw) => {
    const id = typeof raw === 'string' ? raw : '';
    const slash = id.indexOf('/');
    const icon = findCatalogedSummary(id)?.icon
      ?? (slash > 0 ? findExternalTrend(id.slice(0, slash), id.slice(slash + 1))?.icon : undefined);
    return icon ? icon : null;
  });
}

/** 演示站没有磁盘缓存：原样返回远端地址（与后端取缓存失败时的回落一致）。 */
export function handleFetchOrCacheAssetUrl(a: InvokeArgs): string {
  warnUnknownArgs(['appId', 'url'], a, 'handleFetchOrCacheAssetUrl');
  return argStr(a, 'url');
}

/** 精选、本地库、开源广场、趋势卡片与任意合法坐标都能打开详情；仅无法解析的 id 报错。 */
export function handleGetAppDetails(a: InvokeArgs): AppDetail {
  warnUnknownArgs(['id', 'forceRefresh'], a, 'handleGetAppDetails');
  const id = argStr(a, 'id');
  const hit = resolveAnyAppSummary(id);
  if (!hit) throw new Error(`demo: unknown app "${id}"`);
  return toDetail(hit);
}

// DB-only 批量回填 demo 同形（与后端 `get_cached_app_details_batch` 同语义）：
// 逐 id 归一查收录快照，命中即摘要行、无行即 null，与入参一一对齐，永不抛错。
export function handleGetCachedAppDetailsBatch(a: InvokeArgs): (AppSummary | null)[] {
  const raw = a['ids'];
  const ids: unknown[] = Array.isArray(raw) ? raw : [];
  return ids.map((id) =>
    typeof id === 'string' && id.trim() !== '' ? findCatalogedSummary(id) ?? null : null,
  );
}

/** demo 单仓富卡批量水合：只投影已知卡片（不合成占位，DB-only 同语义，与入参一一对齐）。 */
export function handleGetRepoCardsBatch(a: InvokeArgs): (HydratedRepoCard | null)[] {
  const raw = a['ids'];
  const ids: unknown[] = Array.isArray(raw) ? raw : [];
  const now = nowSecs();
  return ids.map((id) => {
    if (typeof id !== 'string' || id.trim() === '') return null;
    const summary = resolveAnyAppSummary(id, { placeholder: false });
    return summary ? { summary, confirmed_other: false, updated_at: now } : null;
  });
}

/** demo 在线搜索列表快照：会话态透存（刷新页面即清空），与后端 64 KiB 上限同口径。 */
const DEMO_SEARCH_LIST_MAX_BYTES = 64 * 1024;

export function handleGetSearchListCache(a: InvokeArgs): SearchListCacheEntry | null {
  const key = argStr(a, 'cacheKey').trim();
  const row = key ? demoStore().searchListCache.get(key) : undefined;
  return row
    ? { payload_json: row.payload_json, cached_at: row.cached_at, has_private: row.has_private }
    : null;
}

export function handleSaveSearchListCache(a: InvokeArgs): null {
  const key = argStr(a, 'cacheKey').trim();
  const normQuery = argStr(a, 'normQuery').trim();
  const payload = argStr(a, 'payloadJson').trim();
  if (!key || !normQuery || !payload) return null;
  if (new TextEncoder().encode(payload).length > DEMO_SEARCH_LIST_MAX_BYTES) {
    throw new Error('search_list_payload_too_large');
  }
  demoStore().searchListCache.set(key, {
    payload_json: payload,
    cached_at: Math.floor(Date.now() / 1000),
    has_private: a['hasPrivate'] === true,
  });
  return null;
}

export function handleGetReadmeVariants(a: InvokeArgs): ReadmeVariantsResult {
  const id = argStr(a, 'appId');
  const hit = resolveAnyAppSummary(id, { placeholder: false });
  const name = hit?.name ?? id;
  const zh = `# ${name}\n\n${hit?.description ?? ''}\n\n> Live-demo bundle: full README unavailable offline.`;
  const en = `# ${name}\n\n${hit?.description_en ?? hit?.description ?? ''}\n\n> Live-demo bundle.`;
  return {
    variants: [
      { lang: 'zh-CN', path: 'README.md', markdown: zh },
      { lang: 'en-US', path: 'README.en.md', markdown: en },
    ],
  };
}

export function handleGetAppIconCycle(a: InvokeArgs, cmd: string): AppIconCycleResult | null {
  const id = argStr(a, 'appId');
  const hit = findCatalogedSummary(id);
  if (!hit) return null;
  const key = hit.id.toLowerCase();
  const { iconLevel } = demoStore();
  const level = cmd === 'cycle_app_icon' ? (iconLevel.get(key) ?? 0) + 1 : (iconLevel.get(key) ?? 0);
  if (cmd === 'cycle_app_icon') iconLevel.set(key, level);
  return {
    url: hit.icon,
    level,
    source: 'catalog',
    remote_url: hit.icon,
    is_fallback: false,
    total_levels: 1,
    is_cataloged: true,
  };
}

export function handleGetOrFetchIcon(a: InvokeArgs): string {
  warnUnknownArgs(['appId', 'remoteUrl'], a, 'handleGetOrFetchIcon');
  const remote = argStr(a, 'remoteUrl');
  if (remote) return remote;
  const appId = argStr(a, 'appId');
  return findCatalogedSummary(appId)?.icon ?? '';
}

type FilteredFeedPage = {
  items: AppSummary[];
  total: number;
  has_more: boolean;
  matched_ids: string[];
};

/** 与后端分页逻辑一致：`matched_ids` 为过滤前全集，传入 `allowedIds` 数组时过滤后再分页。 */
function paginateWithAllowedIds(matched: AppSummary[], a: InvokeArgs): FilteredFeedPage {
  const matched_ids = matched.map((s) => s.id);
  const rawAllowed = a['allowedIds'];
  let filtered = matched;
  if (Array.isArray(rawAllowed)) {
    const allowed = new Set(
      rawAllowed
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id !== ''),
    );
    filtered = matched.filter((s) => allowed.has(s.id.toLowerCase()));
  }
  const rawPer = argNum(a, 'perPage');
  const rawPage = argNum(a, 'page');
  const perPage = rawPer === undefined ? 20 : Math.min(50, Math.max(1, Math.floor(rawPer)));
  const page =
    rawPage === undefined || !Number.isFinite(rawPage) || Math.floor(rawPage) < 1
      ? 1
      : Math.floor(rawPage);
  const start = (page - 1) * perPage;
  const items = filtered.slice(start, start + perPage);
  return {
    items,
    total: filtered.length,
    has_more: start + items.length < filtered.length,
    matched_ids,
  };
}

export function handleGetCategoryApps(a: InvokeArgs): FilteredFeedPage {
  // Mock 与 Rust `get_category_apps` 同形；分类过滤仅 `category` 相等。
  warnUnknownArgs(['category', 'page', 'perPage', 'allowedIds'], a, 'handleGetCategoryApps');
  const category = argStr(a, 'category').toLowerCase();
  if (!category) return { items: [], total: 0, has_more: false, matched_ids: [] };
  const matched = visibleCatalogSummaries().filter((s) => s.category.toLowerCase() === category);
  return paginateWithAllowedIds(matched, a);
}

export function handleGetLatestCatalogApps(a: InvokeArgs): FilteredFeedPage {
  warnUnknownArgs(
    ['sinceDays', 'minDays', 'maxDays', 'page', 'perPage', 'allowedIds'],
    a,
    'handleGetLatestCatalogApps',
  );
  const rawMin = argNum(a, 'minDays');
  const rawMax = argNum(a, 'maxDays');
  const rawSince = argNum(a, 'sinceDays');
  const minDays =
    rawMin !== undefined && Number.isFinite(rawMin) && rawMin >= 0
      ? Math.floor(rawMin)
      : 0;
  const maxDays =
    rawMax !== undefined && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : (rawSince !== undefined && Number.isFinite(rawSince) && rawSince > 0
        ? Math.floor(rawSince)
        : undefined);

  const catalog = visibleCatalogSummaries();
  let matched = [...catalog];
  if (maxDays !== undefined || minDays > 0) {
    const today = new Date();
    const currentDays = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86400000);

    const parseItemDays = (dateStr?: string): number | null => {
      if (!dateStr) return null;
      const parts = dateStr.split('-').map(Number);
      if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
      return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
    };

    let baseDays = currentDays;
    const maxItemDays = catalog.reduce<number | null>((acc, s) => {
      const d = parseItemDays(s.added_at);
      if (d === null) return acc;
      return acc === null || d > acc ? d : acc;
    }, null);

    if (maxItemDays !== null && currentDays > maxItemDays) {
      baseDays = maxItemDays;
    }

    matched = matched.filter((s) => {
      const itemDays = parseItemDays(s.added_at);
      if (itemDays === null) return false;
      const diff = baseDays - itemDays;
      const lowerOk = minDays > 0 ? diff > minDays : diff >= -1;
      const upperOk = maxDays !== undefined ? diff <= maxDays : true;
      return lowerOk && upperOk;
    });
  }

  matched.sort((x, y) => {
    if (x.added_at && y.added_at) {
      const cmp = y.added_at.localeCompare(x.added_at);
      if (cmp !== 0) return cmp;
    } else if (x.added_at && !y.added_at) {
      return -1;
    } else if (!x.added_at && y.added_at) {
      return 1;
    }
    const starDiff = (y.stars ?? 0) - (x.stars ?? 0);
    if (starDiff !== 0) return starDiff;
    return x.id.localeCompare(y.id);
  });

  return paginateWithAllowedIds(matched, a);
}

/** 演示扫描样例：本机原名、版本、路径与匹配依据均按真实安装形态编写。 */
interface DemoScanSample {
  id: string;
  displayName: string;
  version: string;
  publisher?: string;
  location: string;
  executable?: string;
  confidence: number;
  reasons: MatchReason[];
}

const DEMO_SCAN_SAMPLES: readonly DemoScanSample[] = [
  {
    id: 'microsoft/vscode',
    displayName: 'Microsoft Visual Studio Code (User)',
    version: '1.92.0',
    publisher: 'Microsoft Corporation',
    location: 'C:\\Users\\Demo\\AppData\\Local\\Programs\\Microsoft VS Code',
    executable: 'C:\\Users\\Demo\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    confidence: 1,
    reasons: ['exact_name', 'executable', 'publisher'],
  },
  {
    id: 'obsproject/obs-studio',
    displayName: 'OBS Studio',
    version: '30.2.3',
    publisher: 'OBS Project',
    location: 'C:\\Program Files\\obs-studio',
    executable: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    confidence: 1,
    reasons: ['exact_name', 'executable', 'install_dir', 'publisher'],
  },
  {
    id: 'notepad-plus-plus/notepad-plus-plus',
    displayName: 'Notepad++ (64-bit x64)',
    version: '8.6.9',
    publisher: 'Notepad++ Team',
    location: 'C:\\Program Files\\Notepad++',
    executable: 'C:\\Program Files\\Notepad++\\notepad++.exe',
    confidence: 1,
    reasons: ['exact_name', 'executable'],
  },
  {
    id: 'vscodium/vscodium',
    displayName: 'VSCodium (User)',
    version: '1.92.0',
    location: 'C:\\Users\\Demo\\AppData\\Local\\Programs\\VSCodium',
    executable: 'C:\\Users\\Demo\\AppData\\Local\\Programs\\VSCodium\\VSCodium.exe',
    confidence: 1,
    reasons: ['exact_name', 'executable', 'install_dir'],
  },
  {
    id: 'desktop/desktop',
    displayName: 'GitHub Desktop',
    version: '3.4.8',
    publisher: 'GitHub, Inc.',
    location: 'C:\\Users\\Demo\\AppData\\Local\\GitHubDesktop',
    executable: 'C:\\Users\\Demo\\AppData\\Local\\GitHubDesktop\\app-3.4.8\\GitHubDesktop.exe',
    confidence: 0.62,
    reasons: ['exact_name', 'version'],
  },
  {
    id: 'siyuan-note/siyuan',
    displayName: '思源笔记',
    version: '3.1.0',
    location: 'D:\\SiYuan',
    executable: 'D:\\SiYuan\\SiYuan.exe',
    confidence: 0.48,
    reasons: ['executable'],
  },
];

/** 排除已纳管应用，每个置信度档位最多返回两条扫描匹配。 */
export function handleScanAndMatchLocalApps(): AppMatchResult[] {
  const managed = new Set(demoStore().installed.map((i) => i.app_id.toLowerCase()));
  const perTier: Record<string, number> = {};
  const out: AppMatchResult[] = [];
  for (const sample of DEMO_SCAN_SAMPLES) {
    const s = findSummary(sample.id);
    if (!s || managed.has(s.id.toLowerCase())) continue;
    const tier = confidenceTierForScore(sample.confidence);
    if ((perTier[tier] ?? 0) >= 2) continue;
    perTier[tier] = (perTier[tier] ?? 0) + 1;
    out.push({
      scanned: {
        display_name: sample.displayName,
        display_version: sample.version,
        publisher: sample.publisher,
        install_location: sample.location,
        display_icon: sample.executable,
        source_kind: 'registry',
      },
      catalog_id: s.id,
      name: s.name,
      owner: s.owner,
      repo: s.repo,
      icon: s.icon,
      icon_bg: s.icon_bg,
      description: s.description,
      local_version: sample.version,
      catalog_version: s.latest_version,
      confidence: sample.confidence,
      confidence_tier: tier,
      resolved_executable_path: sample.executable,
      match_reasons: sample.reasons,
    });
  }
  return out;
}

/** 把选中的扫描结果写入演示「我的应用」（同 id 已存在则跳过），返回新增数量。 */
export function handleImportMatchedApps(a: InvokeArgs): number {
  warnUnknownArgs(['apps'], a, 'handleImportMatchedApps');
  const raw = a['apps'];
  const requests = Array.isArray(raw) ? (raw as ImportAppRequest[]) : [];
  const list = [...demoStore().installed];
  const now = nowSecs();
  let imported = 0;
  for (const req of requests) {
    if (typeof req?.app_id !== 'string') continue;
    const s = findSummary(req.app_id);
    const id = s?.id ?? req.app_id;
    if (list.some((i) => i.app_id.toLowerCase() === id.toLowerCase())) continue;
    list.push({
      app_id: id,
      app_name: req.app_name || s?.name || id,
      version: req.version ?? '',
      installed_at: req.installed_at ?? now,
      install_method: 'system_import',
      install_path: req.install_path ?? '',
      asset_name: '',
      asset_sha256: '',
      uninstall_command: req.uninstall_command,
      icon: s?.icon,
      icon_bg: s?.icon_bg,
    });
    imported += 1;
  }
  demoStore().installed = list;
  persistDemo('installed');
  return imported;
}

function setSearchHistory(list: string[]): null {
  demoStore().searchHistory = list;
  persistDemo('searchHistory');
  return null;
}

export function handleRecordSearchQuery(a: InvokeArgs): null {
  const q = argStr(a, 'query').trim();
  if (q) setSearchHistory([q, ...demoStore().searchHistory.filter((x) => x !== q)].slice(0, 20));
  return null;
}

export function handleGetSearchHistory(): string[] {
  return [...demoStore().searchHistory];
}

export function handleClearSearchHistory(): null {
  return setSearchHistory([]);
}

export function handleRemoveSearchQuery(a: InvokeArgs): null {
  const q = argStr(a, 'query');
  return setSearchHistory(demoStore().searchHistory.filter((x) => x !== q));
}

const DEMO_VIEW_DEBOUNCE_SECS = 30;
const DEMO_RECENT_VIEW_LIMIT = 30;

export function handleRecordAppView(a: InvokeArgs): null {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    const store = demoStore();
    const now = nowSecs();
    const prev = store.recentViewTimes[id];
    if (prev !== undefined && now >= prev && now - prev < DEMO_VIEW_DEBOUNCE_SECS) {
      return null;
    }
    store.recentViewTimes = { ...store.recentViewTimes, [id]: now };
    persistDemo('recentViewTimes');
    store.recentIds = [id, ...store.recentIds.filter((x) => x !== id)].slice(0, DEMO_RECENT_VIEW_LIMIT);
    persistDemo('recentViews');
  }
  return null;
}

export function handleGetRecentlyViewedApps(): AppSummary[] {
  const out: AppSummary[] = [];
  const { recentIds, recentViewTimes: times } = demoStore();
  for (const id of recentIds) {
    const hit = resolveAnyAppSummary(id, { placeholder: false });
    if (hit) {
      out.push({
        ...hit,
        viewed_at: times[id.toLowerCase()] ?? 0,
      });
    }
  }
  return out;
}

export function handleSyncCatalog(): SyncCatalogResult {
  return {
    updated: false,
    count: summaries.length,
    message: 'demo: bundled catalog is up to date',
  };
}

export function handleResolveCollectionApps(a: InvokeArgs): AppSummary[] {
  warnUnknownArgs(['appIds'], a, 'handleResolveCollectionApps');
  const raw = a['appIds'];
  const ids = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: AppSummary[] = [];
  for (const item of ids) {
    const cleanId = canonicalAppId(item);
    if (!cleanId || seen.has(cleanId)) continue;
    seen.add(cleanId);
    const hit = findCatalogedSummary(cleanId) ?? placeholderSummary(cleanId);
    if (hit) out.push(hit);
    if (out.length >= 30) break;
  }
  return out;
}

const DEMO_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'open', 'source', 'opensource',
  'free', 'cross', 'platform', 'app', 'apps', 'tool', 'tools', 'desktop', 'client',
  'windows', 'linux', 'macos', 'android', 'ios', 'software', 'based', 'fast', 'simple',
]);

/** 汉字连续段整段作为一个词元（不切双字），因此理由里不会出现双字碎片，无需后端的拼词步骤。 */
function demoTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{3,}|[一-鿿]{2,}/g)) {
    if (!DEMO_STOPWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}

// 以下常量与 `src-tauri/src/github/affinity.rs`、`catalog_service.rs` 中的同名常量一一对应（ADR-0031）。
const RELEVANCE_ALIAS_SHARE = 0.35;
const RELEVANCE_PHRASE_SHARE = 0.3;
const RELEVANCE_TEXT_SHARE = 0.35;
const PHRASE_FULL_HITS = 1.5;
const KEYWORD_RELEVANCE_MIN = 0.15;
const SIM_KEYWORD_SHARE = 0.8;
const SIM_CATEGORY_BONUS = 0.12;
const SIM_OWNER_BONUS = 0.08;
const SIMILAR_MIN_SIMILARITY = 0.2;
const SIMILAR_POPULARITY_TIEBREAK = 0.005;
const SHARED_TOKEN_MIN_IDF = 0.5;
const SHARED_KEYWORDS_MAX = 3;

interface DemoSimilarityTokens {
  text: Set<string>;
  keywords: Set<string>;
  phrases: string[];
  category: string;
  owner: string;
}

type SimilarityInput = Pick<AppSummary, 'id' | 'name' | 'owner' | 'repo' | 'category' | 'description' | 'description_en' | 'alternatives'>;

/** 与后端同形：全文词元（名称、仓库、别名、中英简介）+ 别名 / 平替关键词 + 整条短语。 */
function demoSimilarityTokens(app: SimilarityInput): DemoSimilarityTokens {
  const aliases = catalogAliases.get(app.id.toLowerCase()) ?? [];
  const curated = [...aliases, ...(app.alternatives ?? [])];
  const phrases = Array.from(
    new Set(curated.map((p) => p.trim().split(/\s+/).join(' ').toLowerCase()).filter((p) => p.length >= 2)),
  );
  return {
    text: demoTokens(`${app.name} ${app.repo} ${aliases.join(' ')} ${app.description} ${app.description_en ?? ''}`),
    keywords: demoTokens(curated.join(' ')),
    phrases,
    category: app.category.trim().toLowerCase(),
    owner: app.owner.trim().toLowerCase(),
  };
}

type IdfWeight = (token: string) => number;

/** 目录 IDF：`clamp(ln((N+1)/(df+1)) / ln(N+1), 0.15, 1.0)`，目录里未出现的词记 1。 */
function demoCatalogIdf(docs: readonly DemoSimilarityTokens[]): IdfWeight {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.text) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (t) => {
    const count = df.get(t) ?? 0;
    if (n === 0 || count === 0) return 1;
    return Math.min(1, Math.max(0.15, Math.log((n + 1) / (count + 1)) / Math.log(n + 1)));
  };
}

function cosine(a: Set<string>, b: Set<string>, idf: IdfWeight): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const t of a) {
    const w = idf(t) ** 2;
    normA += w;
    if (b.has(t)) dot += w;
  }
  for (const t of b) normB += idf(t) ** 2;
  const denom = Math.sqrt(normA * normB);
  return denom <= 1e-12 ? 0 : Math.min(1, Math.max(0, dot / denom));
}

const isCjkToken = (t: string) => t.length > 0 && [...t].every((c) => c.charCodeAt(0) > 0x7f);
const isAsciiAlnum = (c: string | undefined) => c !== undefined && /[a-z0-9]/i.test(c);

/** `longer` 是否按词边界包含 `shorter`（`editor` ⊂ `code editor`，`go` ⊄ `google`；纯汉字按子串）。 */
function phraseContains(longer: string, shorter: string): boolean {
  if ([...shorter].length < 2) return false;
  if (isCjkToken(shorter)) return longer.includes(shorter);
  for (let i = longer.indexOf(shorter); i !== -1; i = longer.indexOf(shorter, i + 1)) {
    if (!isAsciiAlnum(longer[i - 1]) && !isAsciiAlnum(longer[i + shorter.length])) return true;
  }
  return false;
}

function sharedPhrases(a: DemoSimilarityTokens, b: DemoSimilarityTokens): string[] {
  return b.phrases.filter((pb) => a.phrases.some((pa) => pa === pb || phraseContains(pa, pb) || phraseContains(pb, pa)));
}

/** 关键词相关度：两侧都有策展关键词时混合别名余弦、短语命中与全文余弦，否则只用全文余弦。 */
function keywordRelevance(a: DemoSimilarityTokens, b: DemoSimilarityTokens, idf: IdfWeight): number {
  const text = cosine(a.text, b.text, idf);
  if (a.keywords.size === 0 || b.keywords.size === 0) return text;
  const phrase = Math.min(1, sharedPhrases(a, b).length / PHRASE_FULL_HITS);
  return RELEVANCE_ALIAS_SHARE * cosine(a.keywords, b.keywords, idf) + RELEVANCE_PHRASE_SHARE * phrase + RELEVANCE_TEXT_SHARE * text;
}

/** 理由关键词：先列命中短语，再列共享的高 IDF 词元（IDF 降序），被短语覆盖的不重复，最多 3 个。 */
function sharedKeywords(seed: DemoSimilarityTokens, cand: DemoSimilarityTokens, idf: IdfWeight): string[] {
  const out = sharedPhrases(seed, cand).slice(0, SHARED_KEYWORDS_MAX);
  const covered = (t: string) => out.some((p) => p === t || phraseContains(p, t));
  const ranked = [...cand.text]
    .filter((t) => seed.text.has(t) && idf(t) >= SHARED_TOKEN_MIN_IDF && !covered(t))
    .sort((x, y) => idf(y) - idf(x) || (x < y ? -1 : x > y ? 1 : 0));
  for (const t of ranked) {
    if (out.length >= SHARED_KEYWORDS_MAX) break;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function handleGetSimilarApps(a: InvokeArgs): SimilarAppsResponse {
  warnUnknownArgs(
    ['appId', 'name', 'owner', 'category', 'description', 'descriptionEn', 'limit'],
    a,
    'handleGetSimilarApps',
  );
  const rawId = argStr(a, 'appId');
  const cleanId = canonicalAppId(rawId) ?? rawId.trim().toLowerCase();
  if (!cleanId) return { target_id: '', target_alternatives: [], items: [] };

  const rawLimit = argNum(a, 'limit');
  const limit = Math.min(8, Math.max(1, Math.floor(rawLimit ?? 4)));
  const hit = findCatalogedSummary(cleanId);
  const coord = placeholderSummary(cleanId);
  const targetAlternatives = resolveAlternatives(hit?.alternatives, cleanId);
  const seed: SimilarityInput = hit ?? {
    id: cleanId,
    name: argStr(a, 'name') || coord?.repo || cleanId,
    owner: argStr(a, 'owner') || coord?.owner || '',
    repo: coord?.repo || cleanId,
    category: argStr(a, 'category').toLowerCase(),
    description: argStr(a, 'description'),
    description_en: argStr(a, 'descriptionEn') || undefined,
    alternatives: targetAlternatives,
  };
  const seedToks = demoSimilarityTokens(seed);
  const candidates = visibleCatalogSummaries().map((app) => ({ app, toks: demoSimilarityTokens(app) }));
  const idf = demoCatalogIdf(candidates.map((c) => c.toks));

  const scored: Array<{ rank: number; item: SimilarAppItem }> = [];
  for (const { app: cand, toks: candToks } of candidates) {
    if (cand.id.toLowerCase() === cleanId) continue;
    // 关键词是主信号：没有足够的共享关键词时，同分类 / 同作者不能单独成立
    const relevance = keywordRelevance(seedToks, candToks, idf);
    if (relevance < KEYWORD_RELEVANCE_MIN) continue;

    const sameCat = seedToks.category !== '' && seedToks.category === candToks.category;
    const sameOwner = seedToks.owner !== '' && seedToks.owner === candToks.owner;
    const sim = SIM_KEYWORD_SHARE * relevance + (sameCat ? SIM_CATEGORY_BONUS : 0) + (sameOwner ? SIM_OWNER_BONUS : 0);
    if (sim < SIMILAR_MIN_SIMILARITY) continue;

    const keywords = sharedKeywords(seedToks, candToks, idf);
    const reasons: RecommendationReason[] = [];
    if (sameOwner) reasons.push({ kind: 'owner', owner: cand.owner.trim() });
    if (keywords.length > 0) reasons.push({ kind: 'keywords', tokens: keywords });
    if (sameCat) reasons.push({ kind: 'category', category: candToks.category });

    // 星数只在同等相关度下做轻微偏好
    const rank = sim + SIMILAR_POPULARITY_TIEBREAK * (Math.log(cand.stars + 1) + 0.25 * Math.log(cand.forks + 1));
    scored.push({
      rank,
      item: {
        app: cand,
        similarity: sim,
        reasons,
        ...(cand.alternatives && cand.alternatives.length > 0 ? { alternatives: cand.alternatives } : {}),
      },
    });
  }

  scored.sort((x, y) => y.rank - x.rank || y.item.app.stars - x.item.app.stars);
  return {
    target_id: cleanId,
    target_alternatives: targetAlternatives,
    items: scored.slice(0, limit).map((e) => e.item),
  };
}
