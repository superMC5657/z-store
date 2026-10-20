/**
 * InstalledView 初始加载错误态测试（Issue 06）。
 *
 * 锁定契约：列表为空且 loadError 非空时呈现错误卡（与空态区分，带重试按钮）；
 * 无错误时维持空态；有数据时错误不抢占列表。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { InstalledView } from './InstalledView';
import type { InstalledApp } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const INSTALLED: InstalledApp = {
  app_id: 'test/demo-app',
  app_name: 'Demo App',
  version: '1.2.0',
  install_path: 'C:/apps/demo',
  installed_at: 1700000000,
  icon: '',
  icon_bg: '#333333',
  install_method: 'installer',
  asset_name: 'demo-setup.exe',
  asset_sha256: '',
};

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

function renderView(props: Partial<React.ComponentProps<typeof InstalledView>> = {}) {
  return render(
    <InstalledView
      installedApps={[]}
      onLaunch={() => {}}
      onUninstall={() => {}}
      {...props}
    />,
  );
}

describe('InstalledView load error state', () => {
  it('shows error card with retry when load fails on empty list', () => {
    const onRetryLoad = vi.fn();
    renderView({ loadError: 'ipc down', onRetryLoad });
    expect(screen.getByText('已装列表加载失败')).toBeTruthy();
    expect(screen.getByText(/ipc down/)).toBeTruthy();
    expect(screen.queryByText('暂无已安装应用')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps the regular empty state when there is no load error', () => {
    renderView();
    expect(screen.getByText('暂无已安装应用')).toBeTruthy();
    expect(screen.queryByText('已装列表加载失败')).toBeNull();
  });

  it('prefers the list over the error card when data is present', () => {
    renderView({ installedApps: [INSTALLED], loadError: 'stale ipc down', onRetryLoad: vi.fn() });
    expect(screen.getByText('Demo App')).toBeTruthy();
    expect(screen.queryByText('已装列表加载失败')).toBeNull();
  });
});
