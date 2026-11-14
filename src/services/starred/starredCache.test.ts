import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriApi } from '../api';
import {
  STARRED_L2_MAX_BYTES,
  STARRED_L2_MAX_PERSISTED_ROWS,
  STARRED_L2_TTL_MS,
  STARRED_OPTS_STORAGE_KEY,
  buildStarredEnvelopeJson,
  loadPersistedStarredOpts,
  persistStarredOpts,
  readDbStarredCache,
  saveDbStarredCache,
} from './starredCache';

function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}/repo-${i}`);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildStarredEnvelopeJson', () => {
  it('writes { v: 2, pages: [{ page, ids }], hasMore } with zero card fields', () => {
    const json = buildStarredEnvelopeJson({
      v: 2,
      pages: [
        { page: 2, ids: ['C/D'] },
        { page: 1, ids: ['A/B', 'a/b'] },
      ],
      hasMore: false,
    });
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual({
      v: 2,
      pages: [
        { page: 1, ids: ['a/b'] },
        { page: 2, ids: ['c/d'] },
      ],
      hasMore: false,
    });
    for (const field of ['description', 'icon', 'platforms', 'rows', 'confirmedOther']) {
      expect(json).not.toContain(field);
    }
  });

  it('caps at 3 pages / 60 ids and marks hasMore when truncated', () => {
    const byPages = JSON.parse(
      buildStarredEnvelopeJson({
        v: 2,
        pages: [1, 2, 3, 4].map((page) => ({ page, ids: ids(`p${page}`, 5) })),
        hasMore: false,
      })!,
    );
    expect(byPages.pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3]);
    expect(byPages.hasMore).toBe(true);

    const byRows = JSON.parse(
      buildStarredEnvelopeJson({
        v: 2,
        pages: [1, 2, 3].map((page) => ({ page, ids: ids(`p${page}`, 25) })),
        hasMore: false,
      })!,
    );
    const total = byRows.pages.reduce((n: number, p: { ids: string[] }) => n + p.ids.length, 0);
    expect(total).toBe(STARRED_L2_MAX_PERSISTED_ROWS);
    expect(byRows.hasMore).toBe(true);
  });

  it('keeps empty pages but rejects envelopes without any id', () => {
    const json = buildStarredEnvelopeJson({
      v: 2,
      pages: [
        { page: 1, ids: [] },
        { page: 2, ids: ['a/b'] },
      ],
      hasMore: true,
    });
    expect(JSON.parse(json!).pages).toEqual([
      { page: 1, ids: [] },
      { page: 2, ids: ['a/b'] },
    ]);
    expect(buildStarredEnvelopeJson({ v: 2, pages: [{ page: 1, ids: [] }], hasMore: false })).toBeUndefined();
    expect(STARRED_L2_MAX_BYTES).toBe(32 * 1024);
  });
});

describe('readDbStarredCache', () => {
  const now = 1_800_000_000_000;
  const payload = JSON.stringify({ v: 2, pages: [{ page: 1, ids: ['a/b'] }], hasMore: false });

  it('reports 12h freshness and honors allowStale', async () => {
    const spy = vi.spyOn(tauriApi, 'getStarredFeedCache');
    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now - 1000) / 1000) });
    expect((await readDbStarredCache('k', { now }))?.isFresh).toBe(true);

    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now - STARRED_L2_TTL_MS - 1000) / 1000) });
    expect(await readDbStarredCache('k', { now })).toBeUndefined();
    const stale = await readDbStarredCache('k', { now, allowStale: true });
    expect(stale?.isFresh).toBe(false);
    expect(stale?.envelope.pages).toEqual([{ page: 1, ids: ['a/b'] }]);
  });

  it('rejects legacy v1 envelopes, clock skew, empty indexes and backend errors', async () => {
    const spy = vi.spyOn(tauriApi, 'getStarredFeedCache');
    spy.mockResolvedValue({ payload_json: payload, cached_at: Math.floor((now + 60_000) / 1000) });
    expect(await readDbStarredCache('k', { now, allowStale: true })).toBeUndefined();
    spy.mockResolvedValue({
      payload_json: JSON.stringify({ v: 1, rows: [{ id: 'a/b' }], pages: 1, hasMore: false }),
      cached_at: Math.floor(now / 1000),
    });
    expect(await readDbStarredCache('k', { now, allowStale: true })).toBeUndefined();
    spy.mockResolvedValue({ payload_json: '{"v":2,"pages":[{"page":1,"ids":[]}]}', cached_at: Math.floor(now / 1000) });
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
      const tag = JSON.parse(json).pages[0].ids[0] as string;
      if (tag === 'first/x') await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push(tag);
    });
    const a = saveDbStarredCache('k', 'k', { v: 2, pages: [{ page: 1, ids: ['first/x'] }], hasMore: false });
    const b = saveDbStarredCache('k', 'k', { v: 2, pages: [{ page: 1, ids: ['second/x'] }], hasMore: false });
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    releaseFirst?.();
    await Promise.all([a, b]);
    expect(order).toEqual(['first/x', 'second/x']);

    await saveDbStarredCache('k', 'k', { v: 2, pages: [], hasMore: false });
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
