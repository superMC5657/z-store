/**
 * 回归：`patchAppIconList` 归一与 `resolveIconTargets`/`getBufferedIcon` 同口径（trim+小写）。
 * 首搜直写（patch）与二搜缓冲回读（getBufferedIcon）一致，避免首搜无图标、二搜经缓冲才有。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { __resetIconStoreForTests, applyHit, patchAppIconList, getBufferedIcon } from './iconStore';
beforeEach(() => __resetIconStoreForTests());
describe('patchAppIconList 归一一致', () => {
  it('含空白 id 经归一直达（首搜 patch 命中，与缓冲同键）', () => {
    const prev = [{ id: ' O/R ', name: 'x', owner: 'o', repo: 'r', icon: '', icon_bg: '', description: '', stars: 0, forks: 0, license: '', latest_version: '', category: '', category_name: '', is_verified: false, forge: '', forge_host: '', homepage: null, platforms: [] } as any];
    let patched: any = prev;
    const res = applyHit({
      key: 'o/r', id: 'o/r', icon: 'https://cdn.simpleicons.org/r', level: 2, via: 'm2',
      context: { kind: 'search', search_id: 's1' } as any,
      currentSearchId: 's1',
      getCurrentIcon: () => '',
      patch: (tid, icon) => {
        patched = patchAppIconList(patched as never[], tid, icon) as never as any;
      },
    });
    expect(res.accepted).toBe(true);
    expect(getBufferedIcon('o/r')).toBe('https://cdn.simpleicons.org/r');
    expect((patched[0] as any).icon).toBe('https://cdn.simpleicons.org/r');
  });
  it('常规 id 直写命中（无空白亦一致）', () => {
    const prev = [{ id: 'o/r', icon: '' } as any];
    let patched: any = prev;
    const res = applyHit({
      key: 'o/r', id: 'o/r', icon: 'https://cdn.simpleicons.org/r', level: 2, via: 'm2',
      context: { kind: 'search', search_id: 's1' } as any,
      currentSearchId: 's1',
      getCurrentIcon: () => '',
      patch: (tid, icon) => {
        patched = patchAppIconList(patched as never[], tid, icon) as never as any;
      },
    });
    expect(res.accepted).toBe(true);
    expect((patched[0] as any).icon).toBe('https://cdn.simpleicons.org/r');
  });
});
