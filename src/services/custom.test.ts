/**
 * `services/custom.ts` 接口级测试：
 * - 线格式 ↔ 领域转换（`entryFromWire` / `itemToWire` / `itemToSummary` / `entryToCollectedSummary`）
 * - 本地收录态判定与 remote 图标真值提取（`isCollectedStatus` / `resolveRemoteIconUrl`）
 * - 摘要合成草稿 + forge 门禁（`draftForgeGateError` / `buildCustomDraftItemFromSummary`）
 * - 移入收录唯一入口（`moveInToDraft`，仅在 `tauriApi` IPC seam 打桩）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '../types';
import { tauriApi } from './api';
import {
  buildCustomDraftItemFromSummary,
  draftForgeGateError,
  entryFromWire,
  entryToCollectedSummary,
  isCollectedStatus,
  itemToSummary,
  itemToWire,
  moveInToDraft,
  resolveRemoteIconUrl,
  type DraftEntryWire,
  type DraftItem,
  type DraftItemWire,
} from './custom';

function wireItem(extra: Partial<DraftItemWire> = {}): DraftItemWire {
  return {
    id: 'acme/atlas',
    name: 'Atlas',
    owner: 'acme',
    repo: 'atlas',
    icon: '',
    icon_bg: '',
    description: 'tool',
    description_en: null,
    category: 'dev',
    category_name: '开发工具',
    aliases: [],
    default_version: 'v0.1.0',
    license: 'MIT',
    stars: 42,
    forks: 7,
    is_verified: false,
    homepage: null,
    install_dirs: [],
    search_subdirs: [],
    publishers: [],
    platforms: ['windows'],
    identifiers: {},
    ...extra,
  };
}

function wireEntry(extra: Partial<DraftEntryWire> = {}): DraftEntryWire {
  return {
    id: 'acme/atlas',
    item: wireItem(),
    status: 'collected',
    pr_url: null,
    created_at: 1,
    updated_at: 2,
    archived: false,
    ...extra,
  };
}

function draftItem(extra: Partial<DraftItem> = {}): DraftItem {
  return { ...entryFromWire(wireEntry()).item, ...extra };
}

function onlineApp(extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'acme/atlas',
    name: 'Atlas',
    owner: 'acme',
    repo: 'atlas',
    icon: '',
    icon_bg: '',
    description: 'Atlas tool',
    stars: 5,
    forks: 1,
    license: 'OpenSource',
    latest_version: 'latest',
    category: 'external',
    category_name: '跨平台开源',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...extra,
  } as AppSummary;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('草稿 mappers 与状态判定', () => {
  it('isCollectedStatus 与 resolveRemoteIconUrl 语义守恒', () => {
    expect(isCollectedStatus('collected')).toBe(true);
    expect(isCollectedStatus('local_collected')).toBe(true);
    expect(isCollectedStatus('submitted')).toBe(false);
    expect(isCollectedStatus('draft')).toBe(false);
    expect(resolveRemoteIconUrl({ remote_url: ' https://example.com/a.png ' })).toBe(
      'https://example.com/a.png',
    );
    expect(resolveRemoteIconUrl({ remote_url: 'data:image/png;base64,AAA' })).toBe('');
    expect(resolveRemoteIconUrl(null)).toBe('');
  });

  it('entryFromWire：null 归一空串、local_collected 归一 collected、缺省 updated_at 保留', () => {
    const entry = entryFromWire(wireEntry({ status: 'local_collected' }));
    expect(entry.status).toBe('collected');
    expect(entry.item.description_en).toBe('');
    expect(entry.item.homepage).toBe('');
    expect(entry.item.stars).toBe(42);
    expect(entry.pr_url).toBeNull();
    expect(entry.updated_at).toBe(2);
    expect(entryFromWire(wireEntry({ status: 'submitted' })).status).toBe('submitted');
    expect(entryFromWire(wireEntry({ status: 'draft' })).status).toBe('draft');
    expect(entryFromWire(wireEntry({ status: 'weird' })).status).toBe('draft');
  });

  it('itemToWire：空串归 null、is_verified 恒 false、stars/forks 沿用已有行', () => {
    const wire = itemToWire(
      draftItem({ description_en: '', homepage: '', stars: 3, forks: 1 }),
      { stars: 99, forks: 8 },
    );
    expect(wire.description_en).toBeNull();
    expect(wire.homepage).toBeNull();
    expect(wire.is_verified).toBe(false);
    expect(wire.stars).toBe(99);
    expect(wire.forks).toBe(8);
    expect(itemToWire(draftItem({ stars: 3, forks: 1 })).stars).toBe(3);
  });

  it('往返：领域 → 线格式 → 领域保持业务字段不变', () => {
    const item = draftItem({ description_en: 'tool en', homepage: 'https://example.com' });
    const roundTrip = entryFromWire(wireEntry({ item: itemToWire(item) })).item;
    expect(roundTrip).toEqual(item);
  });

  it('itemToSummary：本地收录黄标字段（source=local + 显式 status）与统一归一化', () => {
    const item = draftItem({ name: '', icon_bg: '', description_en: '' });
    const summary = itemToSummary(item, 'collected');
    expect(summary.id).toBe('acme/atlas');
    expect(summary.name).toBe('acme/atlas');
    expect(summary.icon_bg).toBe('linear-gradient(135deg, #475569, #334155)');
    expect(summary.description_en).toBeUndefined();
    expect(summary.source).toBe('local');
    expect(summary.status).toBe('collected');
    expect(summary.is_verified).toBe(false);
    expect(summary.stars).toBe(42);
    expect(summary.homepage).toBeNull();
    expect(summary.platforms).toEqual(['windows']);
    expect('archived' in summary).toBe(false);
  });

  it('itemToSummary：草稿不是收录（无 source），collected 系与后链路才带黄标来源', () => {
    const item = draftItem();
    const draft = itemToSummary(item, 'draft');
    expect(draft.source).toBeUndefined();
    expect('source' in draft).toBe(false);
    expect(draft.status).toBe('draft');
    expect(itemToSummary(item, 'local_collected').source).toBe('local');
    expect(itemToSummary(item, 'collected').source).toBe('local');
    expect(itemToSummary(item, 'submitted').source).toBe('local');
    expect(itemToSummary(item, 'collected', true).source).toBe('local');
    expect(itemToSummary(item, 'draft', true).source).toBe('local');
  });

  it('itemToSummary：stars/forks 非有限数回退 0，platforms 复制而非共享引用', () => {
    const item = draftItem({ stars: undefined, forks: undefined });
    const summary = itemToSummary(item, 'draft');
    expect(summary.stars).toBe(0);
    expect(summary.forks).toBe(0);
    expect(summary.platforms).not.toBe(item.platforms);
  });

  it('entryToCollectedSummary：与待收录路径共用归一化，并透传 status/archived', () => {
    const item = draftItem({ name: '', icon_bg: '', description_en: '' });
    const entry = { ...entryFromWire(wireEntry({ archived: true })), item };
    const summary = entryToCollectedSummary(entry);
    const pending = itemToSummary(item, entry.status);

    expect({ ...summary, archived: undefined }).toEqual({ ...pending, archived: undefined });
    expect(summary.name).toBe('acme/atlas');
    expect(summary.icon_bg).toBe(pending.icon_bg);
    expect(summary.description_en).toBeUndefined();
    expect(summary.source).toBe('local');
    expect(summary.status).toBe('collected');
    expect(summary.archived).toBe(true);
    expect(summary.is_verified).toBe(false);
    expect(summary.latest_version).toBe('v0.1.0');
    expect(summary.platforms).not.toBe(item.platforms);
  });
});

describe('移入收录预填图标与 forge 门', () => {
  const summaryWithIcon = (icon: unknown): AppSummary =>
    onlineApp({ icon: icon as string, license: 'MIT', category: 'dev', category_name: '开发工具', is_verified: true });

  it('仅保留 http(s) 远程图标真值，base64/空/相对路径置空', () => {
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('http://example.com/icon.png')).icon).toBe('http://example.com/icon.png');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('  https://example.com/icon.png  ')).icon).toBe('https://example.com/icon.png');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('   ')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('/icons/atlas.png')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('icons/atlas.png')).icon).toBe('');
  });

  it('iconRemote 远程真值优先于摘要图标，且不接受 data:', () => {
    expect(
      buildCustomDraftItemFromSummary(
        summaryWithIcon('data:image/png;base64,AAA'),
        'https://example.com/remote.png',
      ).icon,
    ).toBe('https://example.com/remote.png');
    expect(
      buildCustomDraftItemFromSummary(
        summaryWithIcon('http://example.com/stale.png'),
        'https://example.com/remote.png',
      ).icon,
    ).toBe('https://example.com/remote.png');
    expect(
      buildCustomDraftItemFromSummary(
        summaryWithIcon('https://example.com/app.png'),
        'data:image/png;base64,AAA',
      ).icon,
    ).toBe('https://example.com/app.png');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA'), null).icon).toBe('');
  });

  it('forge 门：GitHub 放行，非 GitHub / 未知前缀 / forge 形态 id 拒绝', () => {
    expect(draftForgeGateError(summaryWithIcon(''))).toBeNull();
    const cb = { ...summaryWithIcon(''), id: 'codeberg:acme/atlas', forge: 'codeberg' };
    expect(draftForgeGateError(cb)).toContain('codeberg');
    expect(() => buildCustomDraftItemFromSummary(cb as AppSummary)).toThrow(/codeberg/);

    const unknown = { ...summaryWithIcon(''), id: 'xyz:acme/atlas' };
    expect(draftForgeGateError(unknown)).toContain('无法识别的应用标识');
    expect(() => buildCustomDraftItemFromSummary(unknown as AppSummary)).toThrow(/无法识别/);

    expect(draftForgeGateError({ ...summaryWithIcon(''), id: 'gh:acme/atlas' })).toContain(
      'forge 形态 id 暂不收录',
    );
  });
});

describe('moveInToDraft（移入收录唯一入口）', () => {
  it('remote 图标真值优先，落库后广播变更事件', async () => {
    const cycleSpy = vi
      .spyOn(tauriApi, 'restoreOrFetchIconCycle')
      .mockResolvedValue({ remote_url: 'https://example.com/atlas.png' } as never);
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({} as never);
    const events: string[] = [];
    const onChanged = (e: Event) => events.push((e as CustomEvent).detail?.id);
    window.addEventListener('zstore:custom-apps-changed', onChanged);

    const res = await moveInToDraft(onlineApp());

    expect(res.ok).toBe(true);
    expect(res.id).toBe('acme/atlas');
    expect(cycleSpy).toHaveBeenCalledWith('acme/atlas');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = saveSpy.mock.calls[0]?.[0];
    expect(payload?.id).toBe('acme/atlas');
    expect(payload?.is_verified).toBe(false);
    expect(payload?.icon).toBe('https://example.com/atlas.png');
    expect(events).toEqual(['acme/atlas']);

    window.removeEventListener('zstore:custom-apps-changed', onChanged);
  });

  it('探测失败回退摘要图标归一，落库失败不广播且返回原因', async () => {
    vi.spyOn(tauriApi, 'restoreOrFetchIconCycle').mockRejectedValue(new Error('ipc down'));
    const saveSpy = vi
      .spyOn(tauriApi, 'saveCustomApp')
      .mockRejectedValue(new Error('db locked'));
    const events: string[] = [];
    const onChanged = (e: Event) => events.push((e as CustomEvent).detail?.id);
    window.addEventListener('zstore:custom-apps-changed', onChanged);

    const res = await moveInToDraft(
      onlineApp({ id: 'acme/Beacon', owner: 'acme', repo: 'Beacon', icon: 'data:image/png;base64,AA' }),
    );

    expect(res.ok).toBe(false);
    expect(res.id).toBe('acme/beacon');
    expect(res.error).toContain('db locked');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]?.[0]?.icon).toBe('');
    expect(events).toEqual([]);

    window.removeEventListener('zstore:custom-apps-changed', onChanged);
  });

  it('forge 门：非 GitHub 摘要入口即拒，不探测不落库不广播', async () => {
    const cycleSpy = vi.spyOn(tauriApi, 'restoreOrFetchIconCycle');
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp');

    const res = await moveInToDraft(
      onlineApp({ id: 'codeberg:acme/atlas', forge: 'codeberg', forge_host: 'codeberg.org' }),
    );

    expect(res.ok).toBe(false);
    expect(res.id).toBe('codeberg:acme/atlas');
    expect(res.error).toContain('codeberg');
    expect(cycleSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('当协议为占位符时拉取详情解析真实开源协议及平台元数据', async () => {
    vi.spyOn(tauriApi, 'restoreOrFetchIconCycle').mockResolvedValue({
      remote_url: 'https://example.com/icon.png',
    } as never);
    const detailSpy = vi.spyOn(tauriApi, 'getAppDetails').mockResolvedValue({
      id: 'yetone/magpie',
      name: 'magpie',
      owner: 'yetone',
      repo: 'magpie',
      license: 'MIT',
      homepage: 'https://usemagpie.ai',
      platforms: ['darwin-arm64'],
      latest_version: 'v1.0.0',
    } as never);
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({} as never);

    const res = await moveInToDraft(
      onlineApp({
        id: 'yetone/magpie',
        name: 'magpie',
        owner: 'yetone',
        repo: 'magpie',
        license: 'OpenSource',
      }),
    );

    expect(res.ok).toBe(true);
    expect(detailSpy).toHaveBeenCalledWith('yetone/magpie');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = saveSpy.mock.calls[0]?.[0];
    expect(payload?.license).toBe('MIT');
    expect(payload?.homepage).toBe('https://usemagpie.ai');
    expect(payload?.platforms).toEqual(['darwin-arm64']);
    expect(payload?.default_version).toBe('v1.0.0');
  });

  it('当协议已有真实 SPDX 时不触发详情查询', async () => {
    vi.spyOn(tauriApi, 'restoreOrFetchIconCycle').mockResolvedValue({ remote_url: '' } as never);
    const detailSpy = vi.spyOn(tauriApi, 'getAppDetails');
    const saveSpy = vi.spyOn(tauriApi, 'saveCustomApp').mockResolvedValue({} as never);

    const res = await moveInToDraft(
      onlineApp({
        id: 'yetone/magpie',
        name: 'magpie',
        owner: 'yetone',
        repo: 'magpie',
        license: 'Apache-2.0',
      }),
    );

    expect(res.ok).toBe(true);
    expect(detailSpy).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]?.[0]?.license).toBe('Apache-2.0');
  });
});
