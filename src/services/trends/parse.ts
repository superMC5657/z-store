import type { FetchTrendsOptions, TrendRepo, TrendsErrorKind } from '../../types';
import { DOFORCE_RETRY_DEFAULT_WAIT_MS, DOFORCE_RETRY_MAX_WAIT_MS } from './cache';

/** 规范化 proxy 前缀：empty/direct -> undefined；ghproxy -> 默认值；保留 http(s)。 */
export function normalizeProxyPrefix(raw?: string): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (!t || t === 'direct') return undefined;
  if (t === 'ghproxy') return 'https://gh-proxy.com';
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, '');
  return undefined;
}

/**
 * @deprecated 恒等函数：trends 流量始终直连，不应用任何前缀。
 * 保留此函数（仍被各 trends URL 构建器调用），以便后续若重新调整策略时调用方无需改动——
 * 仅需在此处统一修改一次，而无需改动每个调用点。
 */
export function withTrendsProxy(url: string, _opts: FetchTrendsOptions = {}): string {
  void _opts;
  return url;
}

export function errorStatusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  if (typeof s === 'number') return s;
  // Rust invoke 拒绝值为纯字符串（`.status` 经序列化丢失），从错误串回解析
  // `upstream status {code}`，直透调用下 errorKind 映射保持不变（见 api.fetchTrendsText）。
  return errorStatusFromMessage(err);
}

/** 从错误串回解析 HTTP 状态（`upstream status {code}` / `... status {code}`）。 */
export function errorStatusFromMessage(err: unknown): number | undefined {
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

export function stripHtmlTags(html: string): string {
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
export function mapTrendingArticle(articleHtml: string): TrendRepo | null {
  const linkRe = /<a\b[^>]*\bhref="(\/[^"]+)"[^>]*>/gi;
  let owner = '';
  let repo = '';
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(articleHtml)) !== null) {
    const path = m[1].split('?')[0].split('#')[0];
    const segs = path.split('/').filter((s) => s.trim() !== '');
    if (segs.length === 2 && /^[A-Za-z0-9_.-]+$/.test(segs[0]) && /^[A-Za-z0-9_.-]+$/.test(segs[1])) {
      // 非仓库两段链直接跳过：/sponsors/xxx（赞助页）及 topics/settings 等保留路由。
      const first = segs[0].toLowerCase();
      if (
        first === 'sponsors' ||
        first === 'topics' ||
        first === 'settings' ||
        first === 'marketplace' ||
        first === 'explore' ||
        first === 'collections' ||
        first === 'events' ||
        first === 'notifications'
      )
        continue;
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

export function numOrUndefined(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v.trim().replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 映射 doforce 数据项。`repo` 带有前导斜杠（"/owner/name"）需去除；
 * `desc` -> description（丢弃 `lang`：TrendRepo 无 language 字段且无下游消费）。
 * starsGained = change（真实新增 stars）；
 * 缺失或非数字的 change -> undefined，绝不从总量中伪造。
 */
export function mapDoforceItem(item: Record<string, unknown>): TrendRepo | null {
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

export function mapGitHubSearchItem(item: Record<string, unknown>): TrendRepo | null {
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

/** 增速比 = starsGained / max(1, stars - starsGained)。 */
export function growthRatio(repo: TrendRepo): number {
  const gained = repo.starsGained ?? 0;
  return gained / Math.max(1, repo.stars - gained);
}

/**
 * P1正确性（C2 排序沉底）：starsGained 降序比较器（SSOT）。
 * - undefined 恒沉底（缺增量绝不冒充 0 参与排名）；
 * - 双 defined 按数值降序；
 * - tie 按 id 升序（确定性，与后端 ranker 同口径）。
 */
export function compareStarsGainedDesc(a: TrendRepo, b: TrendRepo): number {
  const ag = a.starsGained;
  const bg = b.starsGained;
  const aUndef = ag === undefined;
  const bUndef = bg === undefined;
  if (aUndef && bUndef) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (aUndef) return 1;
  if (bUndef) return -1;
  if (bg !== ag) return (bg as number) - (ag as number);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 按增速比降序（纯函数，tie 按 id 升序）。 */
export function rankByGrowthRatio(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => {
    const diff = growthRatio(b) - growthRatio(a);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * healthy 榜代理分 = (forks ?? 0) + (starsGained ?? 0)。
 * healthy 榜连线此函数（starsGained 即 doforce change）。
 */
export function healthyScore(repo: TrendRepo): number {
  return (repo.forks ?? 0) + (repo.starsGained ?? 0);
}

/** 按 healthy 代理分降序（纯函数，healthy 榜连线；tie 按 id 升序）。 */
export function sortByHealthyScore(repos: TrendRepo[]): TrendRepo[] {
  return [...repos].sort((a, b) => {
    const diff = healthyScore(b) - healthyScore(a);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** new 榜客户端兜底阈值（显式调用，非隐式 fallback）。 */
export const NEW_FALLBACK_MAX_STARS = 2000;
export const NEW_FALLBACK_MAX_FORKS = 500;

/**
 * new 榜客户端兜底视图（纯函数，显式调用，非隐式 fallback）：
 * `stars<2000 && forks<500` 启发式近似“新仓”，组内按 starsGained 降序
 *（C2：undefined 恒沉底，tie 按 id 升序；缺失绝不回退总量）。
 * `fetchTrends('new')` 远端失败时直接返回 error，不再隐式复用。
 */
export function filterNewReposFallback(repos: TrendRepo[]): TrendRepo[] {
  return repos
    .filter((r) => r.stars < NEW_FALLBACK_MAX_STARS && (r.forks ?? 0) < NEW_FALLBACK_MAX_FORKS)
    .sort(compareStarsGainedDesc);
}

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
 * Phase2治理：BE 429 分支透传 `retry_after_ms={毫秒}`（见 commands/network.rs），
 * 此处优先按毫秒直值兑现（无需 ×1000），兼容 `retry-after-ms` 连字符形。
 */
export function doforceRetryDelayMs(err: unknown): number | undefined {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  const msDirect = msg.match(/retry[_-]after[_-]ms\s*[:=]\s*(\d+)/i)?.[1];
  if (msDirect !== undefined) {
    const ms = Number(msDirect);
    if (!Number.isFinite(ms) || ms < 0) return DOFORCE_RETRY_DEFAULT_WAIT_MS;
    if (ms > DOFORCE_RETRY_MAX_WAIT_MS) return undefined;
    return ms;
  }
  const m = msg.match(/retry-after\s*[:=]\s*([^\s,;]+(?:\s+[^\s,;]+)*)/i);
  const wait = parseRetryAfterMs(m?.[1]) ?? DOFORCE_RETRY_DEFAULT_WAIT_MS;
  if (wait > DOFORCE_RETRY_MAX_WAIT_MS) return undefined;
  return wait;
}
