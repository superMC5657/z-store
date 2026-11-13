import type { AppSummary } from '../types';

/**
 * 精选页主流 feed 纯函数模块（后端 `get_home_feed` 不可用时的前端回退排序）。
 *
 * 约定：
 * - `rankFeed` 只对调用方传入的数组排序（精选页传入已滤掉 hero 与货架的剩余应用），不在内部挑 hero；
 * - 算法可插拔：`feedScorers` 按策略导出打分器，`rankFeed` 支持第 4 个可选
 *   `scorer` 参数覆盖内置策略。
 */

export type FeedStrategy = 'balanced' | 'stars' | 'fresh';

/** 打分器签名：入参为应用与该应用在当前 seed 下的确定性抖动（[0, 1)），返回分数（越大越靠前）。 */
type FeedScorer = (app: AppSummary, jitter01: number) => number;

/** 前端亲和度打分输入（消费应用内显式收藏与关注信号）。 */
interface FrontendAffinityInput {
  catalog?: readonly AppSummary[];
  favoriteIds?: ReadonlySet<string> | readonly string[];
  watchedIds?: ReadonlySet<string> | readonly string[];
  enabled?: boolean;
}

/** balanced 策略的抖动半幅（总摆动 2 * HALF）。取 0.15 保证只有头部相近星数才会被打散，深部大差距不受影响。 */
const FEED_JITTER_HALF = 0.15;

/**
 * FNV-1a 64 + seed 混合：同一 (id, seed) 必得同一抖动，换 seed 即换一批。
 *
 * 前后端映射（后端哈希不动，前端向后端对齐）：
 * - 后端 canonical：`src-tauri/src/github/catalog_feed_score.rs::fnv1a64_with_seed`
 *   `h = OFFSET(0xcbf29ce484222325) ^ seed` 起步，按 UTF-8 字节 `h ^= b; h *= PRIME(0x100000001b3)`
 *  （wrapping‐mod 2^64），雪崩 `h ^= h>>33; h *= 0xff51afd7ed558ccd; h ^= h>>33`；
 * - 本函数用 BigInt 复刻上述 64 位语义（含 `>>33` 雪崩与除数 `2^64`），id 先 `toLowerCase`
 *   再按 UTF-8 字节迭代，与后端 `to_lowercase + as_bytes` 对齐；
 * - 后端 `feed_jitter01 = h / 2^64`，此处同除 `18446744073709551616.0`（`Number(h)` 与 Rust `h as f64`
 *   同为最近 f64 舍入，跨层可比）；
 * - 打分表见下方 `feedScorers`，与后端 `feed_score` 同形同量级（Balanced ±0.15 / Fresh jitter*10）。
 */
export function hashSeeded01(id: string, seed: number): number {
  const MASK64 = (1n << 64n) - 1n;
  const OFFSET64 = 0xcbf29ce484222325n;
  const PRIME64 = 0x100000001b3n;
  const AVALANCHE_MUL = 0xff51afd7ed558ccdn;
  const DIV_2P64 = 18446744073709551616;
  const rawSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  let seed64: bigint;
  try {
    seed64 = BigInt.asUintN(64, BigInt(rawSeed));
  } catch {
    seed64 = 0n;
  }
  let h = (OFFSET64 ^ seed64) & MASK64;
  const s = String(id).toLowerCase();
  let bytes: ArrayLike<number>;
  try {
    bytes = new TextEncoder().encode(s);
  } catch {
    bytes = Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  }
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= BigInt(bytes[i] as number);
    h = (h * PRIME64) & MASK64;
  }
  // 最终雪崩强化低位区分度（与后端同式：>>33 一次乘法两次移位）。
  h ^= h >> 33n;
  h = (h * AVALANCHE_MUL) & MASK64;
  h ^= h >> 33n;
  return Number(h) / DIV_2P64;
}

function starsBase(app: AppSummary): number {
  const stars = Number(app?.stars);
  return Math.log1p(Number.isFinite(stars) && stars > 0 ? stars : 0);
}

/**
 * Stars + Forks 双因子对数质量基线：`ln(stars + 1) + 0.25 * ln(forks + 1)`。
 * 当 `forks === 0` 时与 `starsBase` 逐位一致。
 */
export function starsForksBase(app: AppSummary): number {
  const stars = Number(app?.stars);
  const forks = Number(app?.forks);
  const s = Number.isFinite(stars) && stars > 0 ? stars : 0;
  const f = Number.isFinite(forks) && forks > 0 ? forks : 0;
  return Math.log1p(s) + 0.25 * Math.log1p(f);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'app',
  'application', 'tool', 'tools', 'open', 'source', 'free', 'cross', 'platform',
  'based', 'written', 'modern', 'fast', 'simple', 'lightweight', 'client', 'server',
  'desktop', 'windows', 'macos', 'linux', 'android', 'ios', 'using', 'built', 'support',
]);

function extractTokens(text: string): string[] {
  if (!text) return [];
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((tok) => {
      if (!tok || STOPWORDS.has(tok)) return false;
      const isAscii = /^[\x00-\x7f]+$/.test(tok);
      return isAscii ? tok.length >= 3 : Array.from(tok).length >= 2;
    });
  return Array.from(new Set(raw)).slice(0, 16);
}

function normalizeWeightMap(raw: Map<string, number>, tau: number): Map<string, number> {
  let maxVal = 0;
  for (const v of raw.values()) {
    if (v > maxVal) maxVal = v;
  }
  const out = new Map<string, number>();
  if (maxVal <= 1e-9) return out;
  for (const [k, v] of raw.entries()) {
    if (v <= 0) continue;
    const rel = v / maxVal;
    const sat = 1 - Math.exp(-v / tau);
    out.set(k, Math.min(1, Math.max(0, rel * sat)));
  }
  return out;
}

function toNormalizedSet(input?: ReadonlySet<string> | readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!input) return out;
  for (const item of input) {
    const trimmed = String(item ?? '').trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/**
 * 基于前端已知的收藏 (`favoriteIds`) 与关注 (`watchedIds`) 信号构建与后端同构的本地动态推荐打分器。
 * 当 `enabled === false` 或无任何匹配信号时返回 `undefined`，使 `rankFeed` 使用默认基线排序。
 */
export function buildFrontendAffinityScorer(input?: FrontendAffinityInput): FeedScorer | undefined {
  if (!input || input.enabled === false) return undefined;
  const favSet = toNormalizedSet(input.favoriteIds);
  const watchSet = toNormalizedSet(input.watchedIds);
  if (favSet.size === 0 && watchSet.size === 0) return undefined;

  const catalog = input.catalog ?? [];
  if (catalog.length === 0) return undefined;

  const byId = new Map<string, AppSummary>();
  for (const app of catalog) {
    const id = String(app?.id ?? '').trim().toLowerCase();
    if (id && !byId.has(id)) byId.set(id, app);
  }

  const rawCategories = new Map<string, number>();
  const rawOwners = new Map<string, number>();
  const rawTokens = new Map<string, number>();
  const knownIds = new Set<string>();
  let forkRatioWeightedSum = 0;
  let forkRatioWeightTotal = 0;
  let matchedAny = false;

  const addAppSignal = (id: string, baseWeight: number) => {
    knownIds.add(id);
    const item = byId.get(id);
    if (!item) return;
    matchedAny = true;
    const stars = Math.max(0, Number(item.stars) || 0);
    const forks = Math.max(0, Number(item.forks) || 0);
    const scale = 1 + 0.04 * Math.log1p(stars) + 0.08 * Math.log1p(forks);
    const w = baseWeight * scale;

    const cat = String(item.category ?? '').trim().toLowerCase();
    if (cat) rawCategories.set(cat, (rawCategories.get(cat) ?? 0) + w);

    const owner = String(item.owner || item.id.split('/')[0] || '').trim().toLowerCase();
    if (owner) rawOwners.set(owner, (rawOwners.get(owner) ?? 0) + w);

    const text = `${item.name ?? ''} ${item.repo ?? ''} ${item.description ?? ''} ${item.description_en ?? ''}`;
    for (const tok of extractTokens(text)) {
      rawTokens.set(tok, (rawTokens.get(tok) ?? 0) + w);
    }

    if (stars > 0) {
      const ratio = Math.min(forks / stars, 1);
      forkRatioWeightedSum += ratio * w;
      forkRatioWeightTotal += w;
    }
  };

  for (const id of favSet) addAppSignal(id, 4.0);
  for (const id of watchSet) addAppSignal(id, 3.5);

  if (!matchedAny) return undefined;

  const categoryWeights = normalizeWeightMap(rawCategories, 2.2);
  const ownerWeights = normalizeWeightMap(rawOwners, 2.5);
  const tokenWeights = normalizeWeightMap(rawTokens, 2.5);
  const avgForkRatio =
    forkRatioWeightTotal > 0 ? Math.min(1, Math.max(0, forkRatioWeightedSum / forkRatioWeightTotal)) : 0;

  return (app: AppSummary, jitter01: number): number => {
    const base = starsForksBase(app);
    const jitter = (jitter01 - 0.5) * FEED_JITTER_HALF * 2;
    const idLower = String(app.id ?? '').trim().toLowerCase();
    const isKnown = knownIds.has(idLower);

    const catKey = String(app.category ?? '').trim().toLowerCase();
    const catScore = 3.2 * (categoryWeights.get(catKey) ?? 0);

    const ownerKey = String(app.owner || idLower.split('/')[0] || '').trim().toLowerCase();
    const ownerScore = isKnown ? 0 : 1.8 * (ownerWeights.get(ownerKey) ?? 0);

    const text = `${app.description ?? ''} ${app.description_en ?? ''}`;
    const tokHits = extractTokens(text)
      .map((t) => tokenWeights.get(t) ?? 0)
      .filter((v) => v > 0)
      .sort((a, b) => b - a);
    let rawTokScore = 0;
    if (tokHits.length > 0) {
      const takeN = Math.min(3, tokHits.length);
      let sum = 0;
      for (let i = 0; i < takeN; i += 1) {
        sum += tokHits[i];
      }
      rawTokScore = Math.min(1, Math.max(0, sum / takeN));
    }
    const tokScore = 1.8 * (isKnown ? rawTokScore * 0.4 : rawTokScore);

    const stars = Math.max(0, Number(app.stars) || 0);
    const forks = Math.max(0, Number(app.forks) || 0);
    const forkResonance =
      stars > 0 && forks > 0 && avgForkRatio > 0
        ? (1 - Math.min(Math.abs(Math.min(forks / stars, 1) - avgForkRatio) / 0.25, 1)) * 0.35
        : 0;

    const knownPenalty = isKnown ? 1.2 : 0;
    const boost = catScore + ownerScore + tokScore + forkResonance - knownPenalty;
    return base + boost + jitter;
  };
}

/**
 * 订阅后端 `zstore://affinity-updated` 事件（以及本地 `zstore:affinity-updated` DOM 事件），
 * 供视图层 Hook 在不直调 `@tauri-apps/api/event` 的前提下感知画像变更。
 */
export function subscribeAffinityUpdated(onUpdate: () => void): () => void {
  let disposed = false;
  let unlistenTauri: (() => void) | undefined;

  const handleDomEvent = () => {
    if (!disposed) onUpdate();
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('zstore:affinity-updated', handleDomEvent);
  }

  const hasTauri = (() => {
    try {
      return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    } catch {
      return false;
    }
  })();

  if (hasTauri) {
    import('@tauri-apps/api/event')
      .then((mod) => mod.listen('zstore://affinity-updated', () => {
        if (!disposed) onUpdate();
      }))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenTauri = unlisten;
        }
      })
      .catch(() => {
        // 非 Tauri 环境或监听失败时静默忽略
      });
  }

  return () => {
    disposed = true;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('zstore:affinity-updated', handleDomEvent);
    }
    if (unlistenTauri) {
      try {
        unlistenTauri();
      } catch {
        // ignore
      }
    }
  };
}

/**
 * 内置三策略（可插拔：调用方可直接复用/替换此表，或经 `rankFeed` 第 4 参数覆盖）：
 * - balanced（默认）：stars + forks 双因子主序 + 轻扰动打散头部（±0.15）；
 * - stars：纯星数降序，seed 无影响，行为完全确定；
 * - fresh：seed 抖动主导 + 星数只给 5% 权重（目录暂无时间字段，用抖动近似“常看常新”，换 seed 即换一批）。
 */
const feedScorers: Record<FeedStrategy, FeedScorer> = {
  stars: (app) => starsBase(app),
  balanced: (app, jitter01) => starsForksBase(app) + (jitter01 - 0.5) * FEED_JITTER_HALF * 2,
  fresh: (app, jitter01) => jitter01 * 10 + starsBase(app) * 0.05,
};

/**
 * 推荐排序（纯函数，不改入参顺序，返回新数组）：
 * - 默认 `balanced`：星数降序为主，seed 只做轻扰动；
 * - 同分时按 id 升序（与后端 `rank_feed_with_strategy` 的 `then_with(id)` 对齐，保证跨层确定性）；
 * - 空数组返回空数组。
 */
export function rankFeed(
  apps: AppSummary[],
  seed = 0,
  strategy: FeedStrategy = 'balanced',
  scorer?: FeedScorer,
): AppSummary[] {
  if (apps.length === 0) return [];
  const active = scorer ?? feedScorers[strategy] ?? feedScorers.balanced;
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  return apps
    .map((app) => ({ app, score: active(app, hashSeeded01(app.id, safeSeed)) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.app.id < b.app.id ? -1 : a.app.id > b.app.id ? 1 : 0;
    })
    .map((x) => x.app);
}

/** 本地分页切片：与后端 `get_home_feed(limit, offset)` 语义对齐（offset 起 limit 个）。 */
export function sliceFeed<T>(ranked: T[], offset: number, limit: number): T[] {
  const start = Math.max(0, Math.floor(offset) || 0);
  const len = Math.max(0, Math.floor(limit) || 0);
  return ranked.slice(start, start + len);
}
