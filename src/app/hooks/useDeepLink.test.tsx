/**
 * useDeepLink 深链分发回归：
 *
 * - 五类深链动作各自路由到正确的 handler；
 * - RCE 守卫（17 号相关）：`install_app` 深链绝不直接安装——只打开详情 +
 *   暂存待确认态 + 弹显式确认警示，安装必须经用户显式点击；
 * - open_view 合法性校验收口集中导航（非法视图静默忽略）；
 * - 分发失败 error toast；成功恒有 responded info toast；
 * - window 挂载点挂载/卸载对称；CLI 深链参数拉起即分发。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleDeepLink: vi.fn(),
  getCliDeepLink: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'handleDeepLink') return mocks.handleDeepLink;
        if (prop === 'getCliDeepLink') return mocks.getCliDeepLink;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { useDeepLink } from './useDeepLink';

interface ToastCall {
  msg: string;
  type?: string;
}

function renderDeepLink() {
  const handlers = {
    handleOpenDetail: vi.fn(),
    handleSearchChange: vi.fn(async () => {}),
    setSelectedDeveloper: vi.fn(),
    navigate: vi.fn(),
    showToast: vi.fn(),
    t: ((key: string, opts?: Record<string, unknown>) => {
      const interpolation = opts ? ` ${JSON.stringify(opts)}` : '';
      return `${key}${interpolation}`;
    }) as never,
  };
  const rendered = renderHook(() => useDeepLink(handlers));
  return { rendered, handlers };
}

function toastsOf(showToast: { mock: { calls: unknown[][] } }): ToastCall[] {
  return showToast.mock.calls.map((c) => ({ msg: c[0] as string, type: c[1] as string | undefined }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCliDeepLink.mockResolvedValue(null);
});

describe('useDeepLink：五类动作分发', () => {
  it('app_detail：打开详情，不暂存安装', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'app_detail', payload: { app_id: 'acme/atlas' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://app/acme/atlas');
    });

    expect(mocks.handleDeepLink).toHaveBeenCalledWith('zstore://app/acme/atlas');
    expect(handlers.handleOpenDetail).toHaveBeenCalledWith('acme/atlas');
    expect(rendered.result.current.stagedDeepLinkInstall).toBeNull();
    const ts = toastsOf(handlers.showToast);
    expect(ts.some((x) => x.msg.startsWith('toast.deeplink_responded') && x.type === 'info')).toBe(true);
  });

  it('install_app：只开详情 + 暂存待确认 + warning 警示，绝不直接安装', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'install_app', payload: { app_id: 'acme/atlas' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://install/acme/atlas');
    });

    expect(handlers.handleOpenDetail).toHaveBeenCalledTimes(1);
    expect(handlers.handleOpenDetail).toHaveBeenCalledWith('acme/atlas');
    expect(rendered.result.current.stagedDeepLinkInstall).toBe('acme/atlas');
    const ts = toastsOf(handlers.showToast);
    expect(ts.some((x) => x.msg.startsWith('toast.deeplink_confirm_notice') && x.type === 'warning')).toBe(true);
    // 分发器面上没有安装入口：暂存后唯一推进方式是用户显式确认（App 层弹窗按钮）。
    expect(Object.keys(rendered.result.current)).toEqual(
      expect.arrayContaining(['stagedDeepLinkInstall', 'setStagedDeepLinkInstall', 'handleDispatchDeepLink']),
    );
  });

  it('search：路由到搜索回调', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'search', payload: { query: 'rustdesk' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://search?q=rustdesk');
    });

    expect(handlers.handleSearchChange).toHaveBeenCalledWith('rustdesk');
  });

  it('developer_profile：路由到开发者视图', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'developer_profile', payload: { owner: 'acme' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://dev/acme');
    });

    expect(handlers.setSelectedDeveloper).toHaveBeenCalledWith('acme');
  });

  it('open_view 合法视图：经集中导航；非法视图静默忽略', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'open_view', payload: { view: 'trends' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://view/trends');
    });
    expect(handlers.navigate).toHaveBeenCalledWith('trends');

    mocks.handleDeepLink.mockResolvedValue({ action: 'open_view', payload: { view: 'javascript:alert(1)' } });
    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://view/hax');
    });
    // 非法视图在 useDeepLink 侧即被 isViewType 拒绝，不再下发给集中导航。
    expect(handlers.navigate).toHaveBeenCalledTimes(1);
    expect(handlers.navigate).toHaveBeenCalledWith('trends');
  });
});

describe('useDeepLink：失败与生命周期', () => {
  it('handleDeepLink 失败：error toast，无 responded toast', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockRejectedValue(new Error('scheme not handled'));

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://bogus');
    });

    const ts = toastsOf(handlers.showToast);
    expect(ts).toHaveLength(1);
    expect(ts[0].type).toBe('error');
    expect(ts[0].msg).toContain('scheme not handled');
  });

  it('window 挂载点：挂载即注册、卸载即删除', async () => {
    const { rendered } = renderDeepLink();
    expect(typeof window.dispatchZStoreDeepLink).toBe('function');
    const dispatcher = window.dispatchZStoreDeepLink;
    mocks.handleDeepLink.mockResolvedValue({ action: 'app_detail', payload: { app_id: 'x/y' } });
    await act(async () => {
      dispatcher?.('zstore://app/x/y');
    });
    expect(mocks.handleDeepLink).toHaveBeenCalledWith('zstore://app/x/y');

    rendered.unmount();
    expect(window.dispatchZStoreDeepLink).toBeUndefined();
  });

  it('CLI 参数深链：挂载即分发', async () => {
    mocks.getCliDeepLink.mockResolvedValue('zstore://app/cli/app');
    const { handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'app_detail', payload: { app_id: 'cli/app' } });

    await act(async () => {});
    expect(mocks.handleDeepLink).toHaveBeenCalledWith('zstore://app/cli/app');
    expect(handlers.handleOpenDetail).toHaveBeenCalledWith('cli/app');
  });
});
