/**
 * ticket 11 — 双维目录筛选 pending 生命周期深模块测试（经统一接口）。
 *
 * - 未收录行 pending→确认语义不变（空 + 未确认即 pending，具平台永不 pending）；
 * - 趋势分支重实现删除后不再出现永久 pending：settle 定时 15s 内必确认（假时钟）；
 * - 空筛选 `[]` 渲染空状态、缺键回退全选语义保留（经统一匹配口 + 存储解析，原单测照旧）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  PENDING_SETTLE_MS,
  LITE_BATCH_SIZE,
  LITE_TARGET_CAP,
  collectListPendingKeys,
  createInflightGuard,
  createSeqGuard,
  isEnrichedRowPending,
  isPendingFor,
  matchSelectedWithPending,
  runLiteBatch,
  scheduleSettleConfirm,
  selectListLiteTargets,
  unionConfirmedSets,
} from './pendingLifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('pendingLifecycle 常量：与主列表/榜单同口径', () => {
  it('settle 15s、lite 分批 5、上限 20', () => {
    expect(PENDING_SETTLE_MS).toBe(15_000);
    expect(LITE_BATCH_SIZE).toBe(5);
    expect(LITE_TARGET_CAP).toBe(20);
  });
});

describe('unionConfirmedSets：全局 ∪ 榜单内', () => {
  it('合并保序去重，缺席集合跳过', () => {
    expect(unionConfirmedSets(undefined, undefined)).toEqual(new Set<string>([]));
    expect(unionConfirmedSets(new Set(['a']), undefined, new Set(['b', 'a']))).toEqual(
      new Set(['a', 'b']),
    );
  });
});

describe('isPendingFor：pending 判定唯一口', () => {
  it('具平台永不 pending', () => {
    expect(isPendingFor({ id: 'a/b', platforms: ['windows'] }, new Set())).toBe(false);
    expect(isPendingFor({ id: 'a/b', platforms: ['windows'] })).toBe(false);
  });

  it('空 + 未传确认集沿用旧语义（非 pending）', () => {
    expect(isPendingFor({ id: 'a/b', platforms: [] })).toBe(false);
    expect(isPendingFor({ id: 'a/b' })).toBe(false);
  });

  it('空 + 已传确认集：未在集合中即 pending，已在即落定', () => {
    expect(isPendingFor({ id: 'a/b', platforms: [] }, new Set())).toBe(true);
    expect(isPendingFor({ id: 'a/b', platforms: [] }, new Set(['a/b']))).toBe(false);
  });
});

describe('matchSelectedWithPending：pending 恒可见，落定走正常过滤', () => {
  const windowsOnly = new Set(['windows']);

  it('pending 行不看 Other 勾选直接放行', () => {
    expect(
      matchSelectedWithPending({ id: 'a/b', platforms: [] }, windowsOnly, new Set()),
    ).toBe(true);
  });

  it('已确认空行走正常 Other 桶', () => {
    expect(
      matchSelectedWithPending({ id: 'a/b', platforms: [] }, windowsOnly, new Set(['a/b'])),
    ).toBe(false);
    expect(matchSelectedWithPending({ id: 'a/b', platforms: [] }, new Set(['other']), new Set(['a/b']))).toBe(
      true,
    );
  });

  it('显式 `[]` 谁也不匹配（空筛选状态前提）', () => {
    const empty = new Set<string>([]);
    expect(matchSelectedWithPending({ id: 'a/b', platforms: ['windows'] }, empty, new Set())).toBe(false);
    expect(matchSelectedWithPending({ id: 'a/b', platforms: [] }, empty, new Set(['a/b']))).toBe(false);
  });
});

describe('isEnrichedRowPending：趋势未收录行三态同口径', () => {
  it('裸行未确认即 pending，已确认即落定', () => {
    expect(isEnrichedRowPending('a/b', undefined, new Set())).toBe(true);
    expect(isEnrichedRowPending('a/b', undefined, new Set(['a/b']))).toBe(false);
  });

  it('具平台恒落定；空行按坐标/id 别名确认', () => {
    const concrete = { id: 'a/b', platforms: ['macos'] };
    expect(isEnrichedRowPending('a/b', concrete, new Set())).toBe(false);
    const emptyAlias = { id: 'A/B', platforms: [] };
    expect(isEnrichedRowPending('a/b', emptyAlias, new Set())).toBe(true);
    expect(isEnrichedRowPending('a/b', emptyAlias, new Set(['a/b']))).toBe(false);
  });
});

describe('inflight + seq 守卫', () => {
  it('take 跳过在途并去重，release 后可重取', () => {
    const guard = createInflightGuard();
    expect(guard.take(['a', 'A ', 'b'])).toEqual(['a', 'b']);
    expect(guard.has('a')).toBe(true);
    expect(guard.take(['a', 'c'])).toEqual(['c']);
    guard.release(['a']);
    expect(guard.has('a')).toBe(false);
    expect(guard.take(['a'])).toEqual(['a']);
  });

  it('seq 快照过期即 stale（切榜/重搜丢弃旧在途）', () => {
    let seq = 0;
    const guard = createSeqGuard(() => seq);
    const captured = guard.capture();
    expect(guard.isStale(captured)).toBe(false);
    seq += 1;
    expect(guard.isStale(captured)).toBe(true);
  });
});

describe('selectListLiteTargets：跳过具平台/已确认/在途，上限 20', () => {
  it('仅空 + 未确认 + 非在途入选', () => {
    const rows = [
      { id: 'c/concrete', platforms: ['windows'] },
      { id: 'r/resolved', platforms: [] },
      { id: 'f/flight', platforms: [] },
      { id: 'p/pending', platforms: [] },
    ];
    const guard = createInflightGuard();
    guard.take(['f/flight']);
    const targets = selectListLiteTargets(rows, {
      resolved: new Set(['r/resolved']),
      inflight: guard,
    });
    expect(targets).toEqual([{ key: 'p/pending', liteId: 'p/pending' }]);
  });

  it('超过 20 截断（与榜单 selectLiteTargets 同上限）', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `p/${i}`, platforms: [] as string[] }));
    const targets = selectListLiteTargets(rows, {
      resolved: new Set<string>(),
      inflight: createInflightGuard(),
    });
    expect(targets).toHaveLength(20);
  });
});

describe('runLiteBatch：经同一口分批确认', () => {
  it('非空治愈进 patched，空非 stale 进 confirmedEmpty，stale/失败保持 pending', async () => {
    const { patched, confirmedEmpty } = await runLiteBatch(
      [
        { key: 'c/ok', liteId: 'c/ok' },
        { key: 'e/empty', liteId: 'e/empty' },
        { key: 's/stale', liteId: 's/stale' },
        { key: 'f/fail', liteId: 'f/fail' },
      ],
      async (liteId) => {
        if (liteId === 'c/ok') return { platforms: ['windows'], is_stale: false };
        if (liteId === 'e/empty') return { platforms: [], is_stale: false };
        if (liteId === 's/stale') return { platforms: [], is_stale: true };
        throw new Error('offline');
      },
    );
    expect(patched.get('c/ok')).toEqual(['windows']);
    expect(confirmedEmpty).toEqual(['e/empty']);
    expect(patched.has('s/stale')).toBe(false);
    expect(patched.has('f/fail')).toBe(false);
  });

  it('shouldAbort 即整批丢弃（seq 过期不写入）', async () => {
    const { patched, confirmedEmpty } = await runLiteBatch(
      [{ key: 'c/ok', liteId: 'c/ok' }],
      async () => ({ platforms: ['windows'], is_stale: false }),
      () => true,
    );
    expect(patched.size).toBe(0);
    expect(confirmedEmpty).toEqual([]);
  });
});

describe('collectListPendingKeys：多列表去重快照', () => {
  it('跳过具平台与已确认，键归一去重', () => {
    const keys = collectListPendingKeys(
      [
        [{ id: 'A/B', platforms: [] }, { id: 'c/c', platforms: ['windows'] }],
        [{ id: 'a/b', platforms: [] }, { id: 'r/r', platforms: [] }],
      ],
      new Set(['r/r']),
    );
    expect(keys).toEqual(['a/b']);
  });
});

describe('scheduleSettleConfirm：15s 后无永久 pending（趋势分支删除回归）', () => {
  it('超时后仍 pending 即确认提交；已治愈的行永不确认', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const cancel = scheduleSettleConfirm({
      keys: ['p/a', 'p/b'],
      recheck: (snapshot) => snapshot.filter((k) => k !== 'p/b'),
      onConfirm,
    });
    expect(onConfirm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toEqual(['p/a']);
    cancel();
  });

  it('全部落定则不提交；卸载取消后永不提交', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const noop = scheduleSettleConfirm({ keys: [], recheck: (k) => [...k], onConfirm });
    noop();
    const cancel = scheduleSettleConfirm({
      keys: ['p/a'],
      recheck: () => [],
      onConfirm,
    });
    vi.advanceTimersByTime(15_000);
    expect(onConfirm).not.toHaveBeenCalled();
    const cancel2 = scheduleSettleConfirm({
      keys: ['p/a'],
      recheck: (k) => [...k],
      onConfirm,
    });
    cancel2();
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('去重归一后空快照直接返回空清理函数', () => {
    const cancel = scheduleSettleConfirm({
      keys: ['  ', ''],
      recheck: (k) => [...k],
      onConfirm: () => {
        throw new Error('must not fire');
      },
    });
    cancel();
  });
});
