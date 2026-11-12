/**
 * InstalledView 重构交互与契约测试（Issue 04 & 05）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { InstalledView } from './InstalledView';
import type { InstalledApp, UpdateRule } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const INSTALLED_LIST: InstalledApp[] = [
  {
    app_id: 'neovim/neovim',
    app_name: 'Neovim',
    version: 'v0.12.6',
    installed_at: 1794440000,
    install_method: 'msi',
    install_path: 'C:\\Program Files\\Neovim\\bin\\nvim.exe',
    asset_name: 'nvim-win64.msi',
    asset_sha256: 'abc',
  },
  {
    app_id: 'genymobile/scrcpy',
    app_name: 'scrcpy',
    version: '5.0.1',
    installed_at: 1790000000,
    install_method: 'portable_zip',
    install_path: '',
    asset_name: 'scrcpy.zip',
    asset_sha256: 'def',
  },
  {
    app_id: 'alex/alpha',
    app_name: 'AlphaTool',
    version: '1.0.0',
    installed_at: 1780000000,
    install_method: 'setup_exe',
    install_path: 'C:\\Tools\\Alpha\\alpha.exe',
    asset_name: 'alpha.exe',
    asset_sha256: 'ghi',
  },
];

const RULES: UpdateRule[] = [
  { app_id: 'genymobile/scrcpy', is_frozen: true, is_hidden: false, updated_at: 1790000100 },
  { app_id: 'alex/alpha', is_frozen: false, is_hidden: true, updated_at: 1790000200 },
];

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

describe('InstalledView redesigned workbench', () => {
  it('places primary Scan Local CTA on the right and uses outline Launch buttons on rows', () => {
    const { container } = render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updateRules={RULES}
        updatableIds={new Set(['neovim/neovim'])}
        onLaunch={() => {}}
        onUninstall={() => {}}
        onOpenRules={() => {}}
        onRefresh={() => {}}
        onExportAppsJson={() => {}}
        onScanSystemApps={() => {}}
      />,
    );

    const primaryButtons = container.querySelectorAll('button.btn-primary');
    expect(primaryButtons.length).toBe(1);
    expect(primaryButtons[0].textContent).toContain('扫描本地');

    // 顶栏最后一个按钮为「扫描本地」
    const headerButtons = container.querySelectorAll('.manage-actions-cluster button');
    expect(headerButtons[headerButtons.length - 1].textContent).toContain('扫描本地');

    // 行内「启动」使用 outline 按钮而非白色 btn-primary
    expect(container.querySelectorAll('button.manage-btn-action').length).toBe(3);

    // 展示安装方式标签与可用更新徽标
    expect(screen.getByText('MSI')).toBeTruthy();
    expect(screen.getByText('Portable')).toBeTruthy();
    expect(screen.getByText('有更新')).toBeTruthy();
  });

  it('filters by status tabs, searches by name/path, and toggles sort order', () => {
    const { container } = render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updateRules={RULES}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );

    // 切换到「已锁定」标签
    fireEvent.click(screen.getByRole('tab', { name: /已锁定/ }));
    expect(screen.getByText('scrcpy')).toBeTruthy();
    expect(screen.queryByText('Neovim')).toBeNull();

    // 切换到「路径待探测」标签
    fireEvent.click(screen.getByRole('tab', { name: /路径待探测/ }));
    expect(screen.getByText('scrcpy')).toBeTruthy();
    expect(screen.getByText('未检测到安装路径')).toBeTruthy();

    // 切回「全部」并按名称 A-Z 排序
    fireEvent.click(screen.getByRole('tab', { name: /全部/ }));
    fireEvent.click(screen.getByRole('button', { name: '最近安装' }));
    expect(screen.getByRole('button', { name: '名称 A–Z' })).toBeTruthy();

    const names = Array.from(container.querySelectorAll('.manage-app-name')).map((el) => el.textContent);
    expect(names).toEqual(['AlphaTool', 'Neovim', 'scrcpy']);

    // 搜索过滤 + 空状态重置
    const input = screen.getByPlaceholderText('筛选名称、仓库或路径...');
    fireEvent.change(input, { target: { value: 'does-not-exist' } });
    expect(screen.getByText('没有匹配的已安装应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(screen.getByText('Neovim')).toBeTruthy();
  });

  it('copies install path via integrated path chip without throwing and opens detail from menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const onOpenDetail = vi.fn();

    render(
      <InstalledView
        installedApps={[INSTALLED_LIST[0]]}
        onOpenDetail={onOpenDetail}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );

    const pathChip = screen.getByRole('button', { name: '点击复制安装路径' });
    fireEvent.click(pathChip);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('C:\\Program Files\\Neovim\\bin\\nvim.exe');
    });
    expect(screen.getByText('已复制')).toBeTruthy();

    // 打开更多菜单并点击「查看应用详情」
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('查看应用详情'));
    expect(onOpenDetail).toHaveBeenCalledWith('neovim/neovim');
  });
});
