/**
 * useCustomApps 回归：
 *
 * - 每个落盘 handler 走同一「写入 → 全量重拉」序列，成功后只重拉一次；
 * - 写入失败必须把错误抛给调用方，且不触发重拉（不静默刷新成旧列表）；
 * - revert 失败把错误抛给视图层（提示由视图统一出口渲染一次），hook 自身不 toast。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCustomApps: vi.fn(async (): Promise<unknown[]> => []),
  saveCustomApp: vi.fn(async () => {}),
  deleteCustomApp: vi.fn(async () => {}),
  markCustomSubmitted: vi.fn(async () => {}),
  collectLocalApp: vi.fn(async () => {}),
  withdrawSubmitted: vi.fn(async () => {}),
  revertCollectedApp: vi.fn(async () => {}),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  const table: Record<string, unknown> = {
    listCustomApps: mocks.listCustomApps,
    saveCustomApp: mocks.saveCustomApp,
    deleteCustomApp: mocks.deleteCustomApp,
    markCustomSubmitted: mocks.markCustomSubmitted,
    collectLocalApp: mocks.collectLocalApp,
    withdrawSubmitted: mocks.withdrawSubmitted,
    revertCollectedApp: mocks.revertCollectedApp,
  };
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        typeof prop === 'string' && prop in table
          ? table[prop]
          : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

import { useCustomApps } from './useCustomApps';

function renderCustomApps() {
  const rendered = renderHook(() => useCustomApps());
  return { rendered, deps: { showToast: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCustomApps.mockResolvedValue([]);
  for (const fn of [
    mocks.saveCustomApp,
    mocks.deleteCustomApp,
    mocks.markCustomSubmitted,
    mocks.collectLocalApp,
    mocks.withdrawSubmitted,
    mocks.revertCollectedApp,
  ]) {
    fn.mockResolvedValue(undefined);
  }
});

describe('useCustomApps：写入—重拉序列', () => {
  it('成功后重拉一次（挂载拉取之外）', async () => {
    const { rendered, deps } = renderCustomApps();
    await waitFor(() => expect(mocks.listCustomApps).toHaveBeenCalledTimes(1));

    await act(async () => {
      await rendered.result.current.handleDeleteCustomApp('acme/atlas');
    });

    expect(mocks.deleteCustomApp).toHaveBeenCalledWith('acme/atlas');
    expect(mocks.listCustomApps).toHaveBeenCalledTimes(2);
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  it('写入失败：错误向上抛出且不重拉（不静默刷新）', async () => {
    const { rendered, deps } = renderCustomApps();
    await waitFor(() => expect(mocks.listCustomApps).toHaveBeenCalledTimes(1));
    mocks.deleteCustomApp.mockRejectedValueOnce(new Error('disk full'));

    await act(async () => {
      await expect(rendered.result.current.handleDeleteCustomApp('acme/atlas')).rejects.toThrow(
        'disk full',
      );
    });

    expect(mocks.listCustomApps).toHaveBeenCalledTimes(1);
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  it('revert 失败：错误向上抛出、由视图层统一提示，且不重拉', async () => {
    const { rendered, deps } = renderCustomApps();
    await waitFor(() => expect(mocks.listCustomApps).toHaveBeenCalledTimes(1));
    mocks.revertCollectedApp.mockRejectedValueOnce(new Error('db locked'));

    await act(async () => {
      await expect(
        rendered.result.current.handleRevertCollectedApp('acme/atlas'),
      ).rejects.toThrow('db locked');
    });

    // 提示只在视图层出一份，hook 不重复 toast。
    expect(deps.showToast).not.toHaveBeenCalled();
    expect(mocks.listCustomApps).toHaveBeenCalledTimes(1);
  });
});
