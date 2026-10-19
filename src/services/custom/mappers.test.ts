/**
 * 草稿形状唯一转换口（mappers）契约：
 * - 线格式 `null` ↔ 领域空串；
 * - `local_collected` 归一为 `collected`；
 * - 保存 payload 恒 `is_verified=false`，stars/forks 沿用已有行真值；
 * - 摘要投影沿用本地收录黄标字段（source/status）。
 */
import { describe, expect, it } from 'vitest';
import {
  draftStatusFromWire,
  entryFromWire,
  entryToCollectedSummary,
  itemFromWire,
  itemToSummary,
  itemToWire,
} from './mappers';
import type { DraftEntryWire, DraftItem, DraftItemWire } from './types';

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
  return { ...itemFromWire(wireItem()), ...extra };
}

describe('草稿 mappers（线格式 ↔ 领域）', () => {
  it('entryFromWire：null 归一空串、local_collected 归一 collected、缺省 updated_at 保留', () => {
    const entry = entryFromWire(wireEntry({ status: 'local_collected' }));
    expect(entry.status).toBe('collected');
    expect(entry.item.description_en).toBe('');
    expect(entry.item.homepage).toBe('');
    expect(entry.item.stars).toBe(42);
    expect(entry.pr_url).toBeNull();
    expect(entry.updated_at).toBe(2);
    expect(draftStatusFromWire('submitted')).toBe('submitted');
    expect(draftStatusFromWire('draft')).toBe('draft');
    expect(draftStatusFromWire('weird')).toBe('draft');
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
    // 无已有行时退回 item 真值。
    expect(itemToWire(draftItem({ stars: 3, forks: 1 })).stars).toBe(3);
  });

  it('往返：领域 → 线格式 → 领域保持业务字段不变', () => {
    const item = draftItem({ description_en: 'tool en', homepage: 'https://example.com' });
    const roundTrip = itemFromWire(itemToWire(item));
    expect(roundTrip).toEqual(item);
  });

  it('itemToSummary：本地收录黄标字段（source=local + 显式 status）与星数透传', () => {
    const summary = itemToSummary(draftItem({ name: '' }), 'collected');
    expect(summary.id).toBe('acme/atlas');
    expect(summary.name).toBe('acme/atlas');
    expect(summary.source).toBe('local');
    expect(summary.status).toBe('collected');
    expect(summary.is_verified).toBe(false);
    expect(summary.stars).toBe(42);
    expect(summary.homepage).toBeNull();
    expect(summary.platforms).toEqual(['windows']);
  });

  it('entryToCollectedSummary：保留 status/archived 供合并去重与黄标', () => {
    const summary = entryToCollectedSummary(entryFromWire(wireEntry()));
    expect(summary.status).toBe('collected');
    expect(summary.archived).toBe(false);
    expect(summary.is_verified).toBe(false);
    expect(summary.latest_version).toBe('v0.1.0');
  });
});
