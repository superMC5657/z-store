/**
 * 本地收录橘黄徽标全链路锁定（selectors 搬运 source/status）：
 * - 在线同 id 命中本地时补 source='local'，蓝标优先（is_verified true 不叠加）；
 * - 不改排序/去重语义，原引用透传（memo 友好）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  annotateEnrichMirrorCataloged,
  annotateIsCataloged,
  annotateLocalSource,
  annotateOnlineCataloged,
  buildCatalogIdSet,
  mergeLocalLookups,
  resolveBareRowLocalBadgeVariant,
  rowAliasKeys,
  selectMergedCatalogApps,
} from './selectors';
import { resolveVerifiedBadgeVariant } from '../components/VerifiedBadge';
import { AppCard } from '../components/AppCard';
import type { AppSummary } from '../types';

afterEach(() => cleanup());

function app(id: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    name: id,
    owner: id.split('/')[0] ?? 'o',
    repo: id.split('/')[1] ?? 'r',
    icon: '',
    icon_bg: '',
    description: 'd',
    stars: 0,
    forks: 0,
    license: 'MIT',
    latest_version: 'v1',
    category: 'dev',
    category_name: 'dev',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    ...extra,
  } as AppSummary;
}

describe('本地橘黄 selectors 搬运', () => {
  it('annotateIsCataloged：命中本地且未验证即叠加 local（蓝优先不动）', () => {
    const catalogIds = buildCatalogIdSet([app('o/remote')]);
    const local = [{ ...app('o/local'), source: 'local', status: 'collected' } as AppSummary];
    const row = app('o/local');
    const out = annotateIsCataloged(row, catalogIds, local);
    expect(out.is_cataloged).toBe(true);
    expect((out as { source?: unknown }).source).toBe('local');
    expect((out as { status?: unknown }).status).toBe('collected');
    expect(resolveVerifiedBadgeVariant(out as never)).toBe('local');
    // 原对象不改写
    expect((row as { source?: unknown }).source).toBeUndefined();
  });

  it('蓝标优先：自身已验证不叠加本地', () => {
    const catalogIds = buildCatalogIdSet([app('o/remote')]);
    const local = [{ ...app('o/a'), source: 'local', status: 'collected' } as AppSummary];
    const row = app('o/a', { is_verified: true });
    const out = annotateIsCataloged(row, catalogIds, local);
    expect((out as { source?: unknown }).source).toBeUndefined();
    expect(resolveVerifiedBadgeVariant(out as never)).toBe('verified');
  });

  it('custom 草稿行不被本地覆盖', () => {
    const catalogIds = new Set<string>();
    const local = [{ ...app('o/a'), source: 'local', status: 'collected' } as AppSummary];
    const row = { ...app('o/a'), source: 'custom' } as AppSummary;
    const out = annotateIsCataloged(row, catalogIds, local);
    expect((out as { source?: unknown }).source).toBe('custom');
  });

  it('annotateOnlineCataloged：目录数组自带本地行即 inferred 叠加', () => {
    const remote = [app('o/remote', { is_verified: true })];
    const localRow = { ...app('o/local'), source: 'local', status: 'collected' } as AppSummary;
    const merged = selectMergedCatalogApps(remote, [{ item: { id: 'o/local', owner: 'o', repo: 'local', platforms: ['windows'] }, status: 'collected', archived: false } as never], true);
    // merged 应含本地且远端优先（远程在前）
    expect(merged[0]?.id).toBe('o/remote');
    expect(merged.some((m) => (m as { source?: unknown }).source === 'local')).toBe(true);
    const online = [app('o/local'), app('o/other')];
    const out = annotateOnlineCataloged(online, [...merged, localRow]);
    const hit = out.find((r) => r.id === 'o/local')!;
    expect((hit as { source?: unknown }).source).toBe('local');
    expect(resolveVerifiedBadgeVariant(hit as never)).toBe('local');
    const miss = out.find((r) => r.id === 'o/other')!;
    expect((miss as { source?: unknown }).source).toBeUndefined();
    expect(miss.is_cataloged).toBe(false);
  });

  it('annotateEnrichMirrorCataloged：同 id 叠加 local（key 与 id 双通道）', () => {
    const catalog = [app('o/remote')];
    const local = [{ ...app('acme/atlas'), source: 'local', status: 'local_collected' } as AppSummary];
    const mirror = {
      'acme/atlas': app('acme/atlas'),
      'other/app': app('other/app'),
    };
    const out = annotateEnrichMirrorCataloged(mirror, catalog, local);
    expect((out['acme/atlas'] as { source?: unknown }).source).toBe('local');
    expect(resolveVerifiedBadgeVariant(out['acme/atlas'] as never)).toBe('local');
    expect((out['other/app'] as { source?: unknown }).source).toBeUndefined();
  });

  it('AppCard 在线段同形行：source=local 即显橘黄 local 徽标（复用 verified-badge-local）', () => {
    const row = {
      ...app('o/local'),
      source: 'local',
      status: 'collected',
      is_cataloged: true,
    } as AppSummary;
    const { container } = render(
      <AppCard
        app={row}
        isInstalled={false}
        isManaged={false}
        platformLoading={false}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
      />,
    );
    expect(container.querySelector('.verified-badge-local')).toBeTruthy();
    // 蓝优先：verified 行仍蓝，不显黄
    const { container: blue } = render(
      <AppCard
        app={app('o/remote', { is_verified: true })}
        isInstalled={false}
        isManaged={false}
        platformLoading={false}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
      />,
    );
    expect(blue.querySelector('.verified-badge-local')).toBeNull();
    expect(blue.querySelector('.verified-badge')).toBeTruthy();
  });
});

describe('冷启黄标补标（首刷 null→就绪 + id 归一）', () => {
  it('首刷 custom 空即无标，收录就绪后远端同仓行叠黄（不改排序，蓝优先不动）', () => {
    const remote = [
      app('openchamber/openchamber', { owner: 'openchamber', repo: 'openchamber' }),
      app('openchamber/cc-switch', { owner: 'openchamber', repo: 'cc-switch' }),
    ];
    // 首刷：customApps null→[]，合并即原数组透传，无标
    const first = selectMergedCatalogApps(remote, [], true);
    expect(first).toBe(remote);
    expect(first.some((m) => (m as { source?: unknown }).source === 'local')).toBe(false);
    // 就绪：openchamber 远端已存在同仓收录 + cc-switch 远端缺席补位
    const collected = [
      { ...app('openchamber/openchamber', { owner: 'openchamber', repo: 'openchamber' }), source: 'local', status: 'collected' } as AppSummary,
      { ...app('openchamber/cc-switch', { owner: 'openchamber', repo: 'cc-switch' }), source: 'local', status: 'collected' } as AppSummary,
    ];
    const merged = selectMergedCatalogApps(remote, collected, true);
    // 顺序不动：远端在前，补位在后（cc-switch 远端已存在则原位叠标，无新增）
    expect(merged.map((m) => m.id)).toEqual(['openchamber/openchamber', 'openchamber/cc-switch']);
    const open = merged.find((r) => r.id === 'openchamber/openchamber')!;
    expect((open as { source?: unknown }).source).toBe('local');
    expect(resolveVerifiedBadgeVariant(open as never)).toBe('local');
    const cc = merged.find((r) => r.id === 'openchamber/cc-switch')!;
    expect((cc as { source?: unknown }).source).toBe('local');
  });

  it('大小写/owner-repo 归一：远端大写 + 本地小写仍命中', () => {
    const catalogIds = buildCatalogIdSet([app('o/remote')]);
    const local = [
      { ...app('OpenChamber/OpenChamber', { owner: 'OpenChamber', repo: 'OpenChamber' }), source: 'local', status: 'collected' } as AppSummary,
    ];
    const row = app('openchamber/openchamber', { owner: 'openchamber', repo: 'openchamber' });
    const out = annotateIsCataloged(row, catalogIds, local);
    expect((out as { source?: unknown }).source).toBe('local');
    expect(resolveVerifiedBadgeVariant(out as never)).toBe('local');
  });

  it('前后缀漂移：github.com 前缀 id 与 owner/repo 短 id 互命中', () => {
    expect(rowAliasKeys({ id: 'github.com/openchamber/openchamber', owner: 'openchamber', repo: 'openchamber' })).toContain(
      'openchamber/openchamber',
    );
    const catalogIds = buildCatalogIdSet([app('o/remote')]);
    const local = [
      { ...app('openchamber/openchamber'), source: 'local', status: 'collected' } as AppSummary,
    ];
    const row = app('github.com/openchamber/openchamber', { owner: 'openchamber', repo: 'openchamber' });
    const out = annotateIsCataloged(row, catalogIds, local);
    expect((out as { source?: unknown }).source).toBe('local');
  });

  it('已验证远端同仓不叠黄（蓝优先），显式 lookup 经 mergeLocalLookups 复用', () => {
    const remote = [app('o/a', { is_verified: true })];
    const collected = [{ ...app('o/a'), source: 'local', status: 'collected' } as AppSummary];
    const merged = selectMergedCatalogApps(remote, collected, true);
    expect((merged[0] as { source?: unknown }).source).toBeUndefined();
    expect(resolveVerifiedBadgeVariant(merged[0] as never)).toBe('verified');
    // 在线段：目录无本地行时显式 collected 仍命中（远端已存在同仓场景）
    const online = [app('o/a')];
    const out = annotateOnlineCataloged(online, remote, collected);
    // 未验证在线行应叠黄
    expect((out[0] as { source?: unknown }).source).toBe('local');
    // mergeLocalLookups 复用：显式 + 推断合并，不改排序
    const lookup = mergeLocalLookups([], collected);
    expect(Array.isArray(lookup)).toBe(true);
  });
});

describe('裸行本地徽标与后端预盖章透传', () => {
  it('resolveBareRowLocalBadgeVariant：命中本地即 local，未命中/已验证即 null', () => {
    const local = [
      { ...app('acme/atlas'), source: 'local', status: 'collected', is_cataloged: true } as AppSummary,
    ];
    expect(
      resolveBareRowLocalBadgeVariant({ id: 'acme/atlas', owner: 'acme', repo: 'atlas' }, local),
    ).toBe('local');
    // 大小写/owner-repo 漂移仍命中
    expect(
      resolveBareRowLocalBadgeVariant({ id: 'ACME/Atlas', owner: 'ACME', repo: 'Atlas' }, local),
    ).toBe('local');
    expect(
      resolveBareRowLocalBadgeVariant({ id: 'other/app', owner: 'other', repo: 'app' }, local),
    ).toBeNull();
    // 蓝优先：已验证行不返回橘黄
    expect(
      resolveBareRowLocalBadgeVariant(
        { id: 'acme/atlas', owner: 'acme', repo: 'atlas', is_verified: true },
        local,
      ),
    ).toBeNull();
  });

  it('annotateLocalSource：未命中原引用透传，命中补 source/status 且幂等', () => {
    const local = [
      { ...app('acme/atlas'), source: 'local', status: 'collected', is_cataloged: true } as AppSummary,
    ];
    const miss = app('other/app');
    expect(annotateLocalSource(miss, local)).toBe(miss);

    const hit = app('acme/atlas');
    const marked = annotateLocalSource(hit, local);
    expect(marked.source).toBe('local');
    expect(marked.status).toBe('collected');
    expect(marked.is_cataloged).toBe(true);
    // 幂等：已标记行原引用返回
    expect(annotateLocalSource(marked, local)).toBe(marked);
    // 蓝优先：已验证行不叠加
    const verified = app('acme/atlas', { is_verified: true });
    expect(annotateLocalSource(verified, local)).toBe(verified);
  });

  it('陈旧本地标注（本地收录已退回）：is_cataloged/source/status 一并纠正', () => {
    // 后端旧投影或缓存行残留 source=local，当前目录已无本地收录：黄标不得继续。
    const stale = {
      ...app('o/gone'),
      source: 'local',
      status: 'collected',
      is_cataloged: true,
    } as AppSummary;
    const out = annotateIsCataloged(stale, new Set<string>(), []);
    expect(out.is_cataloged).toBe(false);
    expect(out.source).toBeUndefined();
    expect(out.status).toBeUndefined();
    expect(resolveVerifiedBadgeVariant(out as never)).toBeNull();
    // 远端目录仍收录时改回 remote 并保留已收录语义。
    const remoteOut = annotateIsCataloged(stale, buildCatalogIdSet([app('o/gone')]), []);
    expect(remoteOut.is_cataloged).toBe(true);
    expect(remoteOut.source).toBe('remote');
    expect(remoteOut.status).toBeUndefined();
  });

  it('后端已盖章行（source/status/is_cataloged 齐备）经标注原引用透传', () => {
    const stamped = {
      ...app('o/local'),
      source: 'local',
      status: 'collected',
      is_cataloged: true,
    } as AppSummary;
    const out = annotateIsCataloged(stamped, new Set<string>(), [stamped]);
    expect(out).toBe(stamped);
    // 合并视图同样不改写已盖章行引用
    const merged = selectMergedCatalogApps([app('o/remote')], [stamped], true);
    expect(merged.find((r) => r.id === 'o/local')).toBe(stamped);
  });
});
