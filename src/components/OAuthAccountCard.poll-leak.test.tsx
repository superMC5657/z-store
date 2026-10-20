/**
 * OAuth 设备码轮询泄漏回归（#17）：
 * - in-flight poll 返回 pending 后 `schedulePoll` 会重排下一轮 timer；
 *   unmount/手动取消后不得再发起新的 `oauth_device_poll`（此前只清当前 timer，
 *   in-flight 返回后在卸载组件里继续重排，轮询泄漏持续到 deadline）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';

const oauthDevicePollMock = vi.fn(async () => ({ status: 'pending' }));

vi.mock('../services/api', () => ({
  tauriApi: {
    getOAuthUser: async () => null,
    oauthDeviceStart: async () => ({
      device_code: 'device-code-1',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    }),
    oauthDevicePoll: (...args: unknown[]) => oauthDevicePollMock(...(args as [])),
    oauthLogout: async () => undefined,
    openUrl: async () => undefined,
  },
}));

import { OAuthAccountCard } from './OAuthAccountCard';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function loginButton(): HTMLElement {
  const label = i18n.t('oauth.login');
  const btn = screen
    .getAllByRole('button')
    .find((b) => (b.textContent ?? '').includes(String(label)));
  if (!btn) throw new Error(`login button not found: ${label}`);
  return btn;
}

async function startSession() {
  // 先冲刷挂载期 loadUser（getOAuthUser 结算后 isLoadingUser=false，登录按钮才出现）
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    fireEvent.click(loginButton());
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(oauthDevicePollMock).toHaveBeenCalledTimes(0);
  // interval=1s：第一轮 poll 触发并返回 pending，重排下一轮
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(oauthDevicePollMock).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  oauthDevicePollMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OAuthAccountCard poll lifecycle', () => {
  it('unmount 后 in-flight poll 返回不再重排下一轮', async () => {
    const { unmount } = render(<OAuthAccountCard />);
    await startSession();

    // 第二轮 poll 已触发且仍在途（pending）时卸载
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(oauthDevicePollMock).toHaveBeenCalledTimes(2);
    unmount();

    // 等在途 promise 结算 + 走完整个 deadline 窗口：不得再发起任何 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(oauthDevicePollMock).toHaveBeenCalledTimes(2);
  });

  it('手动取消会话后 in-flight poll 返回不再重排下一轮', async () => {
    render(<OAuthAccountCard />);
    await startSession();

    const cancelLabel = i18n.t('common.cancel');
    const cancelBtn = screen
      .getAllByRole('button')
      .find((b) => (b.textContent ?? '').includes(String(cancelLabel)));
    expect(cancelBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(cancelBtn as HTMLElement);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(oauthDevicePollMock).toHaveBeenCalledTimes(1);

    // 重新登录：取消标志必须复位，轮询恢复
    await act(async () => {
      fireEvent.click(loginButton());
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(oauthDevicePollMock).toHaveBeenCalledTimes(2);
  });
});
