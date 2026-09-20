/**
 * P2-7 — 批量安装按钮绝不能处于永久卡住状态。
 *
 * 契约规范：`handleBatchInstallAll` 依次等待每个应用安装；单个应用安装失败
 * 绝不能导致 `isBatchInstalling` 永久停留在 true。按钮必须重新变为可用状态，
 * 并展示错误汇总（包含失败数量），对齐 `handleSyncStarred` 现有的 syncError 模式。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FavoritesView } from './FavoritesView';
import { api } from '../services/api';
import { AppSummary } from '../types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeApp(overrides: Partial<AppSummary> & { id: string; name: string }): AppSummary {
  return {
    owner: 'owner',
    repo: overrides.id,
    icon: '',
    icon_bg: '#888888',
    description: `desc of ${overrides.name}`,
    stars: 1000,
    forks: 100,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    ...overrides,
  };
}

describe('P2-7: batch install survives a single item failure', () => {
  it('single failure ⇒ button live again + error count shown, remaining items still attempted', async () => {
    const appA = makeApp({ id: 'owner/app-a', name: 'AppA' });
    const appB = makeApp({ id: 'owner/app-b', name: 'AppB' });
    vi.spyOn(api, 'syncGithubStarred').mockResolvedValue({
      total_starred: 2,
      catalog_matches: [appA, appB],
      other_repos: [],
    });
    const onQuickInstall = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    render(
      <FavoritesView
        apps={[]}
        favoriteIds={new Set<string>()}
        installedIds={new Set<string>()}
        installingIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('GitHub Star 同步'));
    fireEvent.click(screen.getByText('立即同步'));

    const batchBtn = await screen.findByText('一键批量装机');
    fireEvent.click(batchBtn.closest('button') as HTMLButtonElement);

    // 尽管第一项安装失败，两项均必须被尝试执行。
    await waitFor(() => expect(onQuickInstall).toHaveBeenCalledTimes(2));
    expect(onQuickInstall).toHaveBeenNthCalledWith(1, 'owner/app-a');
    expect(onQuickInstall).toHaveBeenNthCalledWith(2, 'owner/app-b');

    // 按钮必须重新恢复可用状态（不应停留在“批量安装中...”）。
    await waitFor(() => {
      const btn = screen.getByText('一键批量装机').closest('button') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    expect(screen.queryByText('批量安装中...')).toBeNull();

    // 必须展示包含失败数量的错误汇总提示。
    await waitFor(() => expect(screen.getByText(/1\/2.*失败|失败.*1\/2/)).not.toBeNull());
  });
});
