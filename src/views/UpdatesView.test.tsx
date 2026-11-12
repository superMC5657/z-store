/**
 * UpdatesView 重构交互与渲染契约测试（Issue 03 & 05）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { UpdatesView } from './UpdatesView';
import type { AppSummary, UpdateItem, WatchUpdatedPayload } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const UPDATES: UpdateItem[] = [
  {
    app_id: 'motrix/motrix',
    app_name: 'Motrix',
    current_version: '1.8.19',
    latest_version: 'v2.4.1',
    changelog: '### Highlights\n- Faster aria2 engine',
    icon: 'https://example.com/motrix.png',
    icon_bg: '#5e6ad2',
  },
  {
    app_id: 'wez/wezterm',
    app_name: 'WezTerm',
    current_version: '20260716',
    latest_version: '20240203',
    changelog: '',
  },
];

const CATALOG_APPS: AppSummary[] = [
  {
    id: 'wez/wezterm',
    name: 'WezTerm',
    owner: 'wez',
    repo: 'wezterm',
    icon: 'https://example.com/wezterm.png',
    icon_bg: '#141516',
    description: 'GPU terminal',
    stars: 1000,
    forks: 100,
    license: 'MIT',
    latest_version: '20240203',
    category: 'ops',
    category_name: '运维终端',
    is_verified: true,
    forge: 'codeberg',
    forge_host: 'codeberg.org',
    homepage: null,
    platforms: ['windows'],
  },
];

const WATCH_ITEMS: WatchUpdatedPayload[] = [
  {
    app_id: 'rustdesk/rustdesk',
    app_name: 'RustDesk',
    version: 'v1.5.0',
  },
];

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

describe('UpdatesView redesigned workbench', () => {
  it('renders aligned version diff chips, contain-fitted icons, and outline row upgrade buttons', () => {
    const { container } = render(
      <UpdatesView
        updates={UPDATES}
        apps={CATALOG_APPS}
        updateRulesCount={2}
        onOpenRules={() => {}}
        onCheckUpdates={async () => {}}
        onApplyUpdate={async () => {}}
        onBatchUpdateAll={async () => {}}
      />,
    );

    expect(screen.getByText('1.8.19')).toBeTruthy();
    expect(screen.getByText('v2.4.1')).toBeTruthy();
    expect(screen.getByText('motrix/motrix')).toBeTruthy();
    expect(screen.getByText('codeberg.org')).toBeTruthy();

    // 图标采用 AppIconFrame + fit="contain" 防裁切
    const imgs = container.querySelectorAll('.app-icon-frame img') as NodeListOf<HTMLImageElement>;
    expect(imgs.length).toBe(2);
    expect(imgs[0].style.objectFit).toBe('contain');

    // 仅顶部「全部更新 (2)」为 btn-primary，行内升级按钮使用 outline 样式（无白块墙）
    const primaryButtons = container.querySelectorAll('button.btn-primary');
    expect(primaryButtons.length).toBe(1);
    expect(primaryButtons[0].textContent).toContain('全部更新 (2)');
    expect(container.querySelectorAll('button.manage-btn-action').length).toBe(2);
  });

  it('expands markdown changelog and shows empty fallback note when changelog is empty', () => {
    const onOpenWatchedApp = vi.fn();
    render(
      <UpdatesView
        updates={UPDATES}
        apps={CATALOG_APPS}
        onOpenWatchedApp={onOpenWatchedApp}
        onApplyUpdate={async () => {}}
        onBatchUpdateAll={async () => {}}
      />,
    );

    const logButtons = screen.getAllByRole('button', { name: /查看日志/ });
    // 第一项有 Markdown 更新日志
    fireEvent.click(logButtons[0]);
    expect(screen.getByText('Faster aria2 engine')).toBeTruthy();
    expect(screen.getByText('1.8.19 → v2.4.1 发布说明')).toBeTruthy();

    // 点击抽屉内「查看详情」触发回调
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(onOpenWatchedApp).toHaveBeenCalledWith('motrix/motrix');

    // 第二项 changelog 为空，展开后展示占位说明而非空白无反馈
    fireEvent.click(screen.getAllByRole('button', { name: /查看日志/ })[0]);
    expect(
      screen.getByText('该版本未提供发布日志，可打开应用详情查看仓库 Release。'),
    ).toBeTruthy();
  });

  it('filters updates by search query and switches between Updates and Watched tabs', () => {
    render(
      <UpdatesView
        updates={UPDATES}
        apps={CATALOG_APPS}
        watchNotifications={WATCH_ITEMS}
        onOpenWatchedApp={() => {}}
        onDismissWatch={() => {}}
        onApplyUpdate={async () => {}}
        onBatchUpdateAll={async () => {}}
      />,
    );

    // 搜索过滤
    const searchInput = screen.getByPlaceholderText('筛选待更新应用...');
    fireEvent.change(searchInput, { target: { value: 'Motrix' } });
    expect(screen.getByText('Motrix')).toBeTruthy();
    expect(screen.queryByText('WezTerm')).toBeNull();

    // 清空回到全量并切至「关注动态」标签
    fireEvent.change(searchInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: /关注动态/ }));
    expect(screen.getByText('RustDesk')).toBeTruthy();
    expect(screen.queryByText('Motrix')).toBeNull();

    // 在「关注动态」标签搜索无命中时渲染筛选空态并可一键重置
    fireEvent.change(searchInput, { target: { value: 'non-existent' } });
    expect(screen.getByText('没有匹配的待更新应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(screen.getByText('Motrix')).toBeTruthy();
    expect(screen.getByText('RustDesk')).toBeTruthy();
  });

  it('renders streaming check progress banner with percentage fill', () => {
    const { container } = render(
      <UpdatesView
        updates={UPDATES}
        isChecking={true}
        checkProgress={{ checked: 3, total: 6, app_id: 'motrix/motrix', app_name: 'Motrix' }}
        onApplyUpdate={async () => {}}
        onBatchUpdateAll={async () => {}}
      />,
    );

    expect(screen.getByText('50%')).toBeTruthy();
    const fill = container.querySelector('.manage-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });
});
