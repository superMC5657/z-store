import type {
  AppDetail,
  AppMatchResult,
  AppSummary,
  ForgeRepoInfo,
  SyncCatalogResult,
} from '../../types';
import type { AppIconCycleResult, PlatformsLiteResult, ReadmeVariantsResult } from '../../services/api';
import {
  demoExternalFallback,
  findExternalTrend,
  findSummary,
  summaries,
  toDetail,
} from '../fixtures';
import {
  getRecentIds,
  getSearchHistory,
  iconLevel,
  LS,
  lsSet,
  setRecentIds,
  setSearchHistory,
} from '../demoState';
import { argNum, argStr, type InvokeArgs, rankSummariesForFeed } from './common';

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

export function handleSearchAppsOnline(a: InvokeArgs): AppSummary[] {
  const qRaw = argStr(a, 'query').trim();
  if (!qRaw) return [];
  const rawPer = argNum(a, 'per_page', 'perPage', 'per-page');
  const rawPage = argNum(a, 'page');
  const perPage = rawPer === undefined ? 12 : Math.min(50, Math.max(1, Math.floor(rawPer)));
  const page =
    rawPage === undefined || !Number.isFinite(rawPage) || Math.floor(rawPage) < 1
      ? 1
      : Math.floor(rawPage);
  if (qRaw.includes('/')) {
    const exact = findSummary(qRaw);
    if (exact) return page === 1 ? [exact] : [];
  }
  const q = qRaw.toLowerCase();
  const matched = summaries.filter((s) =>
    `${s.id} ${s.name} ${s.description} ${s.description_en ?? ''} ${s.owner} ${s.repo} ${s.category_name}`
      .toLowerCase()
      .includes(q),
  );
  const start = (page - 1) * perPage;
  return matched.slice(start, start + perPage);
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
      change: 0,
      gain: 0,
      cat: 'dev',
      catn: '开发工具',
    });
  });
}

export function handleGetPlatformsLite(a: InvokeArgs): PlatformsLiteResult {
  const id = argStr(a, 'id', 'appId', 'app_id');
  const hit = findSummary(id);
  if (hit) {
    return {
      id: hit.id,
      platforms: [...(hit.platforms ?? [])],
      from_cache: true,
      is_stale: null,
    };
  }
  return { id, platforms: [], is_stale: true, from_cache: false };
}

export function handleGetAppDetails(a: InvokeArgs): AppDetail {
  const id = argStr(a, 'id', 'appId', 'app_id');
  const hit = findSummary(id);
  if (!hit) throw new Error(`demo: unknown app "${id}"`);
  return toDetail(hit);
}

export function handleGetReadmeVariants(a: InvokeArgs): ReadmeVariantsResult {
  const id = argStr(a, 'appId', 'app_id', 'id');
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
  const id = argStr(a, 'appId', 'app_id', 'id');
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
  const remote = argStr(a, 'remoteUrl', 'remote_url');
  if (remote) return remote;
  const appId = argStr(a, 'appId', 'app_id');
  return findSummary(appId)?.icon ?? '';
}

export function handleGetCategoryApps(a: InvokeArgs): AppSummary[] {
  const category = argStr(a, 'category').toLowerCase();
  if (!category) return [];
  return summaries.filter((s) => s.category.toLowerCase() === category);
}

export function handleGetCatalogCount(): number {
  return summaries.length;
}

export function handleScanAndMatchLocalApps(): AppMatchResult[] {
  return [];
}

export function handleImportMatchedApps(): number {
  return 0;
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

export function handleRecordAppView(a: InvokeArgs): null {
  const id = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  if (id) {
    const list = [id, ...getRecentIds().filter((x) => x !== id)].slice(0, 20);
    setRecentIds(list);
    lsSet(LS.recentViews, list);
  }
  return null;
}

export function handleGetRecentlyViewedApps(): AppSummary[] {
  const out: AppSummary[] = [];
  for (const id of getRecentIds()) {
    const hit = findSummary(id);
    if (hit) out.push(hit);
  }
  return out;
}

export function handleClearViewHistory(): null {
  setRecentIds([]);
  lsSet(LS.recentViews, []);
  return null;
}

export function handleSearchForgeRepos(): ForgeRepoInfo[] {
  return [];
}

export function handleSyncCatalog(): SyncCatalogResult {
  return {
    updated: false,
    count: summaries.length,
    message: 'demo: bundled catalog is up to date',
  };
}
