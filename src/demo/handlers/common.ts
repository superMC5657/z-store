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

export function rankSummariesForFeed(seed: number, strategy?: unknown): AppSummary[] {
  // 打分/排序经 `services/feed.ts rankFeed` 唯一口（后端 `rank_feed` 为准；
  // demo/搜索本地路径保持确定性：同 seed 同序，tie 按 id 升序）。
  const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const normalized = String(strategy ?? 'balanced').trim().toLowerCase();
  const active: FeedStrategy =
    normalized === 'stars' ? 'stars' : normalized === 'fresh' ? 'fresh' : 'balanced';
  return rankFeed(summaries, safeSeed, active);
}
