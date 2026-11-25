/** 回归测试 RulesManagerModal 筛选标签计数与搜索同源（F-39）、大小写归一化（F-31）与错误处理。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import type { InstalledApp, UpdateItem, UpdateRule, WatchDismissedEntry } from '../types';
import { RulesManagerModal } from './RulesManagerModal';

afterEach(cleanup);

function getTabBadgeCounts(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.segmented-group .count-badge')).map((el) =>
    Number(el.textContent?.trim()),
  );
}

describe('RulesManagerModal', () => {
  const rules: UpdateRule[] = [
    { app_id: 'RustDesk/RustDesk', skipped_version: '1.2.3', is_frozen: false, is_hidden: false, updated_at: 1700000000 },
    { app_id: 'org/frozen-tool', skipped_version: null, is_frozen: true, is_hidden: false, updated_at: 1700000000 },
    { app_id: 'org/hidden-tool', skipped_version: null, is_frozen: false, is_hidden: true, updated_at: 1700000000 },
  ];
  const dismissedWatches: WatchDismissedEntry[] = [
    { app_id: 'org/watch-alpha', version: '2.0.0', dismissed_at: 1700000000 },
    { app_id: 'RustDesk/WatchTool', version: '3.0.0', dismissed_at: 1700000000 },
  ];
  const installedApps: InstalledApp[] = [
    {
      app_id: 'rustdesk/rustdesk',
      app_name: 'RustDesk',
      version: '1.2.2',
      install_path: 'C:/Apps/RustDesk',
      install_method: 'setup_exe',
      asset_name: 'rustdesk-1.2.2.exe',
      asset_sha256: 'abc123',
      installed_at: 1700000000,
    },
  ];
  const updatesById = new Map<string, UpdateItem>([
    [
      'rustdesk/rustdesk',
      {
        app_id: 'rustdesk/rustdesk',
        app_name: 'RustDesk',
        current_version: '1.2.2',
        latest_version: '1.3.0',
        changelog: '',
      },
    ],
  ]);

  it('derives all tab CountBadge values from filterQuery-filtered items (F-39)', () => {
    const { container } = render(
      <RulesManagerModal
        isOpen
        onClose={() => {}}
        updateRules={rules}
        installedApps={installedApps}
        updatesById={updatesById}
        dismissedWatches={dismissedWatches}
        onClearRuleSkip={async () => {}}
        onToggleRuleFrozen={async () => {}}
        onToggleRuleHidden={async () => {}}
      />,
    );

    // Unfiltered: [all=5, skipped=1, frozen=1, hidden=1, watch=2]
    expect(getTabBadgeCounts(container)).toEqual([5, 1, 1, 1, 2]);

    const searchInput = screen.getByPlaceholderText(/筛选|Filter|搜索/i);
    fireEvent.change(searchInput, { target: { value: 'rustdesk' } });

    // Filtered by 'rustdesk': RustDesk/RustDesk (skipped) + RustDesk/WatchTool (watch)
    expect(getTabBadgeCounts(container)).toEqual([2, 1, 0, 0, 1]);

    fireEvent.change(searchInput, { target: { value: 'frozen' } });
    expect(getTabBadgeCounts(container)).toEqual([1, 0, 1, 0, 0]);

    fireEvent.change(searchInput, { target: { value: 'nonexistent-xyz' } });
    expect(getTabBadgeCounts(container)).toEqual([0, 0, 0, 0, 0]);

    fireEvent.change(searchInput, { target: { value: '' } });
    expect(getTabBadgeCounts(container)).toEqual([5, 1, 1, 1, 2]);
  });

  it('matches mixed-case rule app_id against normalized updatesById and catches row mutation failures (F-31)', async () => {
    const onSkipVersion = vi.fn(async () => {});
    const onToggleRuleFrozen = vi.fn(async () => {
      throw new Error('ipc failure');
    });

    render(
      <RulesManagerModal
        isOpen
        onClose={() => {}}
        updateRules={[rules[0]]}
        installedApps={installedApps}
        updatesById={updatesById}
        onSkipVersion={onSkipVersion}
        onClearRuleSkip={async () => {}}
        onToggleRuleFrozen={onToggleRuleFrozen}
        onToggleRuleHidden={async () => {}}
      />,
    );

    // Mixed-case 'RustDesk/RustDesk' matches lowercase 'rustdesk/rustdesk' in updatesById
    expect(screen.getByRole('button', { name: /跳过此版本|跳过版本|Skip/i })).toBeTruthy();

    const lockBtn = screen.getByRole('button', { name: /锁定版本|Lock/i });
    fireEvent.click(lockBtn);

    await waitFor(() => {
      expect(onToggleRuleFrozen).toHaveBeenCalledWith('RustDesk/RustDesk', true);
      expect(screen.getByRole('status').textContent).toContain('ipc failure');
    });
  });
});
