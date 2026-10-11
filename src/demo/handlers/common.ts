import type { AppSummary } from '../../types';
import { summaries } from '../fixtures';
import { rankFeed, type FeedStrategy } from '../../services/feed';

export type InvokeArgs = Record<string, unknown>;

export function asRecord(args: unknown): InvokeArgs {
  if (args && typeof args === 'object' && !Array.isArray(args) && !(args instanceof ArrayBuffer)) {
    return args as InvokeArgs;
  }
  return {};
}

export function argStr(a: InvokeArgs, ...keys: string[]): string {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

export function argNum(a: InvokeArgs, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * @deprecated 32 位 mock 抖动已对齐 64 位 canonical（见 `src/services/feed.ts#hashSeeded01`），
 * 仅保留供单测锁定哈希一致性；打分/排序已收敛至 `rankFeed` 唯一口，新代码请用 `hashSeeded01`/`rankFeed`。
 * 与 canonical 同形：FNV-1a 64 + seed 起步 + UTF-8 字节迭代 + `>>33` 雪崩，除数 2^64；
 * id 先 `toLowerCase`，与后端 `to_lowercase + as_bytes` 对齐。此处解耦实现，不 import feed.ts。
 */
export function demoSeeded01(id: string, seed: number): number {
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
  h ^= h >> 33n;
  h = (h * AVALANCHE_MUL) & MASK64;
  h ^= h >> 33n;
  return Number(h) / DIV_2P64;
}

export function rankSummariesForFeed(seed: number, strategy?: unknown): AppSummary[] {
  // 收敛一处：打分/排序经 `services/feed.ts rankFeed` 唯一口（后端 `rank_feed` 为准；
  // demo/搜索本地路径保持确定性：同 seed 同序，tie 按 id 升序）。
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const normalized = String(strategy ?? 'balanced').trim().toLowerCase();
  const active: FeedStrategy =
    normalized === 'stars' ? 'stars' : normalized === 'fresh' ? 'fresh' : 'balanced';
  return rankFeed(summaries, safeSeed, active);
}
