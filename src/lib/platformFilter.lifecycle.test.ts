/**
 * pending 生命周期收归 `lib/platformFilter` 深模块的 locality 证明。
 *
 * - 行为经 lib 唯一入口覆盖（常量/键归一/并集/富卡行判定/守卫/目标选择/批量/settle）；
 * - `app/selectors` 重导出与 lib 同源（单 seam，无服务中转）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lib from './platformFilter';
import {
  PENDING_SETTLE_MS,
  LITE_BATCH_SIZE,
  LITE_TARGET_CAP,
  collectListPendingKeys,
  createInflightGuard,
  createSeqGuard,
  isEnrichedRowPending,
  normalizePendingKey,
  runLiteBatch,
  scheduleSettleConfirm,
  selectListLiteTargets,
  unionConfirmedSets,
} from './platformFilter';
import { normalizeId } from '../services/normalizeId';
import * as selectors from '../app/selectors';

afterEach(() => {
  vi.useRealTimers();
});

describe('platformFilter 深模块：常量与主列表/榜单同口径', () => {
  it('settle 15s、lite 分批 5、上限 20', () => {
    expect(PENDING_SETTLE_MS).toBe(15_000);
    expect(LITE_BATCH_SIZE).toBe(5);
    expect(LITE_TARGET_CAP).toBe(20);
  });
});

describe('platformFilter 深模块：键归一唯一实现', () => {
  it('normalizePendingKey lower-trim，非字符串归空', () => {
    expect(normalizePendingKey(' A/B ')).toBe('a/b');
    expect(normalizePendingKey('')).toBe('');
    expect(normalizePendingKey(undefined)).toBe('');
    expect(normalizePendingKey(42)).toBe('');
  });

  it('normalizeId（前端唯一口）与 pending 键同值（含 trim）', () => {
    expect(normalizeId(' A/B ')).toBe('a/b');
    expect(normalizeId('A/B')).toBe(normalizePendingKey('A/B'));
    expect(normalizeId(undefined)).toBe('');
  });
});

describe('platformFilter 深模块：confirmed 并集 + 富卡行判定', () => {
  it('unionConfirmedSets 保序去重，缺席集合跳过', () => {
    expect(unionConfirmedSets(undefined, undefined)).toEqual(new Set<string>([]));
    expect(unionConfirmedSets(new Set(['a']), undefined, new Set(['b', 'a']))).toEqual(
      new Set(['a', 'b']),
    );
  });

  it('isEnrichedRowPending：裸行未确认即 pending；具平台恒落定；空行按坐标/id 别名确认', () => {
    expect(isEnrichedRowPending('a/b', undefined, new Set())).toBe(true);
    expect(isEnrichedRowPending('a/b', undefined, new Set(['a/b']))).toBe(false);
    expect(isEnrichedRowPending('a/b', { id: 'a/b', platforms: ['macos'] }, new Set())).toBe(false);
    const emptyAlias = { id: 'A/B', platforms: [] as string[] };
    expect(isEnrichedRowPending('a/b', emptyAlias, new Set())).toBe(true);
    expect(isEnrichedRowPending('a/b', emptyAlias, new Set(['a/b']))).toBe(false);
  });
});

describe('platformFilter 深模块：inflight + seq 守卫', () => {
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

describe('platformFilter 深模块：主列表目标选择 + 快照', () => {
  it('selectListLiteTargets 仅空 + 未确认 + 非在途入选，上限 20', () => {
    const rows = [
      { id: 'c/concrete', platforms: ['windows'] },
      { id: 'r/resolved', platforms: [] as string[] },
      { id: 'f/flight', platforms: [] as string[] },
      { id: 'p/pending', platforms: [] as string[] },
    ];
    const guard = createInflightGuard();
    guard.take(['f/flight']);
    expect(
      selectListLiteTargets(rows, { resolved: new Set(['r/resolved']), inflight: guard }),
    ).toEqual([{ key: 'p/pending', liteId: 'p/pending' }]);

    const many = Array.from({ length: 25 }, (_, i) => ({ id: `p/${i}`, platforms: [] as string[] }));
    expect(
      selectListLiteTargets(many, { resolved: new Set<string>(), inflight: createInflightGuard() }),
    ).toHaveLength(20);
  });

  it('collectListPendingKeys 跳过具平台与已确认，键归一去重', () => {
    expect(
      collectListPendingKeys(
        [
          [{ id: 'A/B', platforms: [] as string[] }, { id: 'c/c', platforms: ['windows'] }],
          [{ id: 'a/b', platforms: [] as string[] }, { id: 'r/r', platforms: [] as string[] }],
        ],
        new Set(['r/r']),
      ),
    ).toEqual(['a/b']);
  });
});

describe('platformFilter 深模块：lite 批量 + settle 定时', () => {
  it('runLiteBatch：非空治愈进 patched，空非 stale 进 confirmedEmpty，stale/失败保持 pending', async () => {
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

  it('runLiteBatch：shouldAbort 即整批丢弃', async () => {
    const { patched, confirmedEmpty } = await runLiteBatch(
      [{ key: 'c/ok', liteId: 'c/ok' }],
      async () => ({ platforms: ['windows'], is_stale: false }),
      () => true,
    );
    expect(patched.size).toBe(0);
    expect(confirmedEmpty).toEqual([]);
  });

  it('scheduleSettleConfirm：15s 后仍 pending 即确认提交；已治愈永不确认', () => {
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
});

describe('locality：selectors 与 lib 同源（单 seam）', () => {
  it('app/selectors 重导出与 lib 同源（单 seam，无服务中转）', () => {
    expect(selectors.PENDING_SETTLE_MS).toBe(lib.PENDING_SETTLE_MS);
    expect(selectors.isEnrichedRowPending).toBe(lib.isEnrichedRowPending);
    expect(selectors.unionConfirmedSets).toBe(lib.unionConfirmedSets);
    // 调用方直引 lib，selectors 不重导出其他别名
    //（键分段书写：全仓零命中为收工标准，此处不断言字面量）
    expect((selectors as Record<string, unknown>)['isPending' + 'For']).toBeUndefined();
    expect((selectors as Record<string, unknown>)['matchSelected' + 'WithPending']).toBeUndefined();
  });
});
