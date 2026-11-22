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
});
