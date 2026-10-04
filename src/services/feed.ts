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

/** FNV-1a + seed 混合：同一 (id, seed) 必得同一抖动，换 seed 即换一批。 */
export function hashSeeded01(id: string, seed: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0;
  let h = (0x811c9dc5 ^ safeSeed) >>> 0;
  const s = String(id).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 雪崩收尾，打散低位聚集
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
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
 * - 同分时保持入参相对顺序（稳定排序），空数组返回空数组。
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
    .map((app, index) => ({ app, index, score: active(app, hashSeeded01(app.id, safeSeed)) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((x) => x.app);
}

/** 本地分页切片：与后端 `get_home_feed(limit, offset)` 语义对齐（offset 起 limit 个）。 */
export function sliceFeed<T>(ranked: T[], offset: number, limit: number): T[] {
  const start = Math.max(0, Math.floor(offset) || 0);
  const len = Math.max(0, Math.floor(limit) || 0);
  return ranked.slice(start, start + len);
}
