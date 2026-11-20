/** `iconStore` 写入、缓冲回读、世代门控与订阅扇出测试。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLED_ROW_ICON_QUEUE_CAP,
  __flushIconPreloadsForTests,
  __getIconPreloadQueueSizeForTests,
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
  __setIconDataCacheForTests,
  admitIconHit,
  advanceStarredIconGateOnNewQuery,
  advanceTrendIconGateOnRefresh,
  ensureIconReadySubscription,
  getBufferedIcon,
  isIconPersistedOrQueued,
  patchIconMirror,
  queueAssembledRowIcons,
  resolveIconWithBuffer,
  setActiveStarredIconGate,
  setActiveTrendIconGate,
  subscribeIconWrites,
  type IconReadyPayload,
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

  it('三维世代门控：trend board/gen 与 starred 水位正交拦截在途旧事件', () => {
    setActiveTrendIconGate({ board: 'weekly' });
    // 1. 同榜 gen=1 受理并记录水位
    const t1 = admitIconHit({
      id: 'o/t1',
      icon: REAL,
      level: 2,
      context: { kind: 'trend', board: 'weekly', gen: 1 },
      currentSearchId: 'sid-active',
    });
    expect(t1.accepted).toBe(true);

    // 2. 切榜到 daily：旧榜 weekly 与旧世代 gen=1 一律拦截
    setActiveTrendIconGate({ board: 'daily' });
    const staleBoard = admitIconHit({
      id: 'o/t2',
      icon: REAL,
      level: 2,
      context: { kind: 'trend', board: 'weekly', gen: 2 },
    });
    expect(staleBoard.accepted).toBe(false);
    expect(staleBoard.reason).toBe('stale-board');

    const staleTrendGen = admitIconHit({
      id: 'o/t3',
      icon: REAL,
      level: 2,
      context: { kind: 'trend', board: 'daily', gen: 1 },
    });
    expect(staleTrendGen.accepted).toBe(false);
    expect(staleTrendGen.reason).toBe('stale-board-gen');

    // 3. 新榜 gen=2 受理；同榜强刷推进水位后 gen=2 变过期，gen=3 放行
    expect(
      admitIconHit({
        id: 'o/t4',
        icon: REAL,
        level: 2,
        context: { kind: 'trend', board: 'daily', gen: 2 },
      }).accepted,
    ).toBe(true);
    advanceTrendIconGateOnRefresh();
    expect(
      admitIconHit({
        id: 'o/t5',
        icon: REAL,
        level: 2,
        context: { kind: 'trend', board: 'daily', gen: 2 },
      }).reason,
    ).toBe('stale-board-gen');
    expect(
      admitIconHit({
        id: 'o/t6',
        icon: REAL,
        level: 2,
        context: { kind: 'trend', board: 'daily', gen: 3 },
      }).accepted,
    ).toBe(true);

    // 4. Starred 水位与显式 gen 门控：不受 trend/search 门控干扰
    expect(
      admitIconHit({
        id: 'o/s1',
        icon: REAL,
        level: 2,
        context: { kind: 'starred', gen: 5 },
        currentSearchId: 'sid-active',
      }).accepted,
    ).toBe(true);
    advanceStarredIconGateOnNewQuery();
    const staleStar = admitIconHit({
      id: 'o/s2',
      icon: REAL,
      level: 2,
      context: { kind: 'starred', gen: 5 },
    });
    expect(staleStar.accepted).toBe(false);
    expect(staleStar.reason).toBe('stale-starred-gen');
    setActiveStarredIconGate({ gen: 6 });
    expect(
      admitIconHit({
        id: 'o/s3',
        icon: REAL,
        level: 2,
        context: { kind: 'starred', gen: 6 },
      }).accepted,
    ).toBe(true);

    // 5. 卸载置 null 时推进水位：重进同榜后旧 gen=3 在途事件仍被拦截
    setActiveTrendIconGate(null);
    setActiveTrendIconGate({ board: 'daily' });
    const postDispose = admitIconHit({
      id: 'o/t7',
      icon: REAL,
      level: 2,
      context: { kind: 'trend', board: 'daily', gen: 3 },
    });
    expect(postDispose.accepted).toBe(false);
    expect(postDispose.reason).toBe('stale-board-gen');
  });

  it('ensureIconReadySubscription 引用计数：双消费方仅挂单条监听、单次 admit、全释放才解绑', async () => {
    let listener: ((payload: IconReadyPayload) => void) | undefined;
    const unlisten = vi.fn();
    const subscribe = vi.fn(async (cb: (payload: IconReadyPayload) => void) => {
      listener = cb;
      return unlisten;
    });
    const seen: unknown[] = [];
    const unsubWrites = subscribeIconWrites((h) => seen.push(h));
    try {
      const rel1 = ensureIconReadySubscription(subscribe, {
        getCurrentSearchId: () => 'sid-1',
      });
      const rel2 = ensureIconReadySubscription(subscribe);
      await Promise.resolve();
      expect(subscribe).toHaveBeenCalledTimes(1);

      listener?.({
        id: 'o/shared',
        icon: REAL,
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: 'sid-1' },
      });
      expect(seen).toHaveLength(1);

      rel2();
      expect(unlisten).not.toHaveBeenCalled();
      rel1();
      expect(unlisten).toHaveBeenCalledTimes(1);
    } finally {
      unsubWrites();
    }
  });
});
