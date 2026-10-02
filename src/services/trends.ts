import { AppSummary } from '../types';

export type TrendPeriod = 'day' | 'week' | 'month' | 'all';

export interface TrendRepo {
  id: string;
  name: string;
  owner: string;
  repo: string;
  stars: number;
  forks?: number;
  description?: string;
  url?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟内存缓存
const trendsCache = new Map<TrendPeriod, { timestamp: number; data: TrendRepo[] }>();

/**
 * 格式化星数显示（与 AppCard 规范对齐）。
 */
export function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * 本地静态快照排序逻辑（降级/离线兜底方案，保证首屏秒开）。
 */
export function sortAppsLocally(apps: AppSummary[], period: TrendPeriod): AppSummary[] {
  const list = [...apps];
  switch (period) {
    case 'day':
      return list.sort((a, b) => (b.forks * 3 + (b.stars % 500)) - (a.forks * 3 + (a.stars % 500)));
    case 'week':
      return list.sort((a, b) => (b.stars * 0.7 + b.forks * 4) - (a.stars * 0.7 + a.forks * 4));
    case 'month':
      return list.sort((a, b) => (b.stars + b.forks * 2) - (a.stars + a.forks * 2));
    case 'all':
    default:
      return list.sort((a, b) => b.stars - a.stars);
  }
}

/**
 * 跨源匹配 catalog.json 本地应用。
 * 支持 id/全路径/名称等模糊与精确比对。
 */
export function matchCatalogApp(trend: TrendRepo, catalogApps: AppSummary[]): AppSummary | undefined {
  const tId = (trend.id || '').trim().toLowerCase();
  const tOwner = (trend.owner || '').trim().toLowerCase();
  const tRepo = (trend.repo || '').trim().toLowerCase();
  const tName = (trend.name || '').trim().toLowerCase();

  return catalogApps.find((app) => {
    const aId = (app.id || '').trim().toLowerCase();
    const aOwner = (app.owner || '').trim().toLowerCase();
    const aRepo = (app.repo || '').trim().toLowerCase();
    const aName = (app.name || '').trim().toLowerCase();
    const aFullName = `${aOwner}/${aRepo}`;

    // 1. 完全匹配 ID 或 owner/repo
    if (tId && (aId === tId || aFullName === tId)) return true;
    if (tOwner && tRepo && aOwner === tOwner && aRepo === tRepo) return true;
    // 2. 匹配 repo 名称
    if (tRepo && aRepo === tRepo) return true;
    // 3. 匹配 app name
    if (tName && (aName === tName || aRepo === tName || aFullName === tName)) return true;

    return false;
  });
}

/**
 * 优先级 1：从 OSSInsight 抓取趋势仓库。
 * 免 key，公开 SQL API。
 */
export async function fetchOSSInsightTrends(period: TrendPeriod, timeoutMs = 5000): Promise<TrendRepo[]> {
  const periodMap: Record<TrendPeriod, string> = {
    day: 'past_24_hours',
    week: 'past_week',
    month: 'past_month',
    all: 'past_month',
  };
  const periodParam = periodMap[period] || 'past_24_hours';
  const url = `https://api.ossinsight.io/v1/trends/repos/?period=${periodParam}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`OSSInsight returned status ${res.status}`);
    }
    const json = await res.json();
    if (json?.data_quality?.status === 'unavailable') {
      return [];
    }
    const rows = json?.data?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    return rows
      .map((r: Record<string, unknown>) => {
        const rawName = String(r.repo_name || r.name || '').trim();
        let owner = '';
        let repo = '';
        if (rawName.includes('/')) {
          const parts = rawName.split('/');
          owner = parts[0];
          repo = parts.slice(1).join('/');
        } else {
          owner = String(r.owner || '');
          repo = String(r.repo || rawName);
        }
        const fullName = owner && repo ? `${owner}/${repo}` : rawName || repo;
        return {
          id: fullName,
          name: fullName || repo,
          owner,
          repo,
          stars: Number(r.stars ?? r.star_count ?? r.stars_count ?? r.current_period_growth ?? 0),
          forks: Number(r.forks ?? r.fork_count ?? 0),
          description: r.description ? String(r.description) : undefined,
          url: fullName ? `https://github.com/${fullName}` : undefined,
        };
      })
      .filter((item) => Boolean(item.name));
  } finally {
    clearTimeout(timer);
  }
}

const GITHUB_REPO_REGEX = /https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/i;
const IGNORED_GITHUB_SEGMENTS = new Set([
  'features',
  'pricing',
  'about',
  'security',
  'topics',
  'trending',
  'collections',
  'events',
  'blog',
  'readme',
  'site',
  'status',
]);

/**
 * 优先级 2：从 Hacker News (Algolia) 抓取热门开源仓库。
 * 免 key，公开 Algolia API。
 */
export async function fetchHNTrends(period: TrendPeriod, timeoutMs = 5000): Promise<TrendRepo[]> {
  const now = Math.floor(Date.now() / 1000);
  let timeDelta = 7 * 86400;
  if (period === 'day') {
    timeDelta = 86400;
  } else if (period === 'week') {
    timeDelta = 7 * 86400;
  } else if (period === 'month') {
    timeDelta = 30 * 86400;
  } else {
    timeDelta = 365 * 86400;
  }

  const since = now - timeDelta;
  const url = `https://hn.algolia.com/api/v1/search?tags=story&query=github.com&numericFilters=created_at_i>${since}&hitsPerPage=50`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HN Algolia returned status ${res.status}`);
    }
    const json = await res.json();
    const hits = json?.hits;
    if (!Array.isArray(hits) || hits.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const repos: TrendRepo[] = [];

    for (const h of hits) {
      const storyUrl = String(h.url || '');
      const match = storyUrl.match(GITHUB_REPO_REGEX);
      if (!match) continue;

      const owner = match[1];
      const repo = match[2].replace(/\.git$/i, '');
      if (IGNORED_GITHUB_SEGMENTS.has(owner.toLowerCase()) || IGNORED_GITHUB_SEGMENTS.has(repo.toLowerCase())) {
        continue;
      }

      const fullName = `${owner}/${repo}`;
      const lower = fullName.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);

      repos.push({
        id: fullName,
        name: fullName,
        owner,
        repo,
        stars: Number(h.points ?? 0),
        description: h.title ? String(h.title) : undefined,
        url: `https://github.com/${fullName}`,
      });
    }

    return repos;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一趋势抓取入口：
 * 1. 优先读取内存缓存；
 * 2. 优先请求 OSSInsight；
 * 3. 失败降级请求 HN Algolia；
 * 4. 仍失败或离线返回空数组，触发上层降级至本地原逻辑。
 */
export async function fetchTrends(period: TrendPeriod, options: { forceRefresh?: boolean } = {}): Promise<TrendRepo[]> {
  if (!options.forceRefresh) {
    const cached = trendsCache.get(period);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  // 1. 尝试 OSSInsight
  try {
    const ossRepos = await fetchOSSInsightTrends(period);
    if (ossRepos.length > 0) {
      trendsCache.set(period, { timestamp: Date.now(), data: ossRepos });
      return ossRepos;
    }
  } catch {
    // 忽略异常，继续降级
  }

  // 2. 降级尝试 HN Algolia
  try {
    const hnRepos = await fetchHNTrends(period);
    if (hnRepos.length > 0) {
      trendsCache.set(period, { timestamp: Date.now(), data: hnRepos });
      return hnRepos;
    }
  } catch {
    // 忽略异常，降级至空数组
  }

  return [];
}
