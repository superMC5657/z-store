import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../i18n';

vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

vi.mock('@tauri-apps/plugin-updater', () => ({
  // 拒绝逻辑作为原始实现传入:vi.restoreAllMocks / mockReset 后仍保持
  check: vi.fn(async () => {
    throw new Error('updater check failed');
  }),
}));

import { ClientUpdateRow } from './ClientUpdateRow';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('ClientUpdateRow fallback download link', () => {
  it('renders error message and releases page fallback link when all fetch steps fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
    );

    render(<ClientUpdateRow />);
    const checkBtn = screen.getByRole('button', { name: /检查更新|Check for Updates/ });
    fireEvent.click(checkBtn);

    const link = await waitFor(() => screen.getByRole('link', { name: '前往发布页下载' }));
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://github.com/superMC5657/z-store/releases/latest');
    expect(screen.getByText(/检查客户端更新失败/)).toBeTruthy();
  });

  it('renders manual download version link when manifest is successfully resolved', async () => {
    const fakeManifest = {
      version: '2.0.0',
      platforms: {
        'windows-x86_64': {
          url: 'https://gh-proxy.com/https://github.com/superMC5657/z-store/releases/download/v2.0.0/z-store_2.0.0_x64-setup.exe',
          signature: 'sig-test',
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('latest-cn.json') || url.includes('latest.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => fakeManifest,
          };
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
        };
      }),
    );

    render(<ClientUpdateRow />);
    const checkBtn = screen.getByRole('button', { name: /检查更新|Check for Updates/ });
    fireEvent.click(checkBtn);

    const link = await waitFor(() => screen.getByRole('link', { name: '手动下载 2.0.0' }));
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe(
      'https://gh-proxy.com/https://github.com/superMC5657/z-store/releases/download/v2.0.0/z-store_2.0.0_x64-setup.exe',
    );
  });
});
