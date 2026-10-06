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
 * demo 侧确定性抖动（canonical 见 src/services/feed.ts：与 `hashSeeded01/balanced` 同形、
 * 同量级、同 seed 语义；允许 FNV 位宽实现不同。mock 层不做运行时 import，
 * 避免拉起 api.ts 破坏 install 时序，故此处解耦实现）。
 */
export function demoSeeded01(id: string, seed: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0;
  let h = (0x811c9dc5 ^ safeSeed) >>> 0;
  const s = String(id).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
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
