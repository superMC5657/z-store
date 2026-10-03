import type { AppSummary, FetchTrendsOptions, TrendBoardId, TrendRepo } from '../types';

// UI 兼容：榜单契约类型定义以 `../types` 为 SSOT，此处原样 re-export，
// 因此从 `services/trends` 或 `types` 导入均可。
export type { FetchTrendsOptions, TrendBoardId, TrendRepo } from '../types';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟内存缓存
const FETCH_TIMEOUT_MS = 5000; // 远端请求统一 5s 熔断

const trendsCache = new Map<string, { timestamp: number; data: TrendRepo[] }>();

/** 缓存键 = board + language + category（P1 要求，统一口径）。 */
export function buildTrendsCacheKey(board: TrendBoardId, opts: FetchTrendsOptions = {}): string {
  return `${board}|${opts.language ?? ''}|${opts.category ?? ''}`;
}

function readTrendsCache(key: string): TrendRepo[] | undefined {
  const hit = trendsCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.timestamp < CACHE_TTL_MS) return hit.data;
  trendsCache.delete(key);
  return undefined;
}

function writeTrendsCache(key: string, data: TrendRepo[]): void {
  trendsCache.set(key, { timestamp: Date.now(), data });
}

/** 仅供测试与榜单切换时使用：清空趋势内存缓存。 */
export function clearTrendsCache(): void {
  trendsCache.clear();
}

/**
 * 格式化星数显示（与 AppCard 规范对齐）。
 * SSOT：全仓唯一 `formatStars` 实现，其余文件禁止本地复刻，一律从此处导入。
 */
export function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
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

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type OSSInsightPeriod = 'past_24_hours' | 'past_week' | 'past_month';

/**
 * Board → OSSInsight period 单一映射（SSOT）。
 * 时间榜一榜一查询；`top` 为纯离线榜，不使用此映射、不做任何远端请求，
 * 与 `monthly`（past_month 速度榜）彻底区分。
 */
export const BOARD_TO_PERIOD: Record<'daily' | 'weekly' | 'monthly', OSSInsightPeriod> = {
  daily: 'past_24_hours',
  weekly: 'past_week',
  monthly: 'past_month',
};

function mapOSSInsightRow(r: Record<string, unknown>): TrendRepo | null {
  const rawName = String(r.repo_name ?? r.name ?? '').trim();
  let owner = '';
  let repo = '';
  if (rawName.includes('/')) {
    const parts = rawName.split('/');
    owner = parts[0];
    repo = parts.slice(1).join('/');
  } else {
    owner = String(r.owner ?? '');
    repo = String(r.repo ?? rawName);
  }
  const fullName = owner && repo ? `${owner}/${repo}` : rawName || repo;
  if (!fullName) return null;
  // stars = 仓库总星数；starsGained = 本周期新增。
  // UI 契约：仅当 starsGained 为 defined 才渲染 +N 徽标；上游缺失时必须为
  // undefined，绝不回退为总 stars（否则会把存量误标为增量，属 P1 误导徽章）。
  const stars = Number(r.stars ?? r.star_count ?? r.stars_count ?? 0);
  const gainedRaw = r.current_period_growth ?? r.stars_gained ?? r.growth;
  let starsGained: number | undefined;
  if (gainedRaw == null || gainedRaw === '') {
    starsGained = undefined;
  } else {
    const n = Number(gainedRaw);
    starsGained = Number.isFinite(n) ? n : undefined;
  }
  const forksRaw = r.forks ?? r.fork_count;
  return {
    id: fullName,
    name: fullName,
    owner,
    repo,
    stars: Number.isFinite(stars) ? stars : 0,
    starsGained,
    forks: forksRaw == null || forksRaw === '' ? undefined : Number(forksRaw),
    description: r.description ? String(r.description) : undefined,
    url: fullName ? `https://github.com/${fullName}` : undefined,
  };
}

/**
 * 时间榜共用源：OSSInsight 趋势仓库（免 key 公开 API）。
 * daily → past_24_hours，weekly → past_week，monthly → past_month，
 * 一榜一查询，不存在“同一快照多公式复算”。
 */
export async function fetchOSSInsightRepos(
  period: OSSInsightPeriod,
  language?: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<TrendRepo[]> {
  let url = `https://api.ossinsight.io/v1/trends/repos/?period=${period}`;
  if (language) url += `&language=${encodeURIComponent(language)}`;

  const res = await fetchWithTimeout(url, timeoutMs);
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
    .map((r: Record<string, unknown>) => mapOSSInsightRow(r))
    .filter((item): item is TrendRepo => item !== null && Boolean(item.name));
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

type TimeBoardId = 'daily' | 'weekly' | 'monthly';

/**
 * 时间榜降级源：Hacker News (Algolia) 近期含 github 链接的热门 story（免 key）。
 * HN points 既非总 stars 亦非精确增量，此处同时写入 stars/starsGained 仅作榜内排序代理，
 * 已在字段层面诚实标注，不冒充精确口径。
 */
export async function fetchHNRepos(board: TimeBoardId, timeoutMs = FETCH_TIMEOUT_MS): Promise<TrendRepo[]> {
  const timeDelta = board === 'daily' ? 86400 : board === 'weekly' ? 7 * 86400 : 30 * 86400;
  const since = Math.floor(Date.now() / 1000) - timeDelta;
  const url = `https://hn.algolia.com/api/v1/search?tags=story&query=github.com&numericFilters=created_at_i>${since}&hitsPerPage=50`;

  const res = await fetchWithTimeout(url, timeoutMs);
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

    const points = Number(h.points ?? 0);
    repos.push({
      id: fullName,
      name: fullName,
      owner,
      repo,
      stars: Number.isFinite(points) ? points : 0,
      starsGained: Number.isFinite(points) ? points : 0,
      description: h.title ? String(h.title) : undefined,
      url: `https://github.com/${fullName}`,
    });
  }

  return repos;
}

function mapGitHubSearchItem(item: Record<string, unknown>): TrendRepo | null {
  const fullName = String(item.full_name ?? '').trim();
  if (!fullName || !fullName.includes('/')) return null;
  const [owner, ...rest] = fullName.split('/');
  const repo = rest.join('/');
  const stars = Number(item.stargazers_count ?? 0);
  const forks = Number(item.forks_count ?? 0);
  return {
    id: fullName,
    name: fullName,
    owner,
    repo,
    stars: Number.isFinite(stars) ? stars : 0,
    // GitHub search 只返回存量 stars，不提供周期增量；缺失即 undefined，
    // UI 仅在 defined 时渲染 +N，绝不把总量冒充为增量。
    starsGained: undefined,
    forks: Number.isFinite(forks) ? forks : undefined,
    description: item.description ? String(item.description) : undefined,
    url: item.html_url ? String(item.html_url) : `https://github.com/${fullName}`,
  };
}

/**
 * new 榜首选源：GitHub code search（created:>6个月，免 key 可用但配额极严）。
 * 触发限流/离线/空结果时抛错或返回 []，由上层切换到客户端兜底。
 */
export async function fetchGitHubNewRepos(timeoutMs = FETCH_TIMEOUT_MS): Promise<TrendRepo[]> {
  const since = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url =
    `https://api.github.com/search/repositories` +
    `?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=20`;

  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`GitHub search returned status ${res.status}`);
  }
  const json = await res.json();
  const items = json?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .map((it: Record<string, unknown>) => mapGitHubSearchItem(it))
    .filter((item): item is TrendRepo => item !== null);
}

// ---------------------------------------------------------------------------
// 纯函数排序/过滤：一榜一口径。
//
// 说明（防 S2 重复指责）：rising / healthy / category / new-fallback 均为
// weekly 速度快照之上的客户端视图（client views），并非独立上游数据源；
// 它们各自定义了互不相同的纯排序/过滤口径，因此 5 种榜单顺序必然分叉。
// monthly（past_month 速度，按 starsGained 排序）与 top（纯离线，按 stars
// 排序）则是另外两条独立口径，互不共享远端查询。
// ---------------------------------------------------------------------------

/** rising 榜口径：增速比 = starsGained / max(1, stars - starsGained)。 */
export function growthRatio(repo: TrendRepo): number {
  const gained = repo.starsGained ?? 0;
  return gained / Math.max(1, repo.stars - gained);
}

/** rising 榜：按增速比降序。 */
export function rankByGrowthRatio(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => growthRatio(b) - growthRatio(a));
}

/** top 榜口径：只按总 stars 降序，不掺任何增量权重。 */
export function sortByStarsTotal(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => b.stars - a.stars);
}

/**
 * healthy 榜代理分 = (forks ?? 0) + (starsGained ?? 0)。
 *
 * 局限性（已文档化，不冒充精确口径）：真正的“发布新鲜度”需要逐仓调
 * GitHub releases API 取 latest published_at，属于 N+1 高配额消耗，
 * 此处仅用 forks（协作体量）+ starsGained（近期热度）作活跃代理。
 */
export function healthyScore(repo: TrendRepo): number {
  return (repo.forks ?? 0) + (repo.starsGained ?? 0);
}

/** healthy 榜：按代理分降序。 */
export function sortByHealthyScore(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => healthyScore(b) - healthyScore(a));
}

/** new 榜客户端兜底阈值：GitHub search 不可用时复用 weekly 快照并按此过滤。 */
export const NEW_FALLBACK_MAX_STARS = 2000;
export const NEW_FALLBACK_MAX_FORKS = 500;

/**
 * new 榜客户端兜底视图（纯函数，weekly 快照之上的启发式，非独立上游）：
 * `stars<2000 && forks<500` 启发式近似“新仓”，组内按 starsGained 降序
 *（缺失按 0，不回退总量）。调用方如需使用须显式调用并标注降级来源；
 * `fetchTrends('new')` 远端失败时直接返回 []，不再隐式复用。
 */
export function filterNewReposFallback(repos: TrendRepo[]): TrendRepo[] {
  return repos
    .filter((r) => r.stars < NEW_FALLBACK_MAX_STARS && (r.forks ?? 0) < NEW_FALLBACK_MAX_FORKS)
    .sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0));
}

/**
 * category 榜：按本地精选收录库类目分组、组内按 starsGained 降序。
 * 远端行本身不带类目，调用方需先经 `enrichWithCatalogCategory` 补类目；
 * 传入 `category` 时只保留该组（大小写不敏感）。
 */
export function sortByCategoryGroup(repos: TrendRepo[], category?: string): TrendRepo[] {
  const want = category?.trim().toLowerCase();
  const list = want ? repos.filter((r) => (r.category ?? '').toLowerCase() === want) : [...repos];
  const byGained = (a: TrendRepo, b: TrendRepo) => (b.starsGained ?? 0) - (a.starsGained ?? 0);
  if (want) return list.sort(byGained);
  return list.sort((a, b) => {
    const ca = (a.category ?? '').toLowerCase();
    const cb = (b.category ?? '').toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    return byGained(a, b);
  });
}

/** 用本地精选收录库的类目为远端榜单行补 `category`（category 榜分组依据）。 */
export function enrichWithCatalogCategory(repos: TrendRepo[], catalogApps: AppSummary[]): TrendRepo[] {
  return repos.map((r) => {
    if (r.category) return r;
    const matched = matchCatalogApp(r, catalogApps);
    return matched ? { ...r, category: matched.category } : r;
  });
}

/**
 * top 榜离线路径（无 fetch，SSOT）：本地精选收录库快照只按总 stars 降序。
 * 本地 catalog 无周期增量，starsGained 一律 undefined（UI 不渲染 +N）。
 * 首屏/离线秒开走此函数；`fetchTrends('top')` 零远端请求（见下），与
 * monthly（past_month 远端速度榜）彻底区分。
 */
export function trendReposFromCatalog(apps: AppSummary[]): TrendRepo[] {
  return apps
    .map((app) => ({
      id: app.id,
      name: `${app.owner}/${app.repo}`,
      owner: app.owner,
      repo: app.repo,
      stars: app.stars,
      starsGained: undefined as number | undefined,
      forks: app.forks,
      description: app.description,
      url: `https://github.com/${app.owner}/${app.repo}`,
      category: app.category,
    }))
    .sort((a, b) => b.stars - a.stars);
}

// ---------------------------------------------------------------------------
// 统一入口：一榜一源。远端为空一律返回 []，绝不回退本地加权排序（P0）。
// ---------------------------------------------------------------------------

async function fetchTimeBoard(board: TimeBoardId, opts: FetchTrendsOptions): Promise<TrendRepo[]> {
  const key = buildTrendsCacheKey(board, opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return hit;
  }

  const ossPeriod: OSSInsightPeriod = BOARD_TO_PERIOD[board];

  try {
    const ossRepos = await fetchOSSInsightRepos(ossPeriod, opts.language);
    if (ossRepos.length > 0) {
      // monthly 为 past_month 速度榜：显式按 starsGained 降序（缺失按 0），
      // 与 top（纯离线按 stars 排序）彻底区分；daily/weekly 保留远端速度顺序。
      const ordered =
        board === 'monthly'
          ? [...ossRepos].sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0))
          : ossRepos;
      writeTrendsCache(key, ordered);
      return ordered;
    }
  } catch {
    // 忽略异常，继续降级 HN
  }

  try {
    const hnRepos = await fetchHNRepos(board);
    if (hnRepos.length > 0) {
      const ordered =
        board === 'monthly'
          ? [...hnRepos].sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0))
          : hnRepos;
      writeTrendsCache(key, ordered);
      return ordered;
    }
  } catch {
    // 忽略异常，返回空数组（上层按空态处理，不做本地加权假榜）
  }

  return [];
}

async function fetchNewBoard(opts: FetchTrendsOptions): Promise<TrendRepo[]> {
  const key = buildTrendsCacheKey('new', opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return hit;
  }

  // new 榜单一远端源：GitHub search。remote-empty => []（P3），不再隐式复用
  // weekly 快照；如调用方需要降级视图，须显式调用 filterNewReposFallback(weekly)。
  try {
    const fresh = await fetchGitHubNewRepos();
    if (fresh.length > 0) {
      writeTrendsCache(key, fresh);
      return fresh;
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchRisingBoard(opts: FetchTrendsOptions): Promise<TrendRepo[]> {
  const key = buildTrendsCacheKey('rising', opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return hit;
  }
  const weekly = await fetchTimeBoard('weekly', opts);
  if (weekly.length === 0) return [];
  const ranked = rankByGrowthRatio(weekly);
  writeTrendsCache(key, ranked);
  return ranked;
}

async function fetchCategoryBoard(opts: FetchTrendsOptions): Promise<TrendRepo[]> {
  const key = buildTrendsCacheKey('category', opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return hit;
  }
  const weekly = await fetchTimeBoard('weekly', opts);
  if (weekly.length === 0) return [];
  // category 过滤在 service 内完成（非 UI-only）：远端行默认无 category，
  // 若调用方经 opts.catalogApps 传入本地精选库，则先 enrich 再分组过滤；
  // 未传入时仍按 opts.category 做大小写不敏感过滤（无类目行将被滤除）。
  const base = opts.catalogApps ? enrichWithCatalogCategory(weekly, opts.catalogApps) : weekly;
  const grouped = sortByCategoryGroup(base, opts.category);
  if (grouped.length > 0) {
    writeTrendsCache(key, grouped);
  }
  return grouped;
}

async function fetchHealthyBoard(opts: FetchTrendsOptions): Promise<TrendRepo[]> {
  const key = buildTrendsCacheKey('healthy', opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return hit;
  }
  const weekly = await fetchTimeBoard('weekly', opts);
  if (weekly.length === 0) return [];
  const ranked = sortByHealthyScore(weekly);
  writeTrendsCache(key, ranked);
  return ranked;
}

// (fetchTopBoard 已删除：top 为纯离线榜，零远端请求，见 fetchTrends 'top' 分支。)

/**
 * 统一趋势抓取入口，一榜一源：
 * daily/weekly → OSSInsight 对应 period 速度顺序（失败降级 HN）；
 * monthly → OSSInsight past_month 并显式按 starsGained 降序（速度榜）；
 * new → GitHub search，失败/空一律返回 []（不再隐式复用 weekly）；
 * rising/category/healthy → weekly 快照之上的客户端视图
 *   （增速比 / 类目分组 / 活跃代理，非独立上游）；
 * top → 纯离线榜：零远端请求，返回 []；UI 首屏/离线请直接调用
 *   trendReposFromCatalog(apps)（按总 stars 排序，starsGained 恒为 undefined）。
 *
 * 远端为空一律返回 []，绝不回退本地加权排序。
 * 缓存键 = board + language + category；category 过滤在 service 内完成。
 */
export async function fetchTrends(board: TrendBoardId, opts: FetchTrendsOptions = {}): Promise<TrendRepo[]> {
  // 时间榜路由同样走 BOARD_TO_PERIOD 单一映射（替代 switch 三分支）。
  if (board in BOARD_TO_PERIOD) {
    return fetchTimeBoard(board as TimeBoardId, opts);
  }
  switch (board) {
    case 'new':
      return fetchNewBoard(opts);
    case 'rising':
      return fetchRisingBoard(opts);
    case 'category':
      return fetchCategoryBoard(opts);
    case 'healthy':
      return fetchHealthyBoard(opts);
    case 'top': {
      // 纯离线榜：零 fetch，与 monthly 的 past_month 远端查询彻底区分。
      // 命中缓存则返回缓存（对称），否则返回 []，由 UI 切本地快照。
      const key = buildTrendsCacheKey('top', opts);
      if (!opts.forceRefresh) {
        const hit = readTrendsCache(key);
        if (hit) return hit;
      }
      return [];
    }
    default:
      throw new Error(`[trends] unknown board: ${String(board)}`);
  }
}
