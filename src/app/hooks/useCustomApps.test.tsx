/** 测试 `useCustomApps` 的写盘重拉序列与错误传播语义。 */
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
  getLicenseAllowlist: vi.fn(async (): Promise<{ enabled: boolean; allowed: string[] }> => ({
    enabled: true,
    allowed: ['MIT'],
  })),
  getCustomAppPrUrl: vi.fn(async (id: string) => `https://example.com/issues/new?title=${id}`),
  getCustomAppPrPayload: vi.fn(async (id: string) => JSON.stringify({ id })),
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
    getLicenseAllowlist: mocks.getLicenseAllowlist,
    getCustomAppPrUrl: mocks.getCustomAppPrUrl,
    getCustomAppPrPayload: mocks.getCustomAppPrPayload,
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
  mocks.getLicenseAllowlist.mockResolvedValue({ enabled: true, allowed: ['MIT'] });
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

type CustomAppsHook = ReturnType<typeof useCustomApps>;

describe('useCustomApps：落盘后目录同步广播', () => {
  it.each<[string, (h: CustomAppsHook) => Promise<void>]>([
    ['handleRevertCollectedApp', (h) => h.handleRevertCollectedApp('acme/atlas')],
    ['handleDeleteCustomApp', (h) => h.handleDeleteCustomApp('acme/atlas')],
    ['handleCollectLocalApp', (h) => h.handleCollectLocalApp('acme/atlas')],
    ['handleWithdrawSubmitted', (h) => h.handleWithdrawSubmitted('acme/atlas')],
    [
      'handleMarkCustomSubmitted',
      (h) => h.handleMarkCustomSubmitted('acme/atlas', 'https://github.com/acme/atlas/pull/1'),
    ],
  ])('%s 重拉完成后派发 zstore:catalog-synced', async (_name, run) => {
    const { rendered } = renderCustomApps();
    await waitFor(() => expect(mocks.listCustomApps).toHaveBeenCalledTimes(1));
    let reloadsAtSync = -1;
    const synced = vi.fn(() => {
      reloadsAtSync = mocks.listCustomApps.mock.calls.length;
    });
    window.addEventListener('zstore:catalog-synced', synced);
    try {
      await act(async () => {
        await run(rendered.result.current);
      });
    } finally {
      window.removeEventListener('zstore:catalog-synced', synced);
    }
    expect(synced).toHaveBeenCalledTimes(1);
    // 广播时重拉已完成：订阅方据此刷新的目录与 customApps 同代。
    expect(reloadsAtSync).toBe(2);
  });

  it('写入失败不广播目录同步', async () => {
    const { rendered } = renderCustomApps();
    await waitFor(() => expect(mocks.listCustomApps).toHaveBeenCalledTimes(1));
    mocks.deleteCustomApp.mockRejectedValueOnce(new Error('nope'));
    const synced = vi.fn();
    window.addEventListener('zstore:catalog-synced', synced);
    try {
      await act(async () => {
        await expect(rendered.result.current.handleDeleteCustomApp('acme/atlas')).rejects.toThrow(
          'nope',
        );
      });
    } finally {
      window.removeEventListener('zstore:catalog-synced', synced);
    }
    expect(synced).not.toHaveBeenCalled();
  });
});

describe('useCustomApps：移入抑制集 customIds', () => {
  it('合并后端草稿 id（含 owner/repo 别名）与变更事件携带的乐观移入 id', async () => {
    mocks.listCustomApps.mockResolvedValue([
      {
        id: 'acme/atlas',
        item: { id: 'acme/atlas', owner: 'Acme', repo: 'Atlas', platforms: [] },
        status: 'draft',
        pr_url: null,
        created_at: 0,
        updated_at: 0,
        archived: false,
      },
    ]);
    const { rendered } = renderCustomApps();
    await waitFor(() => expect(rendered.result.current.customIds.has('acme/atlas')).toBe(true));
    expect(rendered.result.current.customIds.has('moved/one')).toBe(false);

    const reloadsBefore = mocks.listCustomApps.mock.calls.length;
    act(() => {
      window.dispatchEvent(new CustomEvent('zstore:custom-apps-changed', { detail: { id: 'Moved/One' } }));
    });
    // 乐观集即刻生效，不等后端往返；事件同时触发重拉
    expect(rendered.result.current.customIds.has('moved/one')).toBe(true);
    await waitFor(() => expect(mocks.listCustomApps.mock.calls.length).toBeGreaterThan(reloadsBefore));
  });
});

describe('useCustomApps：协议白名单单飞查询', () => {
  it('并发调用共用一次请求，成功结果被缓存', async () => {
    const { rendered } = renderCustomApps();
    const [a, b] = await Promise.all([
      rendered.result.current.loadLicenseGate(),
      rendered.result.current.loadLicenseGate(),
    ]);
    expect(a).toEqual({ enabled: true, allowed: ['MIT'] });
    expect(b).toBe(a);
    await rendered.result.current.loadLicenseGate();
    expect(mocks.getLicenseAllowlist).toHaveBeenCalledTimes(1);
  });

  it('失败或门禁开但空名单时 fail-closed 返回 null，下次重试', async () => {
    const { rendered } = renderCustomApps();
    mocks.getLicenseAllowlist.mockRejectedValueOnce(new Error('offline'));
    expect(await rendered.result.current.loadLicenseGate()).toBeNull();
    mocks.getLicenseAllowlist.mockResolvedValueOnce({ enabled: true, allowed: [] });
    expect(await rendered.result.current.loadLicenseGate()).toBeNull();
    expect(await rendered.result.current.loadLicenseGate()).toEqual({ enabled: true, allowed: ['MIT'] });
    expect(mocks.getLicenseAllowlist).toHaveBeenCalledTimes(3);
  });
});

describe('useCustomApps：Issue 预填获取', () => {
  it('桌面端经 tauriApi 获取，演示站缺席', async () => {
    const desktop = renderHook(() => useCustomApps({ demoMode: false }));
    expect(await desktop.result.current.getPrUrl?.('acme/atlas')).toContain('acme/atlas');
    expect(await desktop.result.current.getPrPayload?.('acme/atlas')).toBe('{"id":"acme/atlas"}');

    const demo = renderHook(() => useCustomApps({ demoMode: true }));
    expect(demo.result.current.getPrUrl).toBeUndefined();
    expect(demo.result.current.getPrPayload).toBeUndefined();
  });
});
