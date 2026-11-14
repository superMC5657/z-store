import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../../types';
import { tauriApi } from '../api';
import {
  STARRED_L2_MAX_PERSISTED_ROWS,
  STARRED_L2_TTL_MS,
  STARRED_OPTS_STORAGE_KEY,
  buildStarredEnvelopeJson,
  loadPersistedStarredOpts,
  persistStarredOpts,
  readDbStarredCache,
  saveDbStarredCache,
} from './starredCache';

function row(id: string, patch: Partial<AppSummary> = {}): AppSummary {
  const [owner, repo] = id.split('/');
  return {
    id,
    name: repo ?? id,
    description_en: undefined,
    owner: owner ?? '',
    repo: repo ?? '',
    icon: 'https://cdn.example/i.png',
    icon_bg: '',
    description: 'desc',
    stars: 0,
    forks: 0,
    license: 'MIT',
    latest_version: 'v1',
    category: 'external',
    category_name: '',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...patch,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildStarredEnvelopeJson', () => {
  it('strips data: icons and catalog annotations', () => {
    const json = buildStarredEnvelopeJson({
      v: 1,
      rows: [row('a/b', { icon: 'data:image/png;base64,AA', is_cataloged: true, source: 'remote', status: 'collected' })],
      pages: 1,
      hasMore: false,
      confirmedOther: ['a/b', 'gone/repo'],
    });
    const env = JSON.parse(json!);
    expect(env.rows[0].icon).toBe('');
    expect(env.rows[0].is_cataloged).toBeUndefined();
    expect(env.rows[0].source).toBeUndefined();
    expect(env.rows[0].status).toBeUndefined();
    // 只保留仍在快照里的确认 Other。
    expect(env.confirmedOther).toEqual(['a/b']);
  });

  it('caps at 3 pages / 60 rows and marks more pages available', () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(`o/r${i}`));
    const env = JSON.parse(buildStarredEnvelopeJson({ v: 1, rows, pages: 4, hasMore: false })!);
    expect(env.rows).toHaveLength(STARRED_L2_MAX_PERSISTED_ROWS);
    expect(env.pages).toBe(3);
    expect(env.hasMore).toBe(true);
  });

  it('truncates long text, then falls back to the first page, then gives up', () => {
    const long = 'x'.repeat(6000);
    const rows = Array.from({ length: 60 }, (_, i) => row(`o/r${i}`, { description: long }));
    const env = JSON.parse(buildStarredEnvelopeJson({ v: 1, rows, pages: 3, hasMore: false })!);
    expect(env.rows).toHaveLength(60);
    expect(env.rows[0].description).toHaveLength(500);

    const heavy = Array.from({ length: 60 }, (_, i) => row(`o/r${i}`, { name: 'n'.repeat(6000) }));
    const firstPage = JSON.parse(buildStarredEnvelopeJson({ v: 1, rows: heavy, pages: 3, hasMore: false })!);
    expect(firstPage.rows).toHaveLength(20);
    expect(firstPage.pages).toBe(1);
    expect(firstPage.hasMore).toBe(true);

    const huge = [row('o/r', { name: 'n'.repeat(300 * 1024) })];
    expect(buildStarredEnvelopeJson({ v: 1, rows: huge, pages: 1, hasMore: false })).toBeUndefined();
    expect(buildStarredEnvelopeJson({ v: 1, rows: [], pages: 1, hasMore: false })).toBeUndefined();
  });
});

describe('readDbStarredCache', () => {
  const now = 1_800_000_000_000;
  const payload = JSON.stringify({ v: 1, rows: [row('a/b')], pages: 1, hasMore: false });

  it('reports 12h freshness and honors allowStale', async () => {
    const spy = vi.spyOn(tauriApi, 'getStarredFeedCache');
    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now - 1000) / 1000) });
    expect((await readDbStarredCache('k', { now }))?.isFresh).toBe(true);

    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now - STARRED_L2_TTL_MS - 1000) / 1000) });
    expect(await readDbStarredCache('k', { now })).toBeUndefined();
    const stale = await readDbStarredCache('k', { now, allowStale: true });
    expect(stale?.isFresh).toBe(false);
    expect(stale?.envelope.rows).toHaveLength(1);
  });

  it('rejects clock skew, bad shapes and backend errors', async () => {
    const spy = vi.spyOn(tauriApi, 'getStarredFeedCache');
    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now + 60_000) / 1000) });
    expect(await readDbStarredCache('k', { now, allowStale: true })).toBeUndefined();
    spy.mockResolvedValue({ payload_json: '{"v":2,"rows":[]}', cached_at: Math.floor(now / 1000) });
    expect(await readDbStarredCache('k', { now, allowStale: true })).toBeUndefined();
    spy.mockRejectedValue(new Error('offline'));
    expect(await readDbStarredCache('k', { now, allowStale: true })).toBeUndefined();
    expect(await readDbStarredCache('  ', { now })).toBeUndefined();
  });
});

describe('saveDbStarredCache', () => {
  it('serializes writes per key and skips unsavable envelopes', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const spy = vi.spyOn(tauriApi, 'saveStarredFeedCache').mockImplementation(async (_k, _s, json) => {
      const tag = JSON.parse(json).rows[0].id as string;
      if (tag === 'first/x') await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push(tag);
    });
    const a = saveDbStarredCache('k', 'k', { v: 1, rows: [row('first/x')], pages: 1, hasMore: false });
    const b = saveDbStarredCache('k', 'k', { v: 1, rows: [row('second/x')], pages: 1, hasMore: false });
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    releaseFirst?.();
    await Promise.all([a, b]);
    expect(order).toEqual(['first/x', 'second/x']);

    await saveDbStarredCache('k', 'k', { v: 1, rows: [], pages: 1, hasMore: false });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('starred opts', () => {
  it('round-trips mode and public username only', () => {
    expect(loadPersistedStarredOpts()).toBeNull();
    persistStarredOpts({ mode: 'user', username: 'Torvalds' });
    expect(loadPersistedStarredOpts()).toEqual({ mode: 'user', username: 'Torvalds' });
    persistStarredOpts({ mode: 'self' });
    expect(loadPersistedStarredOpts()).toEqual({ mode: 'self' });
    window.localStorage.setItem(STARRED_OPTS_STORAGE_KEY, '{broken');
    expect(loadPersistedStarredOpts()).toBeNull();
  });
});
