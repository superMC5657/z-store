/** `Confirmed Icon` 轮换结果准入（`admitIconCycleResult`）与可持久化 URL 口径测试。 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
  admitIconCycleResult,
  admitIconHit,
  getBufferedIcon,
  patchAppIconList,
  pickCyclePersistIconUrl,
  resolveIconWithBuffer,
  resolveRemoteIconUrl,
  subscribeIconWrites,
} from './iconStore';

const REAL_ICON = 'https://cdn.simpleicons.org/r';

let list: { id: string; icon: string }[];

function testPatch(tid: string, icon: string): void {
  list = patchAppIconList(list as never[], tid, icon) as never as { id: string; icon: string }[];
}

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
  list = [{ id: 'o/r', icon: '' }];
});

describe('pickCyclePersistIconUrl', () => {
  it('remote_url 优先于 url', () => {
    expect(
      pickCyclePersistIconUrl({
        url: 'https://cdn.example.com/a.png',
        remote_url: 'https://cdn.example.com/b.svg',
      }),
    ).toBe('https://cdn.example.com/b.svg');
  });

  it('remote 为空时 http(s) url 兜底；data:、非 URL 与空值为空串', () => {
    expect(pickCyclePersistIconUrl({ url: 'https://cdn.simpleicons.org/foo', remote_url: '' })).toBe(
      'https://cdn.simpleicons.org/foo',
    );
    expect(pickCyclePersistIconUrl({ url: 'data:image/png;base64,AAA', remote_url: '' })).toBe('');
    expect(pickCyclePersistIconUrl({ url: 'not-a-url', level: 5 })).toBe('');
    expect(pickCyclePersistIconUrl({ url: '', level: 5, remote_url: '' })).toBe('');
    expect(pickCyclePersistIconUrl(null)).toBe('');
    expect(pickCyclePersistIconUrl(undefined)).toBe('');
  });

  it('resolveRemoteIconUrl 只接受 http(s) 的 remote_url', () => {
    expect(resolveRemoteIconUrl({ remote_url: ' https://example.com/a.png ' })).toBe(
      'https://example.com/a.png',
    );
    expect(resolveRemoteIconUrl({ remote_url: 'data:image/png;base64,AAA' })).toBe('');
    expect(resolveRemoteIconUrl(null)).toBe('');
  });
});

describe('admitIconCycleResult', () => {
  it('可持久化 URL 携带层级写透列表与缓冲', () => {
    const res = admitIconCycleResult(
      'o/r',
      { url: 'data:image/png;base64,AAA', remote_url: REAL_ICON, level: 2 },
      { patch: testPatch },
    );
    expect(res.accepted).toBe(true);
    expect(res.level).toBe(2);
    expect(list[0].icon).toBe(REAL_ICON);
    expect(getBufferedIcon('o/r')).toBe(REAL_ICON);
  });

  it('level 5 空串定格首字母徽标并扇出空图标', () => {
    admitIconHit({ id: 'o/r', icon: REAL_ICON, level: 2, patch: testPatch });
    const seen: { icon: string; level?: number }[] = [];
    const unsub = subscribeIconWrites((hit) => seen.push({ icon: hit.icon, level: hit.level }));
    try {
      const res = admitIconCycleResult('o/r', { url: '', remote_url: '', level: 5 }, { patch: testPatch });
      expect(res.accepted).toBe(true);
      expect(res.reason).toBe('level5-badge');
      expect(list[0].icon).toBe('');
      expect(getBufferedIcon('o/r')).toBeUndefined();
      expect(seen).toContainEqual({ icon: '', level: 5 });
    } finally {
      unsub();
    }
  });

  it('普通空值丢弃，保留已有实图', () => {
    admitIconHit({ id: 'o/r', icon: REAL_ICON, level: 2, patch: testPatch });
    const res = admitIconCycleResult('o/r', { url: '', remote_url: '', level: 1 }, { patch: testPatch });
    expect(res.accepted).toBe(false);
    expect(list[0].icon).toBe(REAL_ICON);
  });

  it('仅有 data: 时不进入共享层（即时展示留给调用方）', () => {
    const res = admitIconCycleResult('o/r', { url: 'data:image/png;base64,AAA', level: 3 }, { patch: testPatch });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('data-transient');
    expect(list[0].icon).toBe('');
    expect(getBufferedIcon('o/r')).toBeUndefined();
  });

  it('空结果直接拒绝', () => {
    expect(admitIconCycleResult('o/r', null).accepted).toBe(false);
    expect(admitIconCycleResult('o/r', undefined).accepted).toBe(false);
  });

  it('手动正向轮换 L1 -> L2 -> L3 -> L4 -> L5 -> L1 均受理且实时写透', () => {
    const urls = {
      1: 'https://cdn.example.com/l1.png',
      2: 'https://cdn.example.com/l2.png',
      3: 'https://cdn.example.com/l3.png',
      4: 'https://cdn.example.com/l4.png',
    } as const;

    for (const level of [1, 2, 3, 4] as const) {
      const res = admitIconCycleResult('o/r', { remote_url: urls[level], level }, { patch: testPatch });
      expect(res.accepted).toBe(true);
      expect(res.level).toBe(level);
      expect(list[0].icon).toBe(urls[level]);
      expect(getBufferedIcon('o/r')).toBe(urls[level]);
    }

    // 切至 L5 首字母徽章
    const l5 = admitIconCycleResult('o/r', { url: '', remote_url: '', level: 5 }, { patch: testPatch });
    expect(l5.accepted).toBe(true);
    expect(l5.reason).toBe('level5-badge');
    expect(list[0].icon).toBe('');
    expect(getBufferedIcon('o/r')).toBeUndefined();

    // 从 L5 再次手动轮换回到 L1
    const backToL1 = admitIconCycleResult('o/r', { remote_url: urls[1], level: 1 }, { patch: testPatch });
    expect(backToL1.accepted).toBe(true);
    expect(list[0].icon).toBe(urls[1]);
    expect(getBufferedIcon('o/r')).toBe(urls[1]);
  });

  it('L5 徽章记忆生效：resolveIconWithBuffer 不复活旧图，且拦截后续非强制命中', () => {
    const oldUrl = 'https://cdn.example.com/l2.png';
    admitIconCycleResult('o/r', { remote_url: oldUrl, level: 2 }, { patch: testPatch });
    expect(list[0].icon).toBe(oldUrl);

    const l5 = admitIconCycleResult('o/r', { url: '', remote_url: '', level: 5 }, { patch: testPatch });
    expect(l5.accepted).toBe(true);

    // resolveIconWithBuffer 命中 L5 守卫，保留空串而非从 cur 复活旧图
    const cur = { id: 'o/r', owner: 'o', repo: 'r', icon: oldUrl } as never as import('../types').AppSummary;
    const incomingEmpty = { id: 'o/r', owner: 'o', repo: 'r', icon: '' } as never as import('../types').AppSummary;
    expect(resolveIconWithBuffer(cur, incomingEmpty).icon).toBe('');

    // 非强制的流式/水合命中（L1/L2/无 level）一律被 L5 拦截
    const liveL1 = admitIconHit({ id: 'o/r', icon: 'https://cdn.example.com/live-l1.png', level: 1, patch: testPatch });
    expect(liveL1.accepted).toBe(false);
    expect(liveL1.reason).toBe('level-stale');

    const passiveM2 = admitIconHit({ id: 'o/r', icon: 'https://cdn.example.com/m2.png', via: 'm2', patch: testPatch });
    expect(passiveM2.accepted).toBe(false);
    expect(passiveM2.reason).toBe('level-stale');

    expect(list[0].icon).toBe('');
    expect(getBufferedIcon('o/r')).toBeUndefined();

    // 显式 force 写入（或再次手动轮换）可脱离 L5
    const forced = admitIconHit({
      id: 'o/r',
      icon: 'https://cdn.example.com/forced-l3.png',
      level: 3,
      force: true,
      patch: testPatch,
    });
    expect(forced.accepted).toBe(true);
    expect(list[0].icon).toBe('https://cdn.example.com/forced-l3.png');

    // 非强制低优（L4 劣于当前 L3）仍按单调规则拒绝
    const downgraded = admitIconHit({
      id: 'o/r',
      icon: 'https://cdn.example.com/live-l4.png',
      level: 4,
      patch: testPatch,
    });
    expect(downgraded.accepted).toBe(false);
    expect(downgraded.reason).toBe('level-stale');
  });
});
