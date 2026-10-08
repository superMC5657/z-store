import type { AppSummary } from '../types';

/**
 * 发现页推荐 feed 纯函数模块。
 *
 * 约定（与 HomeView 调用方对齐）：
 * - `resolveHero` 只负责挑出置顶 1 个（rustdesk 优先，结果集内回退首个）；
 * - `rankFeed` 只对「去掉 hero 后的剩余数组」做排序，不在内部挑 hero；
 *   hero 不参与打散，由调用方（HomeView）拼回：`[hero, ...featured, ...feed]`。
 * - 算法可插拔：`feedScorers` 按策略导出打分器，`rankFeed` 支持第 4 个可选
 *   `scorer` 参数覆盖内置策略。
 */

export type FeedStrategy = 'balanced' | 'stars' | 'fresh';

/** 打分器签名：入参为应用与该应用在当前 seed 下的确定性抖动（[0, 1)），返回分数（越大越靠前）。 */
export type FeedScorer = (app: AppSummary, jitter01: number) => number;

/** balanced 策略的抖动半幅（总摆动 2 * HALF）。取 0.15 保证只有头部相近星数才会被打散，深部大差距不受影响。 */
export const FEED_JITTER_HALF = 0.15;

/**
 * 置顶解析：结果集内优先 `rustdesk/rustdesk`（ADR-0010 canonical id），
 * 缺席时回退为结果集首个，空集返回 undefined。绝不跳出传入数组找 hero。
 */
export function resolveHero(apps: AppSummary[]): AppSummary | undefined {
  if (apps.length === 0) return undefined;
  return apps.find((a) => a.id === 'rustdesk/rustdesk') ?? apps[0];
}

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
 * 内置三策略（可插拔：调用方可直接复用/替换此表，或经 `rankFeed` 第 4 参数覆盖）：
 * - balanced（默认）：stars 主序 + 轻扰动打散头部（±0.15），整体仍是星数 feed；
 * - stars：纯星数降序，seed 无影响，行为完全确定；
 * - fresh：seed 抖动主导 + 星数只给 5% 权重（目录暂无时间字段，用抖动近似“常看常新”，换 seed 即换一批）。
 */
export const feedScorers: Record<FeedStrategy, FeedScorer> = {
  stars: (app) => starsBase(app),
  balanced: (app, jitter01) => starsBase(app) + (jitter01 - 0.5) * FEED_JITTER_HALF * 2,
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
