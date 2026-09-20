/**
 * Task 2 — Sidebar device-platform multi-select group.
 *
 * SECTION A (baseline characterization): pins the CURRENT group titles/order
 * rendered by src/components/Sidebar.tsx. Passes on unchanged code:
 *   发现与探索 (first) → 应用资产 → 偏好与系统 (last).
 * Written order-flexibly so it keeps passing after the new 设备平台 group
 * is inserted above 偏好与系统.
 *
 * SECTION B (new multi-select spec): requires the 设备平台 group with 5
 * checkbox-semantics items. FAILS on unchanged code (no such group).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { Sidebar } from './Sidebar';
import { parseSelectedPlatformArray, togglePlatformSet } from '../lib/platformFilter';

afterEach(() => {
  cleanup();
});

function renderSidebar(extraProps?: Partial<React.ComponentProps<typeof Sidebar>>) {
  return render(
    <Sidebar
      currentView="home"
      onSelectView={() => {}}
      installedCount={0}
      hasUpdates={false}
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
  it('renders 发现与探索 first, 应用资产 second, 偏好与系统 last', () => {
    const { container } = renderSidebar();
    const titles = groupTitles(container);
    expect(titles[0]).toBe('发现与探索');
    expect(titles[1]).toBe('应用资产');
    expect(titles[titles.length - 1]).toBe('偏好与系统');
  });

  it('keeps the six existing nav items in order', () => {
    renderSidebar();
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((l): l is string => l !== null && l !== '登录 GitHub');
    expect(labels.slice(0, 6)).toEqual([
      '精选发现',
      '趋势榜单',
      '分类浏览',
      '已安装应用',
      '更新中心',
      '我的收藏',
    ]);
  });
});

const EXPECTED_PLATFORMS: Array<{ id: string; label: string }> = [
  { id: 'windows', label: 'Windows' },
  { id: 'android', label: 'Android' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'ios', label: 'iOS' },
];

describe('Sidebar: 设备平台 multi-select group', () => {
  it('renders the 设备平台 group with 5 checkbox items, labels and counts', () => {
    renderSidebar({
      selectedPlatforms: new Set(['windows', 'android', 'macos', 'linux', 'ios']),
      onTogglePlatform: () => {},
      platformCounts: { windows: 12, android: 7, macos: 5, linux: 9, ios: 3 },
    });
    expect(screen.getByText('设备平台')).toBeTruthy();
    for (const { id, label } of EXPECTED_PLATFORMS) {
      const item = screen.getByRole('checkbox', { name: new RegExp(label) });
      expect(item.getAttribute('data-platform-id')).toBe(id);
      expect(item.getAttribute('aria-checked')).toBe('true');
    }
    // counts reuse the existing nav-badge styling
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
    expect(titles).toEqual(['发现与探索', '应用资产', '设备平台', '偏好与系统']);

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
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
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
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
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
    // the committed next state is the empty Set (select-nothing), not a refusal
    expect(togglePlatformSet(parseSelectedPlatformArray(['windows']), 'windows').size).toBe(0);
  });
});
