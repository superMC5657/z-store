/** 测试搜索结果本地段在 `localApps` 就绪后的本地收录黄标补标与蓝标优先逻辑。 */
import { describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SearchResultsView } from './SearchResultsView';
import type { AppSummary } from '../types';
import { makeApp } from './test-utils/filterFixture';

function remoteRow(id: string, owner: string, repo: string, extra: Partial<AppSummary> = {}): AppSummary {
  return makeApp({ id, name: repo, owner, repo, platforms: ['windows'], ...extra });
}

function localRow(id: string, owner: string, repo: string): AppSummary {
  return { ...remoteRow(id, owner, repo), source: 'local', status: 'collected', is_cataloged: true } as AppSummary;
}

function renderSearchLocal(apps: AppSummary[], localApps?: readonly AppSummary[]) {
  return render(
    <SearchResultsView
      apps={apps}
      installedIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      searchQuery="openchamber"
      onlineApps={[]}
      localApps={localApps}
    />,
  );
}

describe('SearchResultsView 本地段首刷补黄', () => {
  it('首刷无 localApps 即无标，就绪后远端同仓行补黄（含大小写归一）', () => {
    const remote = [
      // 远端大写变体，本地小写收录：归一后应命中
      remoteRow('OpenChamber/OpenChamber', 'OpenChamber', 'OpenChamber'),
      remoteRow('openchamber/cc-switch', 'openchamber', 'cc-switch'),
    ];
    const collected = [
      localRow('openchamber/openchamber', 'openchamber', 'openchamber'),
      localRow('openchamber/cc-switch', 'openchamber', 'cc-switch'),
    ];
    const first = renderSearchLocal(remote, undefined);
    const firstGrid = first.container.querySelector('[data-testid="search-local-grid"]');
    expect(firstGrid).toBeTruthy();
    expect(firstGrid?.querySelectorAll('.verified-badge-local').length).toBe(0);
    first.unmount();
    cleanup();

    const ready = renderSearchLocal(remote, collected);
    const grid = ready.container.querySelector('[data-testid="search-local-grid"]');
    expect(grid).toBeTruthy();
    // 两行均黄：openchamber 为远端已存在同仓叠标，cc-switch 同理
    expect(grid?.querySelectorAll('.verified-badge-local').length).toBe(2);
    ready.unmount();
    cleanup();
  });

  it('蓝优先：已验证远端同仓不叠黄', () => {
    const remote = [remoteRow('o/verified', 'o', 'verified', { is_verified: true })];
    const collected = [localRow('o/verified', 'o', 'verified')];
    const { container, unmount } = renderSearchLocal(remote, collected);
    const grid = container.querySelector('[data-testid="search-local-grid"]');
    expect(grid?.querySelectorAll('.verified-badge-local').length).toBe(0);
    expect(grid?.querySelectorAll('.verified-badge').length).toBeGreaterThan(0);
    unmount();
    cleanup();
  });
});
