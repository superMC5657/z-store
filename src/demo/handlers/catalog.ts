import {
  confidenceTierForScore,
  type AffinityProfileSummary,
  type AppDetail,
  type AppMatchResult,
  type AppSummary,
  type HydratedRepoCard,
  type ImportAppRequest,
  type MatchReason,
  type SearchListCacheEntry,
  type SyncCatalogResult,
} from '../../types';
import type { AppIconCycleResult, PlatformsLiteResult, ReadmeVariantsResult } from '../../services/api';
import {
  demoExternalFallback,
  findExternalTrend,
  findSummary,
  summaries,
  toDetail,
} from '../fixtures';
import { canonicalAppId } from '../../services/normalizeId';
import { DEFAULT_ICON_BG } from '../../styles/tokens';
import {
  getDemoSettingsSaved,
  getInstalledApps,
  getRecentIds,
  getRecentViewTimes,
  getSearchHistory,
  iconLevel,
  LS,
  lsSet,
  setRecentIds,
  setRecentViewTime,
  setInstalledApps,
  setSearchHistory,
} from '../demoState';
import { argNum, argStr, warnUnknownArgs, type InvokeArgs, rankSummariesForFeed } from './common';

export function handleSearchApps(a: InvokeArgs): AppSummary[] {
  const q = argStr(a, 'query').trim().toLowerCase();
  const matched = !q
    ? [...summaries]
    : summaries.filter((s) =>
        `${s.id} ${s.name} ${s.description} ${s.description_en ?? ''} ${s.owner} ${s.repo} ${s.category_name}`
          .toLowerCase()
          .includes(q),
      );
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
  const ranked = rankSummariesForFeed(seed, a['strategy']);
  const items = ranked.slice(offset, offset + limit);
  return { items, total: ranked.length, has_more: offset + items.length < ranked.length };
}

export function handleGetAffinityProfileSummary(): AffinityProfileSummary {
  const saved = getDemoSettingsSaved();
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
  const hit = findSummary(id);
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
    const icon = findSummary(id)?.icon
      ?? (slash > 0 ? findExternalTrend(id.slice(0, slash), id.slice(slash + 1))?.icon : undefined);
    return icon ? icon : null;
  });
}

/** 演示站没有磁盘缓存：原样返回远端地址（与后端取缓存失败时的回落一致）。 */
export function handleFetchOrCacheAssetUrl(a: InvokeArgs): string {
  warnUnknownArgs(['appId', 'url'], a, 'handleFetchOrCacheAssetUrl');
  return argStr(a, 'url');
}

export function handleGetAppDetails(a: InvokeArgs): AppDetail {
  warnUnknownArgs(['id', 'forceRefresh'], a, 'handleGetAppDetails');
  const id = argStr(a, 'id');
  const hit = findSummary(id);
  if (!hit) throw new Error(`demo: unknown app "${id}"`);
  return toDetail(hit);
}

// DB-only 批量回填 demo 同形（与后端 `get_cached_app_details_batch` 同语义）：
// 逐 id 归一查收录快照，命中即摘要行、无行即 null，与入参一一对齐，永不抛错。
export function handleGetCachedAppDetailsBatch(a: InvokeArgs): (AppSummary | null)[] {
  const raw = a['ids'];
  const ids: unknown[] = Array.isArray(raw) ? raw : [];
  return ids.map((id) =>
    typeof id === 'string' && id.trim() !== '' ? findSummary(id) ?? null : null,
  );
}

/** demo 单仓富卡批量水合：仅从内置 fixtures 投影（DB-only 同语义，与入参一一对齐）。 */
export function handleGetRepoCardsBatch(a: InvokeArgs): (HydratedRepoCard | null)[] {
  const raw = a['ids'];
  const ids: unknown[] = Array.isArray(raw) ? raw : [];
  const now = Math.floor(Date.now() / 1000);
  return ids.map((id) => {
    if (typeof id !== 'string' || id.trim() === '') return null;
    const summary = findSummary(id);
    return summary ? { summary, confirmed_other: false, updated_at: now } : null;
  });
}

/** demo 在线搜索列表快照：内存态透存（刷新页面即清空），与后端 64 KiB 上限同口径。 */
const demoSearchListCache = new Map<string, SearchListCacheEntry & { has_private: boolean }>();
const DEMO_SEARCH_LIST_MAX_BYTES = 64 * 1024;

export function handleGetSearchListCache(a: InvokeArgs): SearchListCacheEntry | null {
  const key = argStr(a, 'cacheKey').trim();
  const row = key ? demoSearchListCache.get(key) : undefined;
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
  demoSearchListCache.set(key, {
    payload_json: payload,
    cached_at: Math.floor(Date.now() / 1000),
    has_private: a['hasPrivate'] === true,
  });
  return null;
}

/** 登出：清除含私有仓库的 demo 搜索列表快照。 */
export function clearDemoPrivateSearchListCache(): void {
  for (const [key, row] of demoSearchListCache) {
    if (row.has_private) demoSearchListCache.delete(key);
  }
}

export function handleGetReadmeVariants(a: InvokeArgs): ReadmeVariantsResult {
  const id = argStr(a, 'appId');
  const hit = findSummary(id);
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
  const hit = findSummary(id);
  if (!hit) return null;
  const key = hit.id.toLowerCase();
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
  return findSummary(appId)?.icon ?? '';
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
  const matched = summaries.filter((s) => s.category.toLowerCase() === category);
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

  let matched = [...summaries];
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
    const maxItemDays = summaries.reduce<number | null>((acc, s) => {
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
  const managed = new Set(getInstalledApps().map((i) => i.app_id.toLowerCase()));
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
  const list = [...getInstalledApps()];
  const now = Math.floor(Date.now() / 1000);
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
  setInstalledApps(list);
  lsSet(LS.installed, list);
  return imported;
}

export function handleRecordSearchQuery(a: InvokeArgs): null {
  const q = argStr(a, 'query').trim();
  if (q) {
    const list = [q, ...getSearchHistory().filter((x) => x !== q)].slice(0, 20);
    setSearchHistory(list);
    lsSet(LS.searchHistory, list);
  }
  return null;
}

export function handleGetSearchHistory(): string[] {
  return [...getSearchHistory()];
}

export function handleClearSearchHistory(): null {
  setSearchHistory([]);
  lsSet(LS.searchHistory, []);
  return null;
}

export function handleRemoveSearchQuery(a: InvokeArgs): null {
  const q = argStr(a, 'query');
  const list = getSearchHistory().filter((x) => x !== q);
  setSearchHistory(list);
  lsSet(LS.searchHistory, list);
  return null;
}

const DEMO_VIEW_DEBOUNCE_SECS = 30;
const DEMO_RECENT_VIEW_LIMIT = 30;

export function handleRecordAppView(a: InvokeArgs): null {
  const id = argStr(a, 'appId').toLowerCase();
  if (id) {
    const now = Math.floor(Date.now() / 1000);
    const prev = getRecentViewTimes()[id];
    if (prev !== undefined && now >= prev && now - prev < DEMO_VIEW_DEBOUNCE_SECS) {
      return null;
    }
    setRecentViewTime(id, now);
    lsSet(LS.recentViewTimes, getRecentViewTimes());
    const list = [id, ...getRecentIds().filter((x) => x !== id)].slice(0, DEMO_RECENT_VIEW_LIMIT);
    setRecentIds(list);
    lsSet(LS.recentViews, list);
  }
  return null;
}

export function handleGetRecentlyViewedApps(): AppSummary[] {
  const out: AppSummary[] = [];
  const times = getRecentViewTimes();
  for (const id of getRecentIds()) {
    const hit = findSummary(id);
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

function buildDemoCollectionPlaceholder(cleanId: string): AppSummary {
  let forge = 'github';
  let forgeHost = 'github.com';
  let pathPart = cleanId;
  const colonIdx = cleanId.indexOf(':');
  if (colonIdx > 0) {
    forge = cleanId.slice(0, colonIdx);
    pathPart = cleanId.slice(colonIdx + 1);
    forgeHost =
      forge === 'codeberg'
        ? 'codeberg.org'
        : forge === 'gitlab'
          ? 'gitlab.com'
          : forge === 'gitea'
            ? 'gitea.com'
            : 'github.com';
  }
  const parts = pathPart.split('/').filter(Boolean);
  let owner = '';
  let repo = cleanId;
  if (parts.length >= 3) {
    forgeHost = parts[0];
    owner = parts[1];
    repo = parts[2];
  } else if (parts.length === 2) {
    owner = parts[0];
    repo = parts[1];
  }
  return {
    id: cleanId,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: DEFAULT_ICON_BG,
    description: '',
    stars: 0,
    forks: 0,
    license: '',
    latest_version: 'latest',
    category: 'external',
    category_name: '跨平台开源',
    is_verified: false,
    forge,
    forge_host: forgeHost,
    homepage: null,
    platforms: [],
    is_cataloged: false,
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
    const hit = findSummary(cleanId);
    out.push(hit ?? buildDemoCollectionPlaceholder(cleanId));
    if (out.length >= 30) break;
  }
  return out;
}
