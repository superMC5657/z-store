/** 测试 `useDeepLink` 深链路由分发、安装确认门禁与生命周期清理。 */
import { StrictMode } from 'react';
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

function renderDeepLink(options: { strict?: boolean } = {}) {
  const handlers = {
    handleOpenDetail: vi.fn(),
    handleSearchChange: vi.fn(async () => {}),
    setSelectedDeveloper: vi.fn(),
    navigate: vi.fn(),
    focusView: vi.fn(),
    onFocusLaunchpadApp: vi.fn(),
    openCollection: vi.fn(),
    showToast: vi.fn(),
    t: ((key: string, opts?: Record<string, unknown>) => {
      const interpolation = opts ? ` ${JSON.stringify(opts)}` : '';
      return `${key}${interpolation}`;
    }) as never,
  };
  const rendered = renderHook(
    (props: typeof handlers) =>
      useDeepLink({
        routes: {
          navigate: props.navigate,
          openDetail: props.handleOpenDetail,
          search: props.handleSearchChange,
          selectDeveloper: props.setSelectedDeveloper,
          focusView: props.focusView,
          focusLaunchpadApp: props.onFocusLaunchpadApp,
          openCollection: props.openCollection,
        },
        showToast: props.showToast,
        t: props.t,
      }),
    {
      initialProps: handlers,
      ...(options.strict ? { wrapper: StrictMode } : {}),
    },
  );
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
  it('launchpad_app：切至开源广场、定位卡片并打开详情，绝不暂存安装', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'launchpad_app', payload: { app_id: 'acme/hyper-term' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://launchpad/acme/hyper-term');
    });

    expect(handlers.navigate).toHaveBeenCalledWith('launchpad');
    expect(handlers.onFocusLaunchpadApp).toHaveBeenCalledWith('acme/hyper-term');
    expect(handlers.handleOpenDetail).toHaveBeenCalledWith('acme/hyper-term');
    expect(rendered.result.current.stagedDeepLinkInstall).toBeNull();
  });

  it('open_view launchpad：直达开源广场视图', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'open_view', payload: { view: 'launchpad' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://launchpad');
    });

    expect(handlers.navigate).toHaveBeenCalledWith('launchpad');
  });

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
    // 非法视图在 useDeepLink 侧即被 resolveViewTarget 拒绝，不下发给集中导航。
    expect(handlers.navigate).toHaveBeenCalledTimes(1);
    expect(handlers.navigate).toHaveBeenCalledWith('trends');
    expect(handlers.focusView).not.toHaveBeenCalled();
  });

  it('open_view updates 别名：进入我的应用并落在「有更新」签', async () => {
    const { rendered, handlers } = renderDeepLink();
    mocks.handleDeepLink.mockResolvedValue({ action: 'open_view', payload: { view: 'updates' } });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink('zstore://view/updates');
    });
    expect(handlers.navigate).toHaveBeenCalledWith('installed');
    expect(handlers.focusView).toHaveBeenCalledWith('updates');
  });

  it('collection：触发 openCollection 预览，绝不暂存自动安装', async () => {
    const { rendered, handlers } = renderDeepLink();
    const payload = {
      title: 'Rust 装机',
      note: '开发必备',
      app_ids: ['rustdesk/rustdesk', 'localsend/localsend'],
    };
    mocks.handleDeepLink.mockResolvedValue({ action: 'collection', payload });

    await act(async () => {
      await rendered.result.current.handleDispatchDeepLink(
        'zstore://collection?title=Rust+%E8%A3%85%E6%9C%BA&ids=rustdesk/rustdesk,localsend/localsend',
      );
    });

    expect(handlers.openCollection).toHaveBeenCalledWith(payload);
    expect(handlers.handleOpenDetail).not.toHaveBeenCalled();
    expect(rendered.result.current.stagedDeepLinkInstall).toBeNull();
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

  it('StrictMode 双挂载与父组件重渲染不会重复读取或派发 CLI 深链', async () => {
    mocks.getCliDeepLink.mockResolvedValue('zstore://app/cli/once');
    mocks.handleDeepLink.mockResolvedValue({ action: 'app_detail', payload: { app_id: 'cli/once' } });
    const { rendered, handlers } = renderDeepLink({ strict: true });

    await act(async () => {});
    // 模拟父组件状态变更导致传入新的回调引用重渲染
    const nextHandlers = { ...handlers, navigate: vi.fn() };
    rendered.rerender(nextHandlers);
    await act(async () => {});

    expect(mocks.getCliDeepLink).toHaveBeenCalledTimes(1);
    expect(mocks.handleDeepLink).toHaveBeenCalledTimes(1);
    expect(handlers.handleOpenDetail).toHaveBeenCalledTimes(1);
  });
});
