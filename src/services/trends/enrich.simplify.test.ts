/**
 * enrich 缓存与合并契约：
 * - isEnrichCacheFresh：force→缺席→平台→确认→TTL 分支；
 * - enrichTrendReposFresh：与 forceRefresh:true 等价；
 * - mergeEnrichPrev：空/占位回退；
 * - stripDataUriIcon：data: 单口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrendConfirmedOtherCache,
  clearTrendEnrichCache,
  enrichTrendRepos,
  enrichTrendReposFresh,
  isEnrichCacheFresh,
  markTrendConfirmedOther,
  mergeEnrichPrev,
  putTrendEnrichMemory,
  snapshotTrendEnrichCache,
  stripDataUriIcon,
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

describe('isEnrichCacheFresh 分支', () => {
  it('force 直接不新鲜', () => {
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    expect(isEnrichCacheFresh('acme/atlas', Date.now(), true)).toBe(false);
  });

  it('缺席不新鲜', () => {
    expect(isEnrichCacheFresh('acme/ghost', Date.now(), false)).toBe(false);
  });

  it('具平台新鲜命中', () => {
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'] }),
    });
    expect(isEnrichCacheFresh('acme/atlas', Date.now(), false)).toBe(true);
  });

  it('具平台 stale 不新鲜但保留旧值供图标合并', async () => {
    const t0 = Date.now();
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: ['windows'],
        icon: 'https://x/old.png',
        description: 'old',
      }),
    });
    const staleNow = t0 + 13 * HOUR_MS;
    expect(isEnrichCacheFresh('acme/atlas', staleNow, false)).toBe(false);
    // 保留：stale 后重拉空图标仍粘性合并出旧图标。
    vi.spyOn(Date, 'now').mockReturnValue(staleNow);
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => ({
        ...makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] }),
        icon: '',
        description: 'new',
      })),
    );
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(out.get('acme/atlas')?.description).toBe('new');
    expect(out.get('acme/atlas')?.icon).toBe('https://x/old.png');
  });

  it('时钟倒退按过期驱逐（空回填不粘旧）', async () => {
    const t0 = Date.now();
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: ['windows'],
        icon: 'https://x/old.png',
      }),
    });
    // elapsed<0：驱逐后重拉，旧图标已删，空回填保持空。
    expect(isEnrichCacheFresh('acme/atlas', t0 - 1000, false)).toBe(false);
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => ({
        ...makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] }),
        icon: '',
      })),
    );
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(out.get('acme/atlas')?.icon).toBe('');
  });

  it('未确认 loading 不新鲜并驱逐', () => {
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    clearTrendConfirmedOtherCache();
    expect(isEnrichCacheFresh('acme/atlas', Date.now(), false)).toBe(false);
    // 已驱逐：快照无条目。
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
  });

  it('已确认 loading 新鲜命中', () => {
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    expect(isEnrichCacheFresh('acme/atlas', Date.now(), false)).toBe(true);
  });

  it('已确认 loading stale 到期重拉', () => {
    const t0 = Date.now();
    markTrendConfirmedOther('acme/atlas');
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: [] }),
    });
    expect(isEnrichCacheFresh('acme/atlas', t0 + 13 * HOUR_MS, false)).toBe(false);
  });
});

describe('enrichTrendReposFresh 等价', () => {
  it('与 forceRefresh:true 同语义（跳缓存直取并透传 force）', async () => {
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        platforms: ['windows'],
        description: 'old',
      }),
    });
    const backend = vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs, force) =>
      rs.map((r) => ({
        ...makeEnrichedApp({ id: `${r.owner}/${r.repo}`, platforms: ['windows'] }),
        description: `fresh-force-${String(force)}`,
      })),
    );
    const repos = [makeTrendRepo({ id: 'acme/atlas' })];
    const viaWrapper = await enrichTrendReposFresh(repos);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend.mock.calls[0]?.[1]).toBe(true);
    expect(viaWrapper.get('acme/atlas')?.description).toBe('fresh-force-true');

    backend.mockClear();
    const viaFlag = await enrichTrendRepos(repos, { forceRefresh: true });
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend.mock.calls[0]?.[1]).toBe(true);
    expect(viaFlag.get('acme/atlas')?.description).toBe('fresh-force-true');
  });

  it('默认路径命中缓存不重拉', async () => {
    putTrendEnrichMemory({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', platforms: ['windows'], description: 'old' }),
    });
    const spy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockImplementation(async (rs) => rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}` })));
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(out.get('acme/atlas')?.description).toBe('old');
  });
});

describe('mergeEnrichPrev 回退', () => {
  function prevApp() {
    return makeEnrichedApp({
      id: 'acme/atlas',
      name: 'atlas-real',
      description: 'real desc',
      description_en: 'real en',
      license: 'MIT',
      latest_version: 'v1.0.0',
      category: 'tool',
      category_name: '工具',
      forge: 'github',
      forge_host: 'github.com',
      owner: 'acme',
      repo: 'atlas',
      homepage: 'https://atlas.example',
      platforms: ['windows'],
      icon: 'https://x/real.png',
    });
  }

  it('空名/占位名保留旧', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), name: '' }).name).toBe('atlas-real');
    expect(mergeEnrichPrev(prev, { ...prevApp(), name: '加载中...' }).name).toBe('atlas-real');
  });

  it('空简介/占位简介保留旧', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), description: '' }).description).toBe('real desc');
    expect(
      mergeEnrichPrev(prev, { ...prevApp(), description: 'GitHub 社区开源项目' }).description,
    ).toBe('real desc');
    expect(
      mergeEnrichPrev(prev, { ...prevApp(), description_en: '开源软件项目' }).description_en,
    ).toBe('real en');
  });

  it('license 空与 OpenSource 非 github 保留旧', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), license: '' }).license).toBe('MIT');
    expect(
      mergeEnrichPrev(prev, { ...prevApp(), license: 'OpenSource', forge: 'gitee' }).license,
    ).toBe('MIT');
    // github 下 OpenSource 视为实值透出。
    expect(
      mergeEnrichPrev(prev, { ...prevApp(), license: 'OpenSource', forge: 'github' }).license,
    ).toBe('OpenSource');
  });

  it('latest_version 空/占位保留旧', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), latest_version: '' }).latest_version).toBe('v1.0.0');
    expect(mergeEnrichPrev(prev, { ...prevApp(), latest_version: 'latest' }).latest_version).toBe(
      'v1.0.0',
    );
  });

  it('category 空/占位保留旧，homepage 空保留旧，平台空不覆盖实', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), category: '' }).category).toBe('tool');
    expect(mergeEnrichPrev(prev, { ...prevApp(), category: 'external' }).category).toBe('tool');
    expect(mergeEnrichPrev(prev, { ...prevApp(), homepage: null }).homepage).toBe(
      'https://atlas.example',
    );
    expect(mergeEnrichPrev(prev, { ...prevApp(), platforms: [] }).platforms).toEqual(['windows']);
  });

  it('icon 空/data: 保留旧实，舊亦空则落空', () => {
    const prev = prevApp();
    expect(mergeEnrichPrev(prev, { ...prevApp(), icon: '' }).icon).toBe('https://x/real.png');
    expect(mergeEnrichPrev(prev, { ...prevApp(), icon: 'data:image/png;base64,xx' }).icon).toBe(
      'https://x/real.png',
    );
    const emptyPrev = { ...prev, icon: '' };
    expect(mergeEnrichPrev(emptyPrev, { ...prevApp(), icon: '' }).icon).toBe('');
  });

  it('无 prev 原样返回', () => {
    const next = prevApp();
    expect(mergeEnrichPrev(undefined, next)).toBe(next);
  });
});

describe('stripDataUriIcon 单口', () => {
  it('data: 原样透出（调用方跳过入库）', () => {
    const next = makeEnrichedApp({ id: 'acme/atlas', icon: 'data:image/png;base64,xx' });
    const prev = makeEnrichedApp({ id: 'acme/atlas', icon: 'https://x/real.png' });
    expect(stripDataUriIcon(prev, next)).toBe(next);
    expect(stripDataUriIcon(prev, next).icon.startsWith('data:')).toBe(true);
  });

  it('空回填粘旧实，非空透出新值', () => {
    const prev = makeEnrichedApp({ id: 'acme/atlas', icon: 'https://x/real.png' });
    expect(
      stripDataUriIcon(prev, makeEnrichedApp({ id: 'acme/atlas', icon: '' })).icon,
    ).toBe('https://x/real.png');
    expect(
      stripDataUriIcon(prev, makeEnrichedApp({ id: 'acme/atlas', icon: 'https://x/new.png' })).icon,
    ).toBe('https://x/new.png');
  });

  it('批量 data: 只活当次 out 永不进内存', async () => {
    vi.spyOn(tauriApi, 'enrichTrendRepos').mockImplementation(async (rs) =>
      rs.map((r) => makeEnrichedApp({ id: `${r.owner}/${r.repo}`, icon: 'data:image/png;base64,xx' })),
    );
    const out = await enrichTrendRepos([makeTrendRepo({ id: 'acme/atlas' })]);
    expect(out.get('acme/atlas')?.icon.startsWith('data:')).toBe(true);
    expect(snapshotTrendEnrichCache()).not.toHaveProperty('acme/atlas');
  });
});
