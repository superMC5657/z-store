/**
 * L5 首字母徽章回归。
 *
 * 详情把图标级别切到 L5（空图标 + level 5）→ 富卡（trend enrich
 * 镜像）与列表行必须同步变为空徽章：唯一写口 `admitIconHit` 的 L5 显式分支
 * 扇出通知（清缓冲 + patch + 读侧事件），防永久 stale。
 *
 * 本文件只用已存在 API：`admitIconHit`（显式 patch）+ 纯函数
 * `patchAppIconList` / `patchIconMirror`（生产订阅者同逻辑）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
  admitIconHit,
  patchAppIconList,
  patchIconMirror,
  getBufferedIcon,
  subscribeIconWrites,
} from './iconStore';

const REAL_ICON = 'https://cdn.simpleicons.org/r';

let list: any[];
let mirror: Record<string, any>;

function testPatch(tid: string, icon: string): void {
  list = patchAppIconList(list as never[], tid, icon) as never as any[];
  mirror = patchIconMirror(mirror, tid, icon);
}

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
  list = [{ id: 'o/r', icon: '' }];
  mirror = { 'o/r': { id: 'o/r', icon: '' } };
  // 经唯一写口播种实图（L2 + 显式 patch，模拟 icon-ready 正常路径）。
  const seed = admitIconHit({
    id: 'o/r',
    icon: REAL_ICON,
    level: 2,
    via: 'm2',
    patch: testPatch,
  });
  expect(seed.accepted).toBe(true);
  expect(list[0].icon).toBe(REAL_ICON);
  expect(mirror['o/r'].icon).toBe(REAL_ICON);
});

describe('L5 badge write through the sole write', () => {
  it('详情切 L5（空图标 + level 5）→ 列表与富卡镜像同步变为空徽章', () => {
    const res = admitIconHit({ id: 'o/r', icon: '', level: 5, patch: testPatch });
    expect(res.accepted).toBe(true);
    expect(list[0].icon).toBe('');
    expect(mirror['o/r'].icon).toBe('');
    expect(getBufferedIcon('o/r')).toBeUndefined();
  });

  it('被动空壳（无 level）仍永不覆盖实图', () => {
    const res = admitIconHit({ id: 'o/r', icon: '', patch: testPatch });
    expect(res.accepted).toBe(false);
    expect(list[0].icon).toBe(REAL_ICON);
    expect(mirror['o/r'].icon).toBe(REAL_ICON);
  });

  it('无 patch 的本地写经读侧扇出到达订阅者（详情轮转/榜单镜像路径）', () => {
    const seen: { targets: string[]; icon: string; level?: number }[] = [];
    const unsub = subscribeIconWrites((hit) => {
      seen.push(hit);
      for (const t of hit.targets) testPatch(t, hit.icon);
    });
    try {
      // Header 轮转路径：无 patch，只调唯一写口。
      const res = admitIconHit({ id: 'o/r', icon: '', level: 5 });
      expect(res.accepted).toBe(true);
      expect(seen).toEqual([{ targets: ['o/r'], icon: '', level: 5 }]);
      expect(list[0].icon).toBe('');
      expect(mirror['o/r'].icon).toBe('');
    } finally {
      unsub();
    }
  });
});
