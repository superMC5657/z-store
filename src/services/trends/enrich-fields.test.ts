/**
 * step-b 回归：enrich per-field 新鲜度 + 运行时派生 confirmedOther。
 * - per-field TTL：stale summary 重拉，fresh icon 粘性保留；
 * - 派生 Other：empty-fresh→Other，concrete→evicted，stale→重验；
 * - 兼容：无内存条目时 legacy 标记仍有效（L2 confirmedOther 输入）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  enrichTrendRepos,
  hydrateTrendConfirmedOtherCache,
  hydrateTrendEnrichCache,
  isTrendConfirmedOtherFresh,
  markTrendConfirmedOther,
  snapshotTrendConfirmedOthers,
  snapshotTrendEnrichCache,
} from './enrich';
import { tauriApi } from '../api';
import { makeEnrichedApp, makeTrendRepo } from '../../views/test-utils/trendFixture';

const HOUR_MS = 3600 * 1000;

beforeEach(() => {
  clearTrendEnrichCache();
  clearTrendConfirmedOtherCache();
  vi.restoreAllMocks();
});
afterEach(() => {
  clearTrendEnrichCache();
  clearTrendConfirmedOtherCache();
  vi.restoreAllMocks();
});

describe('per-field TTL：icon sticky / summary 12h', () => {
  it('新鲜命中不重拉', async () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [], description: 'old' }),
    });
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) => rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })));
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(out.get('acme/atlas')?.description).toBe('old');
  });

  it('stale summary 重拉，fresh icon 粘性保留（out 与内存一致）', async () => {
    const t0 = Date.now();
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: [],
        icon: 'https://x/icon.png',
        description: 'old desc',
      }),
    });
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 13 * HOUR_MS);
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) =>
        rs.map((r) => ({
          ...makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: [] }),
          icon: '',
          description: 'new desc',
        })),
      );
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.get('acme/atlas')?.description).toBe('new desc');
    expect(out.get('acme/atlas')?.icon).toBe('https://x/icon.png');
    expect(snapshotTrendEnrichCache()['acme/atlas']?.icon).toBe('https://x/icon.png');
  });
});

describe('运行时派生 confirmedOther', () => {
  it('empty-fresh→Other（无需单独标记）', () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    expect(snapshotTrendConfirmedOthers()).toContain('acme/atlas');
  });

  it('concrete→evicted（残留标记同步清除）', () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    markTrendConfirmedOther('acme/atlas');
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
  });

  it('stale 空平台→非 Other（到期重验，快照排除）', () => {
    const t0 = Date.now();
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 13 * HOUR_MS);
    expect(isTrendConfirmedOtherFresh('acme/atlas')).toBe(false);
    expect(snapshotTrendConfirmedOthers()).not.toContain('acme/atlas');
  });

  it('legacy 兼容：无内存条目时 L2 标记仍有效', () => {
    hydrateTrendConfirmedOtherCache(['acme/ghost']);
    expect(isTrendConfirmedOtherFresh('acme/ghost')).toBe(true);
    expect(snapshotTrendConfirmedOthers()).toContain('acme/ghost');
  });
});
