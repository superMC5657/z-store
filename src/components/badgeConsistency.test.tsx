/**
 * 徽标一致性锁定：
 * 同一 id（大小写变体）下卡片（AppCard）与弹窗（InstallActions）判态必须一致，
 * 均经共享选择器归一得出；未知态双方均占位；
 * 未纳管一律走获取安装，已纳管走绿色已安装。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AppCard } from './AppCard';
import { InstallActions } from './AppDetailModal/InstallActions';
import {
  isInstalled,
  selectBadgeState,
  selectIsManagedOpt,
} from '../app/selectors';
import { makeApp } from '../views/test-utils/filterFixture';
import type { AppDetailViewModel } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
});

const APP_ID = 'Acme/Atlas';

function cardProps(installedIds: Set<string>, managedIds: Set<string> | null) {
  return {
    isInstalled: isInstalled(APP_ID, installedIds),
    isManaged: selectIsManagedOpt(APP_ID, managedIds),
  };
}

function renderCard(
  installedIds: Set<string>,
  managedIds: Set<string> | null,
  onOpenDetail: (id: string) => void = () => {},
) {
  const app = makeApp({ id: APP_ID, name: 'Atlas', platforms: ['windows'] });
  return render(
    <AppCard
      app={app}
      {...cardProps(installedIds, managedIds)}
      platformLoading={false}
      onOpenDetail={onOpenDetail}
      onQuickInstall={() => {}}
    />,
  );
}

function detailFixture(): AppDetailViewModel {
  return {
    id: APP_ID,
    name: 'Atlas',
    owner: 'Acme',
    repo: 'Atlas',
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'atlas desc',
    stars: 10,
    forks: 1,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: false,
    readme_markdown: '',
    releases: [],
    category: 'system',
    category_name: '系统实用',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    isLoading: false,
  };
}

function renderModalStatus(
    installedIds: Set<string>,
    managedIds: Set<string> | null,
  ) {
  const props = {
    app: detailFixture(),
    displayName: 'Atlas',
    releases: [],
    primaryAsset: undefined,
    // 状态文案分支：releases 为空但 hasNoReleases=false 时走安装态分支（便于锁定徽标文案）
    hasNoReleases: false,
    isAuthExpired: false,
    canInstallPrimary: false,
    currentOs: 'windows',
    currentArch: 'x86_64',
    selectedAssetName: null,
    showSkeleton: false,
    downloadProgress: null,
    installError: null,
    showAllAssets: false,
    onToggleShowAllAssets: () => {},
    isInstalled: isInstalled(APP_ID, installedIds),
    isExploreMode: false,
    isManaged: selectIsManagedOpt(APP_ID, managedIds),
    isUninstallingGlobal: false,
    downloadedFile: null,
    isRevealingFolder: false,
    isDownloadingOnly: false,
    effectiveIsInstalling: false,
    effectiveIsBusy: false,
    onLaunch: () => {},
    onClose: () => {},
    onRevealDownload: () => {},
    onDownloadPrimary: () => {},
    onAction: () => {},
  };
  const { container } = render(<InstallActions {...props} />);
  return { container };
}

describe('选择器归一：大小写变体一致', () => {
  it('installed/managed 与三态在大小写变体下一致', () => {
    // 生产集合恒含归一小写条目（buildInstalledIds/buildManagedIds 双写）；
    // 变体仅出现在查询侧 id，此处锁定查询侧归一。
    const installed = new Set(['acme/atlas']);
    const managed = new Set(['acme/atlas']);
    expect(isInstalled('Acme/Atlas', installed)).toBe(true);
    expect(selectIsManagedOpt('Acme/Atlas', managed)).toBe(true);
    expect(selectBadgeState('Acme/Atlas', installed, managed)).toBe('managed');
    expect(selectBadgeState('acme/atlas', installed, managed)).toBe('managed');
    expect(selectBadgeState('acme/atlas', new Set<string>(), new Set<string>())).toBe('none');
  });

  it('未知态三态为 unknown（已安装命中）/ none（未命中）', () => {
    expect(selectBadgeState('acme/atlas', new Set(['acme/atlas']), null)).toBe('unknown');
    expect(selectBadgeState('acme/atlas', new Set<string>(), null)).toBe('none');
    expect(selectIsManagedOpt('acme/atlas', null)).toBeNull();
  });
});

describe('卡片 vs 弹窗一致（同 id）', () => {
  it('已纳管：双方一致绿（大小写变体查询 id）', () => {
    const installed = new Set(['acme/atlas']);
    const managed = new Set(['acme/atlas']);
    const card = renderCard(installed, managed);
    expect(card.container.querySelector('[data-badge="managed"]')).toBeTruthy();
    expect(card.container.querySelector('[data-badge="managed"]')?.textContent).toBe('安装');
    card.unmount();
    cleanup();

    const { container } = renderModalStatus(installed, managed);
    const status = container.querySelector('.install-asset-label');
    expect(status?.getAttribute('data-badge')).toBe('managed');
    expect(status?.textContent).toContain('已安装就绪');
  });

  it('未安装：卡片一致走获取', () => {
    const installed = new Set<string>();
    const managed = new Set<string>();
    const card = renderCard(installed, managed);
    expect(card.container.querySelector('[data-badge="none"]')).toBeTruthy();
    expect(card.container.textContent).toContain('获取');
    card.unmount();
    cleanup();
  });

  it('未知态：双方一致占位', () => {
    const installed = new Set(['acme/atlas']);
    const card = renderCard(installed, null);
    expect(card.container.querySelector('[data-badge="unknown"]')).toBeTruthy();
    card.unmount();
    cleanup();

    const { container } = renderModalStatus(installed, null);
    const status = container.querySelector('.install-asset-label');
    // 未知态不可点击：div 非 button
    expect(status?.tagName).toBe('DIV');
    expect(status?.getAttribute('data-badge')).toBe('unknown');
    expect(status?.textContent).toContain('正在确认安装状态');
    // 操作区同为占位，且启动按钮隐藏（未知时不承诺）
    expect(container.querySelector('.install-action-buttons [data-badge="unknown"]')).toBeTruthy();
  });
});
