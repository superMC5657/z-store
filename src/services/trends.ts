import type {
  AppSummary,
  FetchTrendsOptions,
  TrendBoardId,
  TrendRepo,
  TrendsErrorKind,
  TrendsResult,
} from '../types';
import { tauriApi } from './api';
import { zlogInfo, zlogWarn } from '../lib/z-log';

// UI 兼容：榜单契约类型定义以 `../types` 为 SSOT，此处原样 re-export，
// 因此从 `services/trends` 或 `types` 导入均可。
export type {
  FetchTrendsOptions,
  TrendBoardId,
  TrendRepo,
  TrendsErrorKind,
  TrendsResult,
  TrendsStatus,
} from '../types';

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟内存缓存（仅成功结果写入；rising/healthy 除外，见下）
/**
 * doforce 源数据共享缓存 TTL：12h。
 * 日榜粒度数据日内几乎不变，长缓存 + 两榜共享把远端命中压到最低；
 * 其余榜单保持 5 分钟。
 */
export const DOFORCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 429 单次重试的最大等待：60s；超过即直接 error，不再等待。 */
export const DOFORCE_RETRY_MAX_WAIT_MS = 60_000;
/** 429 错误串无 Retry-After 可用时的默认等待（Rust 侧当前仅回传状态码）。 */
export const DOFORCE_RETRY_DEFAULT_WAIT_MS = 5_000;
export const TRENDING_TIMEOUT_MS = 10_000; // github.com/trending HTML 抓取 10s 熔断
export const DOFORCE_TIMEOUT_MS = 10_000; // doforce API 10s 熔断（Rust 侧执行）
export const GITHUB_SEARCH_TIMEOUT_MS = 10_000; // GitHub Search 主源 10s 熔断

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

/** doforce 源数据共享缓存（rising/healthy 共用原始快照，各榜自行排序）。 */
let doforceSharedCache: { timestamp: number; data: TrendRepo[] } | undefined;
/** doforce 在途共享 Promise（并发的 rising/healthy 复用同一请求，防 2 连击）。 */
let doforceInflight: Promise<TrendRepo[]> | undefined;

function readDoforceShared(): TrendRepo[] | undefined {
  if (!doforceSharedCache) return undefined;
  if (Date.now() - doforceSharedCache.timestamp < DOFORCE_CACHE_TTL_MS) {
    return doforceSharedCache.data;
  }
  doforceSharedCache = undefined;
  return undefined;
}

/** 仅供测试与榜单切换时使用：清空趋势内存缓存（含 doforce 共享缓存与在途请求）。 */
export function clearTrendsCache(): void {
  trendsCache.clear();
  doforceSharedCache = undefined;
  doforceInflight = undefined;
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

// ---------------------------------------------------------------------------
// Trends traffic is ALWAYS direct: no gh-proxy prefix is applied to any URL.
//
// Policy (user decision): proxy is reserved for app downloads (rewritten on
// the Rust side). Trends payloads are small JSON/HTML and fetch direct.
// `opts.proxyPrefix` is accepted but IGNORED (kept in FetchTrendsOptions only
// for contract stability — the UI still passes it); `withTrendsProxy` below
// is the single choke point and is now the identity function.
// ---------------------------------------------------------------------------

/** Normalize a proxy prefix: empty/direct -> undefined; ghproxy -> default; http(s) kept. */
export function normalizeProxyPrefix(raw?: string): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (!t || t === 'direct') return undefined;
  if (t === 'ghproxy') return 'https://gh-proxy.com';
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, '');
  return undefined;
}

/**
 * @deprecated Identity: trends traffic is always direct, no prefix is applied.
 * Kept (still called by every trends URL builder) so callers need no changes
 * if the policy is ever revisited — fix here once, not at every call site.
 */
export function withTrendsProxy(url: string, _opts: FetchTrendsOptions = {}): string {
  void _opts;
  return url;
}

// ---------------------------------------------------------------------------
// 错误分类（UI lane 依赖，保持 STABLE）。
// 403/429 → rate-limited；Abort → timeout；TypeError/Failed to fetch → network；
// 其余 HTTP/未知 → unavailable。
// ---------------------------------------------------------------------------

function errorStatusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  if (typeof s === 'number') return s;
  // Rust invoke 拒绝值为纯字符串（`.status` 经序列化丢失），从错误串回解析
  // `upstream status {code}`，直透调用下 errorKind 映射保持不变（见 api.fetchTrendsText）。
  return errorStatusFromMessage(err);
}

/** 从错误串回解析 HTTP 状态（`upstream status {code}` / `... status {code}`）。 */
function errorStatusFromMessage(err: unknown): number | undefined {
  const msg = String(
    (err as { message?: unknown })?.message ?? (typeof err === 'string' ? err : '') ?? '',
  );
  const m = /status\s+(\d{3})/i.exec(msg);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** 将未知异常映射为 TrendsErrorKind（附带 HTTP status 时优先按 status 判定）。 */
export function classifyTrendsError(err: unknown, status?: number): TrendsErrorKind {
  const s = status ?? errorStatusOf(err);
  if (s === 403 || s === 429) return 'rate-limited';
  const name = (err as { name?: unknown })?.name;
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  if (name === 'AbortError' || /abort|timeout|timed out/i.test(msg)) return 'timeout';
  if (err instanceof TypeError || /failed to fetch|network|load failed/i.test(msg)) return 'network';
  if (/rate.?limit/i.test(msg)) return 'rate-limited';
  return 'unavailable';
}

export type TimeBoardId = 'daily' | 'weekly' | 'monthly';

// ---------------------------------------------------------------------------
// 时间榜主源：github.com/trending HTML 抓取（一榜一查询，无降级链）。
// URL 形如 `https://github.com/trending[/<language>]?since=daily|weekly|monthly`。
// 解析规则见 parseTrendingHtml / mapTrendingArticle。
// github.com/trending 恒走直连（trends 流量永不套用代理，见上）。
// ---------------------------------------------------------------------------

/** Board → trending `?since=` 参数的单一映射（SSOT）。 */
export const TRENDING_SINCE: Record<TimeBoardId, 'daily' | 'weekly' | 'monthly'> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

/**
 * 榜单路由/展示 SSOT：6 榜全集 + gain 文案口径 + 陈旧榜回落，trends.ts 与
 * TrendsView 共用（收敛原先两处级联：此处 `in TRENDING_SINCE` 检查 + switch，
 * 视图侧 `BOARD_TO_GAIN_KEY` 映射 + `BOARD_IDS.includes` 回落）。
 */

/** 当前 6 榜全集（常青/分类榜已下线，不在此列）。 */
export const TREND_BOARD_IDS: readonly TrendBoardId[] = [
  'daily',
  'weekly',
  'monthly',
  'new',
  'rising',
  'healthy',
];

export type TrendGainKey = 'today' | 'week' | 'month';

/** 榜单 → gain 文案口径（today/week/month），一处维护。 */
export const BOARD_GAIN_KEY: Record<TrendBoardId, TrendGainKey> = {
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
  new: 'week',
  rising: 'week',
  healthy: 'week',
};

/** gain 文案口径查询（BOARD_GAIN_KEY 的唯一出口）。 */
export function boardGainKey(board: TrendBoardId): TrendGainKey {
  return BOARD_GAIN_KEY[board];
}

/** 时间榜判定（TRENDING_SINCE 单一映射的唯一出口，替代散写的 `in` 检查）。 */
export function isTimeBoard(board: string): board is TimeBoardId {
  return board in TRENDING_SINCE;
}

/** 陈旧榜回落：非当前 6 榜（如已下线的 'top' / 'category' 残留）一律回落 'weekly'。 */
export function resolveTrendBoard(board: string): TrendBoardId {
  return (TREND_BOARD_IDS as readonly string[]).includes(board)
    ? (board as TrendBoardId)
    : 'weekly';
}

/** 构造 trending 抓取 URL（language 走 `/trending/<lang>` 路径段）。 */
export function buildTrendingUrl(board: TimeBoardId, opts: FetchTrendsOptions = {}): string {
  const since = TRENDING_SINCE[board];
  const lang = opts.language?.trim();
  const raw =
    lang && lang.toLowerCase() !== 'all'
      ? `https://github.com/trending/${encodeURIComponent(lang)}?since=${since}`
      : `https://github.com/trending?since=${since}`;
  return withTrendsProxy(raw, opts);
}

/**
 * 解析紧凑数字："1,234" / "12.3k" / "1.2M" / "56"。
 * 非数字返回 undefined（调用方自行回退，绝不伪造）。
 */
export function parseCompactNumber(raw: string): number | undefined {
  const t = raw.trim().replace(/,/g, '');
  const m = t.match(/^([\d.]+)\s*([kKmM]?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  const mult = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 解析单个 `article.Box-row`：
 * - 仓库身份：首个恰为两段路径的 `a[href="/owner/repo"]`
 *   （`/owner/repo/stargazers` 等三段链接一律跳过）；
 * - 增量：`([\d,]+) stars (today|this week|this month)` 文本
 *   （含单数 "1 star today"），解析为 starsGained（真实数字）；
 * - 总量：stargazers/forks 链接文本（k/m 缩写展开）；缺失时 stars 回退 0
 *  （TrendRepo.stars 为必填 number）、forks 保持 undefined。
 */
function mapTrendingArticle(articleHtml: string): TrendRepo | null {
  const linkRe = /<a\b[^>]*\bhref="(\/[^"]+)"[^>]*>/gi;
  let owner = '';
  let repo = '';
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(articleHtml)) !== null) {
    const path = m[1].split('?')[0].split('#')[0];
    const segs = path.split('/').filter((s) => s.trim() !== '');
    if (segs.length === 2 && /^[A-Za-z0-9_.-]+$/.test(segs[0]) && /^[A-Za-z0-9_.-]+$/.test(segs[1])) {
      owner = segs[0];
      repo = segs[1];
      break;
    }
  }
  if (!owner || !repo) return null;
  const fullName = `${owner}/${repo}`;
  const text = stripHtmlTags(articleHtml);
  const gainMatch = text.match(/([\d,]+)\s+stars?\s+(today|this\s+week|this\s+month)/i);
  let starsGained: number | undefined;
  if (gainMatch) {
    const n = Number(gainMatch[1].replace(/,/g, ''));
    starsGained = Number.isFinite(n) ? n : undefined;
  }
  const totalFor = (kind: 'stargazers' | 'forks'): number | undefined => {
    const re = new RegExp(`href="[^"]*/${kind}"[^>]*>([\\s\\S]*?)<\\/a>`, 'i');
    const hit = articleHtml.match(re);
    if (!hit) return undefined;
    return parseCompactNumber(stripHtmlTags(hit[1]));
  };
  const stars = totalFor('stargazers') ?? 0;
  const forks = totalFor('forks');
  const descMatch = articleHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const descText = descMatch ? stripHtmlTags(descMatch[1]) : '';
  return {
    id: fullName,
    name: fullName,
    owner,
    repo,
    stars,
    // 增量来自页面真实文本；缺失即 undefined，UI 仅 defined 渲染 +N。
    starsGained,
    forks,
    description: descText ? descText : undefined,
    url: `https://github.com/${fullName}`,
  };
}

/** 解析 trending 整页：抽取全部 `article.Box-row` 并按 fullName 去重。 */
export function parseTrendingHtml(html: string): TrendRepo[] {
  const articleRe = /<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  const repos: TrendRepo[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = articleRe.exec(html)) !== null) {
    const r = mapTrendingArticle(m[1]);
    if (!r) continue;
    const key = r.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(r);
  }
  return repos;
}

/**
 * daily/weekly/monthly 主源：trending HTML（Rust 侧抓取，10s 超时，无 CORS 概念）。
 * 失败抛错（上层映射 errorKind），空页返回 []。
 */
export async function fetchTrendingRepos(
  board: TimeBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendRepo[]> {
  const url = buildTrendingUrl(board, opts);
  const html = await tauriApi.fetchTrendsText(url);
  return parseTrendingHtml(html);
}
// ---------------------------------------------------------------------------
// rising / healthy primary: doforce public API (no key).
// URL: https://trend.doforce.dpdns.org/repo (200 JSON array).
// Item shape: {"repo":"/owner/name","desc","lang","stars","forks","change",...}
// where `change` is the real period stars gained (same semantics as the
// trending daily increment). Single-flight shared fetch + 12h shared cache
// (see below); rising sorts by change desc, healthy by (forks + change).
// ---------------------------------------------------------------------------

export const DOFORCE_URL = 'https://trend.doforce.dpdns.org/repo';

/** Build the doforce request URL (always direct). */
export function buildDoforceUrl(opts: FetchTrendsOptions = {}): string {
  return withTrendsProxy(DOFORCE_URL, opts);
}

function numOrUndefined(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v.trim().replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map a doforce item. `repo` carries a leading slash ("/owner/name") which is
 * stripped; `desc` -> description (`lang` dropped: TrendRepo has no language
 * field and nothing consumes it). starsGained = change (real gained stars);
 * missing/non-numeric change -> undefined, never faked from totals.
 */
function mapDoforceItem(item: Record<string, unknown>): TrendRepo | null {
  const rawRepo = String(item.repo ?? item.full_name ?? item.fullName ?? '').trim().replace(/^\/+/, '');
  if (!rawRepo.includes('/')) return null;
  const [owner, ...rest] = rawRepo.split('/');
  const repo = rest.join('/').trim();
  const cleanOwner = owner.trim();
  if (!cleanOwner || !repo) return null;
  const id = `${cleanOwner}/${repo}`;
  const change = numOrUndefined(item.change);
  const stars = Number(item.stars ?? 0);
  const forks = numOrUndefined(item.forks);
  const description = item.desc ?? item.description;
  return {
    id,
    name: id,
    owner: cleanOwner,
    repo,
    stars: Number.isFinite(stars) ? stars : 0,
    starsGained: change,
    forks,
    description: description ? String(description) : undefined,
    url: `https://github.com/${id}`,
  };
}

/**
 * doforce primary (fetched Rust-side, 10s timeout, no CORS concept).
 * Accepts a bare array or an `{items|data|repos}` envelope; throws on failure,
 * returns [] when empty.
 */
export async function fetchDoforceRepos(): Promise<TrendRepo[]> {
  const url = buildDoforceUrl({});
  const text = await tauriApi.fetchTrendsText(url);
  const json: unknown = JSON.parse(text);
  const items = Array.isArray(json) ? json : ((json as Record<string, unknown>)?.items ?? (json as Record<string, unknown>)?.data ?? (json as Record<string, unknown>)?.repos);
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .map((it: Record<string, unknown>) => mapDoforceItem(it))
    .filter((item): item is TrendRepo => item !== null);
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
 * new 榜主源：GitHub Search（created:>6个月，免 key 可用但配额极严）。
 * Rust 侧抓取，10s 超时；失败/空由上层按 error/empty 契约返回。
 */
export async function fetchGitHubNewRepos(): Promise<TrendRepo[]> {
  const since = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = withTrendsProxy(
    `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=20`,
  );

  const text = await tauriApi.fetchTrendsText(url);
  const json: unknown = JSON.parse(text);
  const items = (json as Record<string, unknown>)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .map((it: Record<string, unknown>) => mapGitHubSearchItem(it))
    .filter((item): item is TrendRepo => item !== null);
}

// ---------------------------------------------------------------------------
// 纯函数排序/过滤。rising / healthy 由各自主源快照排序（见各 fetch*Result）；
// 下列 ranker 为 retained 纯工具（healthyScore 仍被 healthy 榜连线）。
// ---------------------------------------------------------------------------

/** 增速比 = starsGained / max(1, stars - starsGained)。 */
export function growthRatio(repo: TrendRepo): number {
  const gained = repo.starsGained ?? 0;
  return gained / Math.max(1, repo.stars - gained);
}

/** 按增速比降序（纯函数）。 */
export function rankByGrowthRatio(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => growthRatio(b) - growthRatio(a));
}

/**
 * healthy 榜代理分 = (forks ?? 0) + (starsGained ?? 0)。
 * healthy 榜连线此函数（starsGained 即 doforce change）。
 */
export function healthyScore(repo: TrendRepo): number {
  return (repo.forks ?? 0) + (repo.starsGained ?? 0);
}

/** 按 healthy 代理分降序（纯函数，healthy 榜连线）。 */
export function sortByHealthyScore(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => healthyScore(b) - healthyScore(a));
}

/** new 榜客户端兜底阈值（显式调用，非隐式 fallback）。 */
export const NEW_FALLBACK_MAX_STARS = 2000;
export const NEW_FALLBACK_MAX_FORKS = 500;

/**
 * new 榜客户端兜底视图（纯函数，显式调用，非隐式 fallback）：
 * `stars<2000 && forks<500` 启发式近似“新仓”，组内按 starsGained 降序
 *（缺失按 0，不回退总量）。
 * `fetchTrends('new')` 远端失败时直接返回 error，不再隐式复用。
 */
export function filterNewReposFallback(repos: TrendRepo[]): TrendRepo[] {
  return repos
    .filter((r) => r.stars < NEW_FALLBACK_MAX_STARS && (r.forks ?? 0) < NEW_FALLBACK_MAX_FORKS)
    .sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0));
}

// ---------------------------------------------------------------------------
// 统一入口：严格一榜一源，无任何榜单内降级链。
// 主源失败 → {status:'error', errorKind}；合法空 → {status:'empty'}。
// 5 分钟缓存仅在成功（非空）时写入；各榜缓存键独立，互不复用。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 四榜单抓取的统一包装：try/取数/z-log 落盘/按契约返回，仅此一处。
// 各榜把“取数（含缓存检查、排序）”装进 load 闭包；空 → empty，抛错 → error。
// 成功日志口径：`[trends] board=<b> source=<s> ok count=<n>`；失败走同源 error 行。
// ---------------------------------------------------------------------------

async function runBoardFetch(
  board: TrendBoardId,
  source: string,
  load: () => Promise<TrendRepo[]>,
): Promise<TrendsResult> {
  try {
    const repos = await load();
    if (repos.length === 0) return { repos: [], status: 'empty' };
    zlogInfo(`[trends] board=${board} source=${source} ok count=${repos.length}`);
    return { repos, status: 'ok' };
  } catch (err) {
    const errorKind = classifyTrendsError(err);
    zlogWarn(
      `[trends] board=${board} source=${source} error kind=${errorKind} ` +
        `status=${errorStatusOf(err) ?? '-'} msg=${String((err as { message?: unknown })?.message ?? err)}`,
    );
    return { repos: [], status: 'error', errorKind };
  }
}

async function fetchTimeBoardResult(board: TimeBoardId, opts: FetchTrendsOptions): Promise<TrendsResult> {
  const key = buildTrendsCacheKey(board, opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return { repos: hit, status: 'ok' };
  }

  // 单一主源：trending HTML。失败按 errorKind 返回，绝不降级、不伪造。
  // 日志经 z-log 落盘（F12 不可用，console 不可见）：board + source + count/kind。
  // 成功（非空）才写缓存；空/失败不写。
  const result = await runBoardFetch(board, 'trending-html', () => fetchTrendingRepos(board, opts));
  if (result.status === 'ok') writeTrendsCache(key, result.repos);
  return result;
}

async function fetchNewBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  const key = buildTrendsCacheKey('new', opts);
  if (!opts.forceRefresh) {
    const hit = readTrendsCache(key);
    if (hit) return { repos: hit, status: 'ok' };
  }

  // new 榜单一远端源：GitHub search（created 6mo 窗口）。失败/空按契约返回。
  const result = await runBoardFetch('new', 'github-search', () => fetchGitHubNewRepos());
  if (result.status === 'ok') writeTrendsCache(key, result.repos);
  return result;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 解析 Retry-After 等待毫秒数：纯秒数或 HTTP-date。
 * 返回 undefined 表示无可用值；HTTP-date 已过期返回 0（立即重试）。
 */
export function parseRetryAfterMs(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  if (/^\d+$/.test(t)) {
    const ms = Number(t) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const at = Date.parse(t);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * 从错误串提取 Retry-After 值并换算等待毫秒。
 * Rust 侧当前仅回传状态码（`upstream status 429`），header 值不可见时返回
 * 默认等待；若未来后端把 header 值写入错误串（如 `retry-after: 30`），
 * 此处按秒数/HTTP-date 兑现，上限 60s（超限返回 undefined = 直接 error）。
 */
export function doforceRetryDelayMs(err: unknown): number | undefined {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  const m = msg.match(/retry-after\s*[:=]\s*([^\s,;]+(?:\s+[^\s,;]+)*)/i);
  const wait = parseRetryAfterMs(m?.[1]) ?? DOFORCE_RETRY_DEFAULT_WAIT_MS;
  if (wait > DOFORCE_RETRY_MAX_WAIT_MS) return undefined;
  return wait;
}

/**
 * doforce 单次重试抓取：429 且等待可接受时恰好再试一次并如实落盘；
 * 仍 429/其他失败直接抛给上层（error/empty 契约不变）。
 */
async function fetchDoforceWithRetry(): Promise<TrendRepo[]> {
  try {
    return await fetchDoforceRepos();
  } catch (err) {
    if (classifyTrendsError(err) !== 'rate-limited') throw err;
    const wait = doforceRetryDelayMs(err);
    if (wait === undefined) throw err;
    zlogWarn(`[trends] doforce 429 single retry after ${wait}ms`);
    await sleep(wait);
    return fetchDoforceRepos();
  }
}

/**
 * doforce 单飞共享抓取：并发的 rising/healthy 复用同一在途 Promise；
 * 成功（非空）写入 12h 共享缓存；空结果不缓存。forceRefresh 强制重抓。
 */
async function fetchDoforceShared(forceRefresh = false): Promise<TrendRepo[]> {
  if (!forceRefresh) {
    const hit = readDoforceShared();
    if (hit) {
      zlogInfo('[trends] doforce shared-cache hit');
      return hit;
    }
    if (doforceInflight) {
      zlogInfo('[trends] doforce single-flight shared-hit');
      return doforceInflight;
    }
  }
  const slot: { current?: Promise<TrendRepo[]> } = {};
  slot.current = (async (): Promise<TrendRepo[]> => {
    try {
      const repos = await fetchDoforceWithRetry();
      if (repos.length > 0) {
        doforceSharedCache = { timestamp: Date.now(), data: repos };
      }
      return repos;
    } finally {
      if (doforceInflight === slot.current) doforceInflight = undefined;
    }
  })();
  doforceInflight = slot.current;
  return slot.current;
}

async function fetchRisingBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  // rising 取 doforce 共享快照（12h/单飞），按 change 降序；榜单自身不再另设缓存。
  return runBoardFetch('rising', 'doforce', async () => {
    const repos = await fetchDoforceShared(opts.forceRefresh);
    if (repos.length === 0) return [];
    return [...repos].sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0));
  });
}

async function fetchHealthyBoardResult(opts: FetchTrendsOptions): Promise<TrendsResult> {
  // healthy 取 doforce 共享快照（12h/单飞），按 healthyScore 代理分降序；榜单自身不再另设缓存。
  return runBoardFetch('healthy', 'doforce', async () => {
    const repos = await fetchDoforceShared(opts.forceRefresh);
    if (repos.length === 0) return [];
    return sortByHealthyScore(repos);
  });
}

/**
 * 非时间榜分发表：new/rising/healthy 各自一源（替代 switch 级联，与 isTimeBoard 配对）。
 */
const STATIC_BOARD_FETCHERS: Record<string, (opts: FetchTrendsOptions) => Promise<TrendsResult>> = {
  new: fetchNewBoardResult,
  rising: fetchRisingBoardResult,
  healthy: fetchHealthyBoardResult,
};

/**
 * 统一趋势抓取入口（Result 契约，UI lane 依赖，保持 STABLE）：
 * daily/weekly/monthly → github.com/trending HTML（?since=daily|weekly|monthly）；
 * rising → doforce 公开 API（按 change 降序）；
 * healthy → doforce 公开 API（按 forks + change 代理分降序）；
 * new → GitHub search（created 6mo 窗口）。
 * 一榜一源、无降级链：主源失败即 error、有空即 empty；成功（非空）才写缓存
 * （5 分钟按榜；rising/healthy 共用 doforce 12h 共享快照 + 单飞请求）。
 * Cache key = board + language + category (written on success only).
 */
export async function fetchTrendsResult(
  board: TrendBoardId,
  opts: FetchTrendsOptions = {},
): Promise<TrendsResult> {
  // 时间榜路由走 TRENDING_SINCE 单一映射（isTimeBoard 唯一出口）；其余走静态分发表。
  if (isTimeBoard(board)) {
    return fetchTimeBoardResult(board, opts);
  }
  const fetcher = STATIC_BOARD_FETCHERS[board];
  if (fetcher) return fetcher(opts);
  throw new Error(`[trends] unknown board: ${String(board)}`);
}

/**
 * 兼容入口：签名保持不变，内部委托 fetchTrendsResult，仅返回 repos。
 * 需要状态/错误细分的调用方请使用 fetchTrendsResult。
 */
export async function fetchTrends(board: TrendBoardId, opts: FetchTrendsOptions = {}): Promise<TrendRepo[]> {
  const result = await fetchTrendsResult(board, opts);
  return result.repos;
}
