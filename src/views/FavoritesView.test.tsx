/**
 * P2-7 — batch-install button must never get stuck.
 *
 * Contract: `handleBatchInstallAll` awaits per-app installs; a single item
 * failure must NOT leave `isBatchInstalling` true forever. The button must
 * become live again and an error summary (with the failure count) must be
 * shown, mirroring the existing syncError pattern of `handleSyncStarred`.
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

    // Both items must be attempted despite the first one failing.
    await waitFor(() => expect(onQuickInstall).toHaveBeenCalledTimes(2));
    expect(onQuickInstall).toHaveBeenNthCalledWith(1, 'owner/app-a');
    expect(onQuickInstall).toHaveBeenNthCalledWith(2, 'owner/app-b');

    // Button must be live again (not stuck on 批量安装中...).
    await waitFor(() => {
      const btn = screen.getByText('一键批量装机').closest('button') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    expect(screen.queryByText('批量安装中...')).toBeNull();

    // Error summary with the failure count must be shown.
    await waitFor(() => expect(screen.getByText(/1\/2.*失败|失败.*1\/2/)).not.toBeNull());
  });
});
