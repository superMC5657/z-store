/**
 * InstalledView 交互与契约测试。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { InstalledView } from './InstalledView';
import type { InstalledApp, UpdateItem, UpdateRule } from '../types';
import {
  buildRulesMap,
  buildUpdatesMap,
  inferInstalledFallbackPlatforms,
  selectUpdatableInstalled,
} from './manage/manageModel';
import {
  resolveInstalledPlatformRows,
  selectPlatformFilteredInstalled,
  selectPlatformFilteredUpdates,
} from '../app/selectors';
import { makeApp } from './test-utils/filterFixture';

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

const UPDATES: UpdateItem[] = [
  {
    app_id: 'neovim/neovim',
    app_name: 'Neovim',
    current_version: 'v0.12.6',
    latest_version: 'v0.13.0',
    changelog: '### Highlights\n- Faster startup',
  },
];

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

describe('InstalledView redesigned workbench', () => {
  it('keeps Check Updates as the single primary CTA when nothing needs updating', () => {
    const { container } = render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updateRules={RULES}
        onLaunch={() => {}}
        onUninstall={() => {}}
        onOpenRules={() => {}}
        onScanSystemApps={() => {}}
        onCheckUpdates={async () => {}}
      />,
    );

    const primaryButtons = container.querySelectorAll('button.btn-primary');
    expect(primaryButtons.length).toBe(1);
    expect(primaryButtons[0].textContent).toContain('检查更新');

    // 顶栏最后一个按钮为「检查更新」；不单列「刷新」按钮
    const headerButtons = container.querySelectorAll('.manage-actions-cluster button');
    expect(headerButtons[headerButtons.length - 1].textContent).toContain('检查更新');
    expect(screen.queryByRole('button', { name: /^刷新$/ })).toBeNull();
    // 导出清单只在设置页，「我的应用」顶栏不提供；无更新时不出现「全部更新」
    expect(screen.queryByRole('button', { name: /导出清单/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部更新' })).toBeNull();

    // 行内「启动」使用 outline 按钮而非白色 btn-primary（已隐藏的 AlphaTool 不在「全部」里）
    expect(container.querySelectorAll('button.manage-btn-action').length).toBe(2);

    // 展示安装方式标签
    expect(screen.getByText('MSI')).toBeTruthy();
    expect(screen.getByText('Portable')).toBeTruthy();
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

    // 「我的应用」不提供「已隐藏」筛选签，已隐藏的应用不在此界面展示
    expect(screen.queryByRole('tab', { name: /已隐藏/ })).toBeNull();
    expect(screen.queryByText('AlphaTool')).toBeNull();

    // 切换到「已锁定」标签
    fireEvent.click(screen.getByRole('tab', { name: /已锁定/ }));
    expect(screen.getByText('scrcpy')).toBeTruthy();
    expect(screen.queryByText('Neovim')).toBeNull();

    // 切回「全部」（计数不含已隐藏）并按名称 A-Z 排序
    fireEvent.click(screen.getByRole('tab', { name: '全部 2' }));
    fireEvent.click(screen.getByRole('button', { name: '最近安装' }));
    expect(screen.getByRole('button', { name: '名称 A–Z' })).toBeTruthy();

    const names = Array.from(container.querySelectorAll('.manage-app-name')).map((el) => el.textContent);
    expect(names).toEqual(['Neovim', 'scrcpy']);

    // 搜索也不会把已隐藏的应用带回「全部」
    fireEvent.change(screen.getByPlaceholderText('筛选名称、仓库或路径...'), { target: { value: 'alpha' } });
    expect(screen.queryByText('AlphaTool')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('筛选名称、仓库或路径...'), { target: { value: '' } });

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

  it('shows version diff, Update action and banner for rows with an available update', async () => {
    const onApplyUpdate = vi.fn(async () => {});
    const onBatchUpdateAll = vi.fn(async () => {});
    const { container } = render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updates={UPDATES}
        onApplyUpdate={onApplyUpdate}
        onBatchUpdateAll={onBatchUpdateAll}
        onCheckUpdates={async () => {}}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );

    // 版本差就地呈现，行内主按钮换为「更新」，其余两行仍是「启动」
    expect(screen.getByText('v0.12.6')).toBeTruthy();
    expect(screen.getByText('v0.13.0')).toBeTruthy();
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '启动' }).length).toBe(2);

    // 「全部更新」在顶栏末尾并占主色，检查更新为次级，不渲染顶部更新横幅
    const primaryButtons = container.querySelectorAll('button.btn-primary');
    expect(primaryButtons.length).toBe(1);
    expect(primaryButtons[0].textContent).toBe('全部更新');
    const headerButtons = container.querySelectorAll('.manage-actions-cluster button');
    expect(headerButtons[headerButtons.length - 1].textContent).toBe('全部更新');
    expect(screen.queryByText('有新版本可用')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(onApplyUpdate).toHaveBeenCalledWith('neovim/neovim'));

    fireEvent.click(screen.getByRole('button', { name: '全部更新' }));
    await waitFor(() => expect(onBatchUpdateAll).toHaveBeenCalled());

    // 「有更新」筛选签仅留可更新行
    fireEvent.click(screen.getByRole('tab', { name: '有更新 1' }));
    expect(screen.queryByText('scrcpy')).toBeNull();
    expect(screen.getByText('Neovim')).toBeTruthy();
  });

  it('expands the changelog drawer and offers launch and skip in the more menu', async () => {
    const onSkipVersion = vi.fn(async () => {});
    const onLaunch = vi.fn();
    render(
      <InstalledView
        installedApps={[INSTALLED_LIST[0]]}
        updates={[UPDATES[0], { ...UPDATES[0], app_id: 'other/app', changelog: '' }]}
        onApplyUpdate={async () => {}}
        onSkipVersion={onSkipVersion}
        onLaunch={onLaunch}
        onUninstall={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /查看日志/ }));
    // 抽屉按需分块加载：首次展开需等待分块就绪。
    expect(await screen.findByText('Faster startup')).toBeTruthy();
    expect(screen.getByText('v0.12.6 → v0.13.0 发布说明')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('启动'));
    expect(onLaunch).toHaveBeenCalledWith('neovim/neovim');

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('跳过此版本'));
    await waitFor(() => expect(onSkipVersion).toHaveBeenCalledWith('neovim/neovim', 'v0.13.0'));
  });

  it('shows the up-to-date state on the Updates tab and the streaming progress banner while checking', () => {
    const { container, rerender } = render(
      <InstalledView installedApps={INSTALLED_LIST} updates={[]} onLaunch={() => {}} onUninstall={() => {}} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '有更新 0' }));
    expect(screen.getByText('已是最新版本')).toBeTruthy();

    rerender(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updates={UPDATES}
        isChecking={true}
        checkProgress={{ checked: 3, total: 6, app_id: 'neovim/neovim', app_name: 'Neovim' }}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.getByText('50%')).toBeTruthy();
    const fill = container.querySelector('.manage-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });

  it('uninstalls from the more menu with an inline confirm and keeps the file name of long paths', async () => {
    const onUninstall = vi.fn();
    const { container } = render(
      <InstalledView installedApps={[INSTALLED_LIST[0]]} onLaunch={() => {}} onUninstall={onUninstall} />,
    );

    // 路径拆成可截断的目录段与完整保留的文件名段
    expect(container.querySelector('.manage-path-head')?.textContent).toBe('C:\\Program Files\\Neovim\\bin\\');
    expect(container.querySelector('.manage-path-tail')?.textContent).toBe('nvim.exe');

    // 行内不展示「卸载」，入口在更多菜单
    expect(screen.queryByRole('button', { name: '卸载' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('卸载'));

    // 动作簇就地换成确认 + 取消
    expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }));
    expect(onUninstall).toHaveBeenCalledWith('neovim/neovim');
    expect(screen.getByRole('button', { name: '启动' })).toBeTruthy();
  });

  it('lands on the Updates tab when a focus request arrives and reports it consumed', () => {
    const onFocusConsumed = vi.fn();
    render(
      <InstalledView
        focusUpdates
        onFocusConsumed={onFocusConsumed}
        installedApps={INSTALLED_LIST}
        updates={UPDATES}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.getByRole('tab', { name: '有更新 1' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('scrcpy')).toBeNull();
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });
});

describe('InstalledView counts follow the in-page search and platform filter', () => {
  const LIST: InstalledApp[] = [
    ...INSTALLED_LIST,
    { ...INSTALLED_LIST[0], app_id: 'neo/neo-frozen', app_name: 'NeoFrozen', install_path: '' },
    { ...INSTALLED_LIST[0], app_id: 'neo/neo-hidden', app_name: 'NeoHidden', install_path: '' },
  ];
  const LIST_RULES: UpdateRule[] = [
    ...RULES,
    { app_id: 'neo/neo-frozen', is_frozen: true, is_hidden: false, updated_at: 1 },
    { app_id: 'neo/neo-hidden', is_frozen: false, is_hidden: true, updated_at: 1 },
  ];
  const LIST_UPDATES: UpdateItem[] = [
    UPDATES[0],
    { ...UPDATES[0], app_id: 'genymobile/scrcpy', app_name: 'scrcpy' },
    { ...UPDATES[0], app_id: 'neo/neo-frozen', app_name: 'NeoFrozen' },
  ];

  it('every tab badge equals the rows shown when that tab is picked, with and without a search term', () => {
    const { container } = render(
      <InstalledView
        installedApps={LIST}
        updateRules={LIST_RULES}
        updates={LIST_UPDATES}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );
    const rowCount = () => container.querySelectorAll('.installed-list-row').length;
    const check = (expected: Record<string, number>) => {
      for (const [label, count] of Object.entries(expected)) {
        const tab = screen.getByRole('tab', { name: `${label} ${count}` });
        fireEvent.click(tab);
        expect(rowCount()).toBe(count);
      }
    };

    expect(screen.queryByRole('tab', { name: /已隐藏/ })).toBeNull();
    check({ 全部: 3, 有更新: 1, 已锁定: 2 });

    fireEvent.change(screen.getByPlaceholderText('筛选名称、仓库或路径...'), { target: { value: 'neo' } });
    check({ 全部: 2, 有更新: 1, 已锁定: 1 });
  });

  it('shows a platform-filter empty state with a reset action when every installed app is filtered out', () => {
    const onReset = vi.fn();
    render(
      <InstalledView
        installedApps={[]}
        totalInstalledCount={5}
        onResetPlatformFilter={onReset}
        onScanSystemApps={() => {}}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.queryByText('暂未安装任何应用')).toBeNull();
    expect(screen.getByPlaceholderText('筛选名称、仓库或路径...')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '全部 0' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('reports the platform spread of non-hidden installed apps to the sidebar', () => {
    const onCounts = vi.fn();
    const { unmount } = render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        installedPlatformRows={[
          { id: 'neovim/neovim', platforms: ['windows', 'linux'] },
          { id: 'genymobile/scrcpy', platforms: ['windows'] },
          { id: 'alex/alpha', platforms: ['macos'] },
        ]}
        updateRules={RULES}
        onDisplayPlatformCounts={onCounts}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(onCounts).toHaveBeenLastCalledWith({ windows: 2, macos: 0, linux: 1, ios: 0, android: 0, other: 0 });
    unmount();
    expect(onCounts).toHaveBeenLastCalledWith(null);
  });
});

describe('installed platform filter covers apps outside the catalog', () => {
  const installed = (app_id: string, install_method: string): InstalledApp => ({
    ...INSTALLED_LIST[0],
    app_id,
    app_name: app_id,
    install_method,
  });
  const cataloged = { ...makeApp({ id: 'acme/linux-tool', name: 'LinuxTool', platforms: ['linux'] }) };
  const hiddenCard = { ...makeApp({ id: 'acme/hidden-mac', name: 'HiddenMac', platforms: ['macos'] }) };
  const apps = [
    installed('acme/linux-tool', 'portable_tarball'),
    installed('ACME/Hidden-Mac', 'portable_zip'),
    installed('ghost/uncataloged', 'msi'),
  ];
  const rows = resolveInstalledPlatformRows(
    apps,
    new Map([['acme/linux-tool', cataloged]]),
    new Map([['acme/hidden-mac', hiddenCard]]),
    'windows',
  );

  it('resolves platforms from catalog, then hydrated card, then install method', () => {
    expect(rows).toEqual([
      { id: 'acme/linux-tool', platforms: ['linux'] },
      { id: 'ACME/Hidden-Mac', platforms: ['macos'] },
      { id: 'ghost/uncataloged', platforms: ['windows'] },
    ]);
  });

  it.each<[string[], string[]]>([
    [[], []],
    [['android'], []],
    [['windows'], ['ghost/uncataloged']],
    [['macos', 'linux'], ['acme/linux-tool', 'ACME/Hidden-Mac']],
  ])('selected %j keeps %j', (selected, expected) => {
    const out = selectPlatformFilteredInstalled(apps, rows, new Set(selected), new Set());
    expect(out.map((a) => a.app_id)).toEqual(expected);
    const updates = apps.map((a) => ({ ...UPDATES[0], app_id: a.app_id }));
    const outUpdates = selectPlatformFilteredUpdates(updates, rows, new Set(selected), new Set());
    expect(outUpdates.map((u) => u.app_id)).toEqual(expected);
  });
});

describe('manageModel installed counting rules', () => {
  it('selectUpdatableInstalled skips frozen and hidden apps', () => {
    const updates: UpdateItem[] = INSTALLED_LIST.map((a) => ({
      app_id: a.app_id,
      app_name: a.app_name,
      current_version: '1',
      latest_version: '2',
      changelog: '',
    }));
    const out = selectUpdatableInstalled(INSTALLED_LIST, buildRulesMap(RULES), buildUpdatesMap(updates));
    expect(out.map((u) => u.app_id)).toEqual(['neovim/neovim']);
  });

  it.each([
    ['msi', ['windows']],
    ['setup_exe', ['windows']],
    ['winget', ['windows']],
    ['dmg', ['macos']],
    ['pkg', ['macos']],
    ['deb', ['linux']],
    ['rpm', ['linux']],
    ['appimage', ['linux']],
    ['portable_zip', ['linux']],
    [undefined, ['linux']],
  ])('inferInstalledFallbackPlatforms(%s) on a linux host → %j', (method, expected) => {
    expect(inferInstalledFallbackPlatforms(method, 'linux')).toEqual(expected);
  });

  it('inferInstalledFallbackPlatforms defaults unknown methods to windows', () => {
    expect(inferInstalledFallbackPlatforms('scanned')).toEqual(['windows']);
  });
});

describe('InstalledView share collection entry', () => {
  it('opens CollectionShareModal with non-hidden installed apps when clicking Share List', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <InstalledView
        installedApps={INSTALLED_LIST}
        updateRules={RULES}
        onLaunch={() => {}}
        onUninstall={() => {}}
      />,
    );

    const shareBtn = screen.getByRole('button', { name: '分享清单' });
    fireEvent.click(shareBtn);
    expect(await screen.findByRole('heading', { name: '分享应用合集' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Neovim' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'AlphaTool' })).toBeNull();
  });
});
