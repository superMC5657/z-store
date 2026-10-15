/**
 * 图标深 module 单 interface 回归。
 *
 * module/interface/depth/seam/adapter/leverage/locality 口径：
 * - module：`services/iconStore` 为唯一深 module；`AppIcon`/`enrich`/`board` 无图标 locality。
 * - interface：写唯一经 `admitIconHit`，读侧经 `subscribeIconWrites` 扇出；`resolveIconWithBuffer`/
 *   `patchIconMirror` 为内部 seam 的收敛实现。
 * - 领域词：`IconFetch` → `icon-ready` → `admitIconHit`；`Search List Cache` 组装经缓冲回读。
 * - 合规：`normalizeId` 归一遵 ADR-0010；level 纯L + `via` 正交遵 ADR-0015；展示分层遵 ADR-0005。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSEMBLED_ROW_ICON_QUEUE_CAP,
  __flushIconPreloadsForTests,
  __getIconPreloadQueueSizeForTests,
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
  __setIconDataCacheForTests,
  admitIconHit,
  clearBufferedIcon,
  getBufferedIcon,
  isIconPersistedOrQueued,
  patchIconMirror,
  queueAssembledRowIcons,
  resolveIconWithBuffer,
  subscribeIconWrites,
} from './iconStore';

const REAL = 'https://cdn.simpleicons.org/r';

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
});

describe('deepen icon-write seam behind single interface', () => {
  it('L5 空 payload 经 admitIconHit 扇出（patch + 订阅双到，不复活旧图）', () => {
    const seen: { targets: string[]; icon: string; level?: number }[] = [];
    const unsub = subscribeIconWrites((h) => seen.push(h));
    try {
      const seed = admitIconHit({ id: 'o/r', icon: REAL, level: 2, via: 'm2', patch: () => {} });
      expect(seed.accepted).toBe(true);
      expect(getBufferedIcon('o/r')).toBe(REAL);
      seen.length = 0;
      const res = admitIconHit({ id: 'o/r', icon: '', level: 5, patch: () => {} });
      expect(res.accepted).toBe(true);
      expect(res.reason).toBe('level5-badge');
      expect(getBufferedIcon('o/r')).toBeUndefined();
      expect(seen).toEqual([{ targets: ['o/r'], icon: '', level: 5 }]);
    } finally {
      unsub();
    }
  });

  it('clearBufferedIcon 直接清零亦通知（防富卡 stale）', () => {
    const seen: { targets: string[]; icon: string; level?: number }[] = [];
    const unsub = subscribeIconWrites((h) => seen.push(h));
    try {
      const seed = admitIconHit({ id: 'o/r', icon: REAL, level: 2, via: 'm2' });
      expect(seed.accepted).toBe(true);
      seen.length = 0;
      clearBufferedIcon('o/r');
      expect(getBufferedIcon('o/r')).toBeUndefined();
      expect(seen).toEqual([{ targets: ['o/r'], icon: '', level: 5 }]);
    } finally {
      unsub();
    }
  });

  it('被动空壳（无 level 5）仍丢弃且不扇出', () => {
    const seen: unknown[] = [];
    const unsub = subscribeIconWrites((h) => seen.push(h));
    try {
      admitIconHit({ id: 'o/r', icon: REAL, level: 2, via: 'm2' });
      seen.length = 0;
      const res = admitIconHit({ id: 'o/r', icon: '' });
      expect(res.accepted).toBe(false);
      expect(getBufferedIcon('o/r')).toBe(REAL);
      expect(seen).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it('resolveIconWithBuffer 单 interface：旧实 + 回填空沿用旧，空壳经缓冲回读', () => {
    admitIconHit({ id: 'o/r', icon: REAL, level: 2, via: 'm2' });
    const cur = { id: 'o/r', owner: 'o', repo: 'r', icon: REAL } as never as import('../types').AppSummary;
    const incomingEmpty = { id: 'o/r', owner: 'o', repo: 'r', icon: '' } as never as import('../types').AppSummary;
    expect(resolveIconWithBuffer(cur, incomingEmpty).icon).toBe(REAL);
    // 无旧值但缓冲有实图 → 回读缓冲（与旧 enrich/board getBufferedIcon(key) 同语义）。
    const incomingBare = { id: 'o/r', owner: 'o', repo: 'r', icon: '' } as never as import('../types').AppSummary;
    expect(resolveIconWithBuffer(undefined, incomingBare).icon).toBe(REAL);
  });

  it('queueAssembledRowIcons 批量上限与跳过规则（前 N 个 http 入队，data:/空跳过）', () => {
    const rows = Array.from({ length: ASSEMBLED_ROW_ICON_QUEUE_CAP + 5 }, (_, i) => ({
      id: `o/r${i}`,
      icon: `https://cdn.example.com/${i}.png`,
    }));
    rows.push(
      { id: 'o/data', icon: 'data:image/png;base64,AAA' },
      { id: 'o/empty', icon: '' },
    );
    queueAssembledRowIcons(rows);
    expect(__getIconPreloadQueueSizeForTests()).toBe(ASSEMBLED_ROW_ICON_QUEUE_CAP);
  });

  it('queueAssembledRowIcons 已覆盖让位：已落盘的不占 30 名额，新行入队', async () => {
    const first = Array.from({ length: ASSEMBLED_ROW_ICON_QUEUE_CAP }, (_, i) => ({
      id: `o/cached${i}`,
      icon: `https://cdn.example.com/cached-${i}.png`,
    }));
    queueAssembledRowIcons(first);
    expect(__getIconPreloadQueueSizeForTests()).toBe(ASSEMBLED_ROW_ICON_QUEUE_CAP);
    // 模拟落盘：写 iconDataCache + 排空队列（非 Tauri 只收队，保留落盘态）。
    for (const r of first) __setIconDataCacheForTests(r.icon, 'data:image/png;base64,CACHED');
    await __flushIconPreloadsForTests();
    expect(__getIconPreloadQueueSizeForTests()).toBe(0);
    // 第二批：前 30 为已落盘重叠，后 5 为新 URL（另带 data:/空，照旧跳过）。
    const fresh = Array.from({ length: 5 }, (_, i) => ({
      id: `o/fresh${i}`,
      icon: `https://cdn.example.com/fresh-${i}.png`,
    }));
    const second = [
      ...first,
      ...fresh,
      { id: 'o/data', icon: 'data:image/png;base64,AAA' },
      { id: 'o/empty', icon: '' },
    ];
    queueAssembledRowIcons(second);
    // 旧的不占名额：仅 5 个新 URL 入队。
    expect(__getIconPreloadQueueSizeForTests()).toBe(5);
    for (const r of fresh) expect(isIconPersistedOrQueued(r.icon)).toBe(true);
    for (const r of first) expect(isIconPersistedOrQueued(r.icon)).toBe(true);
    expect(isIconPersistedOrQueued('https://cdn.example.com/never-seen.png')).toBe(false);
  });

  it('patchIconMirror 单 interface（含 L5 清零与别名）', () => {
    const prev: Record<string, never> = {
      'o/r': { id: 'o/r', icon: REAL } as never,
    } as never as Record<string, never>;
    const viaStore = patchIconMirror(prev as never, 'o/r', '');
    expect((viaStore as Record<string, { icon: string }>)['o/r'].icon).toBe('');
  });
});
