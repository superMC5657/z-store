import type { AppSummary } from '../../types';
import { summaries } from '../fixtures';

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
 * 仅保留供 demo 旧调用；新代码请用 `hashSeeded01`。Phase2 最小对齐：只换哈希实现，
 * 不改调用方与打分形状（balanced 半幅 0.15 等），不扩大 blast radius。
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
  // canonical balanced：log1p(stars) + (jitter01-0.5)*0.3（半幅 0.15，与 feed.ts / 后端 feed_score 同形同量级）。
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const normalized = String(strategy ?? 'balanced').trim().toLowerCase();
  const active = normalized === 'stars' ? 'stars' : normalized === 'fresh' ? 'fresh' : 'balanced';
  return summaries
    .map((s, index) => {
      const stars = Number.isFinite(s.stars) && s.stars > 0 ? s.stars : 0;
      const base = Math.log1p(stars);
      const jitter = demoSeeded01(s.id, safeSeed);
      const score =
        active === 'stars' ? base : active === 'fresh' ? jitter * 10 + base * 0.05 : base + (jitter - 0.5) * 0.3;
      return { s, index, score };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((x) => x.s);
}
