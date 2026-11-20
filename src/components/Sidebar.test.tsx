/** 测试侧边栏导航分组顺序及设备平台多选筛选交互。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { Sidebar } from './Sidebar';
import { parseSelectedPlatformArray, togglePlatformSet } from '../lib/platformFilter';
import { VIEW_TYPES } from '../types';

afterEach(() => {
  cleanup();
});

function renderSidebar(extraProps?: Partial<React.ComponentProps<typeof Sidebar>>) {
  return render(
    <Sidebar
      currentView="home"
      onSelectView={() => {}}
      onOpenAccount={() => {}}
      {...extraProps}
    />,
  );
}

function groupTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.nav-group-title')).map(
    (el) => el.textContent ?? '',
  );
}

describe('baseline: Sidebar nav groups (Sidebar.tsx slices)', () => {
  it('renders 发现 first, 管理 second, 系统 last', () => {
    const { container } = renderSidebar();
    const titles = groupTitles(container);
    expect(titles[0]).toBe('发现');
    expect(titles[1]).toBe('管理');
    expect(titles[titles.length - 1]).toBe('系统');
  });
});

const EXPECTED_PLATFORMS: Array<{ id: string; label: string }> = [
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'ios', label: 'iOS' },
  { id: 'android', label: 'Android' },
  { id: 'other', label: '其他' },
];

describe('Sidebar: 设备平台 multi-select group', () => {
  it('renders the 设备平台 group with 6 checkbox items, labels and counts', () => {
    renderSidebar({
      selectedPlatforms: new Set(['windows', 'android', 'macos', 'linux', 'ios', 'other']),
      onTogglePlatform: () => {},
      platformCounts: { windows: 12, android: 7, macos: 5, linux: 9, ios: 3, other: 4 },
    });
    expect(screen.getByText('平台')).toBeTruthy();
    for (const { id, label } of EXPECTED_PLATFORMS) {
      const item = screen.getByRole('checkbox', { name: new RegExp(label) });
      expect(item.getAttribute('data-platform-id')).toBe(id);
      expect(item.getAttribute('aria-checked')).toBe('true');
    }
    // 计数复用现有的导航徽标样式
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('reflects selection via aria-checked', () => {
    renderSidebar({
      selectedPlatforms: new Set(['windows', 'linux']),
      onTogglePlatform: () => {},
    });
    expect(
      screen.getByRole('checkbox', { name: /Windows/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByRole('checkbox', { name: /Linux/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByRole('checkbox', { name: /Android/ }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByRole('checkbox', { name: /macOS/ }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByRole('checkbox', { name: /iOS/ }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('calls back on toggle, even for the last remaining checked item (guard lives in App)', () => {
    const onTogglePlatform = vi.fn();
    renderSidebar({
      selectedPlatforms: new Set(['windows']),
      onTogglePlatform,
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Windows/ }));
    expect(onTogglePlatform).toHaveBeenCalledTimes(1);
    expect(onTogglePlatform).toHaveBeenCalledWith('windows');
  });

  it('items are keyboard-focusable native buttons', () => {
    renderSidebar({
      selectedPlatforms: new Set(['windows']),
      onTogglePlatform: () => {},
    });
    const item = screen.getByRole('checkbox', { name: /Android/ });
    expect(item.tagName).toBe('BUTTON');
    (item as HTMLElement).focus();
    expect(document.activeElement).toBe(item);
  });

  it('sits above the 偏好与系统 group and collapses like existing groups', () => {    const { container } = renderSidebar({
      selectedPlatforms: new Set(['windows']),
      onTogglePlatform: () => {},
    });
    const titles = groupTitles(container);
    expect(titles).toEqual(['发现', '管理', '平台', '系统']);

    const { container: collapsed } = renderSidebar({
      selectedPlatforms: new Set(['windows']),
      onTogglePlatform: () => {},
      isCollapsed: true,
    });
    expect(collapsed.querySelector('.sidebar.collapsed')).toBeTruthy();
    const item = within(collapsed as HTMLElement).getByRole('checkbox', {
      name: /Windows/,
    });
    expect(item.getAttribute('title')).toBe('Windows');
  });
});

describe('Sidebar: Decision B select-nothing (empty is valid, never falls back to all)', () => {
  it('empty selection renders all five items unchecked', () => {
    renderSidebar({
      selectedPlatforms: parseSelectedPlatformArray([]),
      onTogglePlatform: () => {},
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    for (const { label } of EXPECTED_PLATFORMS) {
      expect(
        screen.getByRole('checkbox', { name: new RegExp(label) }).getAttribute('aria-checked'),
      ).toBe('false');
    }
  });

  it('unknown-only persisted selection restores to all-unchecked (no fallback-to-all)', () => {
    renderSidebar({
      selectedPlatforms: parseSelectedPlatformArray(['amigaos']),
      onTogglePlatform: () => {},
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    for (const { label } of EXPECTED_PLATFORMS) {
      expect(
        screen.getByRole('checkbox', { name: new RegExp(label) }).getAttribute('aria-checked'),
      ).toBe('false');
    }
  });

  it('toggling off the last checked item yields the empty set via togglePlatformSet', () => {
    const onTogglePlatform = vi.fn();
    renderSidebar({
      selectedPlatforms: parseSelectedPlatformArray(['windows']),
      onTogglePlatform,
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Windows/ }));
    expect(onTogglePlatform).toHaveBeenCalledWith('windows');
    // 提交的下一状态为代表不选任何平台的空 Set，绝非拒绝操作
    expect(togglePlatformSet(parseSelectedPlatformArray(['windows']), 'windows').size).toBe(0);
  });
});

describe('Sidebar: nav items follow VIEW_TYPES', () => {
  it('导航项逐项来自 VIEW_TYPES（数量与顺序一致）', () => {
    const { container } = renderSidebar();
    const ids = Array.from(container.querySelectorAll('.nav-item')).map((el) =>
      el.getAttribute('data-view-id'),
    );
    expect(ids).toEqual([...VIEW_TYPES]);
  });

  it('点击任意导航项回调对应 ViewType', () => {
    const onSelectView = vi.fn();
    const { container } = renderSidebar({ onSelectView });
    for (const id of VIEW_TYPES) {
      fireEvent.click(container.querySelector(`[data-view-id="${id}"]`) as HTMLElement);
    }
    expect(onSelectView.mock.calls.map((call) => call[0])).toEqual([...VIEW_TYPES]);
  });
});

describe('Sidebar: updates and favorites numerical badges', () => {
  it('renders the update count on My Apps and favorites badge, without blue dot', () => {
    const { container } = renderSidebar({
      updatesCount: 7,
      favoritesCount: 15,
      pendingCount: 5,
    });

    const favoritesItem = container.querySelector('[data-view-id="favorites"]');
    const installedItem = container.querySelector('[data-view-id="installed"]');
    const pendingItem = container.querySelector('[data-view-id="pending"]');

    // 可用更新数挂在「我的应用」上，侧栏没有单独的更新入口
    expect(container.querySelector('[data-view-id="updates"]')).toBeNull();
    expect(installedItem?.querySelector('.count-badge')?.textContent).toBe('7');
    expect(favoritesItem?.querySelector('.count-badge')?.textContent).toBe('15');
    expect(pendingItem?.querySelector('.count-badge')?.textContent).toBe('5');

    // 验证不渲染圆点指示器
    expect(container.querySelector('.nav-badge-dot')).toBeNull();
    expect(container.querySelector('.nav-icon-badge-dot')).toBeNull();
  });

  it('does not render badge when updatesCount or favoritesCount is 0', () => {
    const { container } = renderSidebar({
      updatesCount: 0,
      favoritesCount: 0,
    });

    const installedItem = container.querySelector('[data-view-id="installed"]');
    const favoritesItem = container.querySelector('[data-view-id="favorites"]');

    expect(installedItem?.querySelector('.count-badge')).toBeNull();
    expect(favoritesItem?.querySelector('.count-badge')).toBeNull();
    expect(container.querySelector('.nav-badge-dot')).toBeNull();
  });
});
