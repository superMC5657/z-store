import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { OAuthAccountCard } from './OAuthAccountCard';
import { DataBackupRow } from './DataBackupRow';
import { ClientUpdateRow } from './ClientUpdateRow';

vi.mock('../services/api', () => ({
  api: {
    getOAuthUser: async () => null,
    oauthDeviceStart: async () => ({
      device_code: 'dev-123',
      user_code: 'CODE-456',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }),
    oauthDevicePoll: async () => ({ status: 'pending' }),
    oauthLogout: async () => undefined,
    getFavorites: async () => [],
    getWatchedApps: async () => [],
    getSettings: async () => ({}),
    importUserData: async () => ({
      favorites_added: 0,
      watched_added: 0,
      settings_applied: true,
      installed_skipped: 0,
    }),
  },
}));

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

describe('Settings subcomponents i18n verification', () => {
  it('renders OAuthAccountCard in zh-CN and en-US', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(<OAuthAccountCard />);
    expect(screen.getByText('GitHub 账号')).toBeTruthy();
    expect(screen.getByText(/登录后享有 5,000 次\/小时 API 配额/)).toBeTruthy();
    expect(await screen.findByText('登录')).toBeTruthy();
    unmount();

    await i18n.changeLanguage('en-US');
    render(<OAuthAccountCard />);
    expect(screen.getByText('GitHub Account')).toBeTruthy();
    expect(screen.getByText(/Sign in to enjoy 5,000 req\/h API quota/)).toBeTruthy();
    expect(await screen.findByText('Sign In')).toBeTruthy();
  });

  it('renders DataBackupRow in zh-CN and en-US', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(<DataBackupRow />);
    expect(screen.getByText('用户数据备份')).toBeTruthy();
    expect(screen.getByText('导出')).toBeTruthy();
    expect(screen.getByText('导入')).toBeTruthy();
    unmount();

    await i18n.changeLanguage('en-US');
    render(<DataBackupRow />);
    expect(screen.getByText('User Data Backup')).toBeTruthy();
    expect(screen.getByText('Export')).toBeTruthy();
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('renders ClientUpdateRow in zh-CN and en-US', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(<ClientUpdateRow />);
    expect(screen.getByText('客户端自更新')).toBeTruthy();
    expect(screen.getByText('检查更新')).toBeTruthy();
    unmount();

    await i18n.changeLanguage('en-US');
    render(<ClientUpdateRow />);
    expect(screen.getByText('Client Auto-Update')).toBeTruthy();
    expect(screen.getByText('Check for Updates')).toBeTruthy();
  });
});
