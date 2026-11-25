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

  it('在线搜索命中已收录应用（未出现在本地搜索命中中）绝不降级 is_cataloged 回 false（F-30a + F-31）', () => {
    const catalogedOnline = {
      ...remoteRow('RustDesk/RustDesk', 'RustDesk', 'RustDesk'),
      is_cataloged: true,
    };
    const fullCatalog = [remoteRow('rustdesk/rustdesk', 'rustdesk', 'rustdesk')];

    // 场景 1：传入 catalogApps 时按全量目录比对，即使本地搜索结果 apps=[] 也不显示「移入收录」
    const withCatalog = render(
      <SearchResultsView
        apps={[]}
        catalogApps={fullCatalog}
        installedIds={new Set<string>()}
        favoriteIds={new Set<string>(['rustdesk/rustdesk'])}
        watchedIds={new Set<string>(['rustdesk/rustdesk'])}
        installingIds={new Set<string>(['rustdesk/rustdesk'])}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        onToggleWatch={() => {}}
        searchQuery="remote desktop"
        isOnlineResults
        onlineApps={[catalogedOnline]}
      />,
    );
    expect(withCatalog.queryByTestId('move-in-RustDesk/RustDesk')).toBeNull();
    // F-31: 混合大小写 app.id 正确命中全小写 favoriteIds/watchedIds/installingIds
    expect(withCatalog.container.querySelector('.btn-fav-card.active')).toBeTruthy();
    withCatalog.unmount();
    cleanup();

    // 场景 2：未传入 catalogApps 时，也不降级上层已权威标注的 is_cataloged=true
    const withoutCatalog = render(
      <SearchResultsView
        apps={[]}
        installedIds={new Set<string>()}
        favoriteIds={new Set<string>()}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onToggleFavorite={() => {}}
        searchQuery="remote desktop"
        isOnlineResults
        onlineApps={[catalogedOnline]}
      />,
    );
    expect(withoutCatalog.queryByTestId('move-in-RustDesk/RustDesk')).toBeNull();
    withoutCatalog.unmount();
    cleanup();
  });
});
