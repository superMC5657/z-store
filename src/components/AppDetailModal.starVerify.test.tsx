/**
 * 标星与所有权校验特征化测试（用于从 AppDetailModal 拆分出 useDetailStarVerify 前的防劣化保护）。
 *
 * 在模块拆分前通过真实组件路径锁定详情弹窗的 GitHub Star 切换及所有权校验提交契约。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { AppDetailViewModel, OAuthUser } from '../types';

const APP_ID = 'testowner/testrepo';

const hooks = vi.hoisted(() => ({
  isStarred: vi.fn(async (_id: string) => false),
  starApp: vi.fn(async (_id: string) => ({ starred: true, in_list: true })),
  verifyOwnership: vi.fn(async (_id: string, _code: string) => true),
  onRefresh: vi.fn(async (_id: string) => {}),
}));

vi.mock('../services/api', () => {
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'isStarred') return (id: string) => hooks.isStarred(id);
        if (prop === 'starApp') return (id: string) => hooks.starApp(id);
        if (prop === 'verifyOwnership') return (id: string, code: string) => hooks.verifyOwnership(id, code);
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { api };
});

import { AppDetailModal } from './AppDetailModal';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixtureApp(): AppDetailViewModel {
  return {
    id: APP_ID,
    name: 'Star Verify Fixture',
    owner: 'testowner',
    repo: 'testrepo',
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'fixture for star/verify characterization',
    stars: 10,
    forks: 1,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: false,
    readme_markdown: '# Hello',
    releases: [],
    category: 'system',
    category_name: '应用',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    isLoading: false,
  };
}

function fixtureUser(): OAuthUser {
  return { login: 'testowner', has_list_scope: true, is_expired: false };
}

function collectToasts(): string[] {
  const texts: string[] = [];
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { text?: string } | undefined;
    if (detail?.text) texts.push(detail.text);
  };
  window.addEventListener('zstore:toast', handler);
  return texts;
}

describe('star/verify characterization (real AppDetailModal path)', () => {
  it('star toggle calls api.starApp and toasts success', async () => {
    const toasts = collectToasts();
    render(
      <AppDetailModal
        app={fixtureApp()}
        isInstalled={false}
        oauthUser={fixtureUser()}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );
    await waitFor(() => {
      expect(hooks.isStarred).toHaveBeenCalledWith(APP_ID);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'GitHub 收藏 (Star)' }));
    });
    await waitFor(() => {
      expect(hooks.starApp).toHaveBeenCalledWith(APP_ID);
    });
    expect(screen.getByRole('button', { name: '取消 GitHub 收藏' })).toBeTruthy();
    expect(toasts.some((t) => t.includes('标星'))).toBe(true);
  });

  it('ownership verify submit calls api.verifyOwnership then onRefresh', async () => {
    const toasts = collectToasts();
    render(
      <AppDetailModal
        app={fixtureApp()}
        isInstalled={false}
        oauthUser={fixtureUser()}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
        onRefresh={hooks.onRefresh}
      />,
    );
    await waitFor(() => {
      expect(hooks.isStarred).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText(/您是该仓库所有者/));
    const input = screen.getByPlaceholderText(/zstore-verify-xxxx/);
    fireEvent.change(input, { target: { value: 'zstore-verify-abc123' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交验证' }));
    });

    await waitFor(() => {
      expect(hooks.verifyOwnership).toHaveBeenCalledWith(APP_ID, 'zstore-verify-abc123');
    });
    await waitFor(() => {
      expect(hooks.onRefresh).toHaveBeenCalledWith(APP_ID);
    });
    expect(toasts.some((t) => t.includes('所有权验证通过'))).toBe(true);
  });
});
