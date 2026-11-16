import type { AppSummary } from '../types';

/**
 * Feed 排序与画像变更订阅模块：
 * - `rankFeed` / `hashSeeded01` / `starsForksBase` 提供与后端 `catalog_feed_score` 同量级的确定性打分排序（供 Demo mock 复用）；
 * - `subscribeAffinityUpdated` 订阅后端 `zstore://affinity-updated` 与本地 `zstore:affinity-updated` 事件。
 */

export type FeedStrategy = 'balanced' | 'stars' | 'fresh';

/** 打分器签名：入参为应用与该应用在当前 seed 下的确定性抖动（[0, 1)），返回分数（越大越靠前）。 */
type FeedScorer = (app: AppSummary, jitter01: number) => number;

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
