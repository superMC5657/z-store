/**
 * 徽标一致性锁定：
 * 同一 id（大小写变体）下卡片（AppCard）与弹窗（InstallActions）判态必须一致，
 * 均经共享选择器归一得出；未知态双方均占位、永不闪灰；可点击状态文本为原生 button。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { AppCard } from './AppCard';
import { InstallActions } from './AppDetailModal/InstallActions';
import {
  isInstalledUnion,
  resolveDetectedOnly,
  selectBadgeState,
  selectIsDetectedOnlyOpt,
  selectIsManagedOpt,
} from '../app/selectors';
import { makeApp } from '../views/test-utils/filterFixture';
import type { AppDetailViewModel } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const APP_ID = 'Acme/Atlas';

function cardProps(installedIds: Set<string>, managedIds: Set<string> | null) {
  return {
    isInstalled: isInstalledUnion(APP_ID, installedIds),
    isManaged: selectIsManagedOpt(APP_ID, managedIds),
    isDetectedOnly: selectIsDetectedOnlyOpt(APP_ID, installedIds, managedIds),
  };
}

function renderCard(installedIds: Set<string>, managedIds: Set<string> | null) {
  const app = makeApp({ id: APP_ID, name: 'Atlas', platforms: ['windows'] });
  return render(
    <AppCard
      app={app}
      {...cardProps(installedIds, managedIds)}
      platformLoading={false}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onManageApp={() => {}}
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
    omitDetectedProp = false,
  ) {
  const onManageApp = vi.fn(async () => undefined);
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
    isInstalled: isInstalledUnion(APP_ID, installedIds),
    isExploreMode: false,
    isManaged: selectIsManagedOpt(APP_ID, managedIds),
    isUninstallingGlobal: false,
    downloadedFile: null,
    isRevealingFolder: false,
    isDownloadingOnly: false,
    effectiveIsInstalling: false,
    effectiveIsBusy: false,
    onLaunch: () => {},
    onManageApp,
    onClose: () => {},
    onRevealDownload: () => {},
    onDownloadPrimary: () => {},
    onAction: () => {},
  };
  const { container } = omitDetectedProp
    ? render(<InstallActions {...props} />)
    : render(
        <InstallActions
          {...props}
          isDetectedOnly={selectIsDetectedOnlyOpt(APP_ID, installedIds, managedIds)}
        />,
      );
  return { container, onManageApp };
}

describe('选择器归一：大小写变体一致', () => {
  it('union/managed/detected 与四态在大小写变体下一致', () => {
    // 生产集合恒含归一小写条目（buildInstalledIds/buildManagedIds 双写）；
    // 变体仅出现在查询侧 id，此处锁定查询侧归一。
    const installed = new Set(['acme/atlas']);
    const managed = new Set(['acme/atlas']);
    expect(isInstalledUnion('Acme/Atlas', installed)).toBe(true);
    expect(selectIsManagedOpt('Acme/Atlas', managed)).toBe(true);
    expect(selectIsDetectedOnlyOpt('Acme/Atlas', installed, managed)).toBe(false);
    expect(selectBadgeState('Acme/Atlas', installed, managed)).toBe('managed');
    expect(selectBadgeState('acme/atlas', installed, managed)).toBe('managed');
    // 末端布尔归一：未知（null）恒非 detected
    expect(resolveDetectedOnly(true, true)).toBe(false);
    expect(resolveDetectedOnly(true, false)).toBe(true);
    expect(resolveDetectedOnly(true, null)).toBe(false);
    expect(resolveDetectedOnly(false, false)).toBe(false);
  });

  it('未知态四态为 unknown（union 命中）/ none（union 未命中）', () => {
    expect(selectBadgeState('acme/atlas', new Set(['acme/atlas']), null)).toBe('unknown');
    expect(selectBadgeState('acme/atlas', new Set<string>(), null)).toBe('none');
    expect(selectIsManagedOpt('acme/atlas', null)).toBeNull();
    expect(selectIsDetectedOnlyOpt('acme/atlas', new Set(['acme/atlas']), null)).toBeNull();
    expect(selectIsDetectedOnlyOpt('acme/atlas', new Set<string>(), null)).toBe(false);
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
    expect(container.querySelector('[data-badge="detected"]')).toBeNull();
  });

  it('末端回退（省略 isDetectedOnly）与显式传参一致', () => {
    const installed = new Set(['acme/atlas']);
    const managed = new Set(['acme/atlas']);
    const { container } = renderModalStatus(installed, managed, true);
    expect(container.querySelector('.install-asset-label')?.getAttribute('data-badge')).toBe('managed');
  });

  it('仅检测到：双方一致灰，且状态文本为原生 button（点击纳管行为不变）', async () => {
    const installed = new Set(['acme/atlas']);
    const managed = new Set<string>();
    const card = renderCard(installed, managed);
    expect(card.container.querySelector('[data-badge="detected"]')).toBeTruthy();
    expect(card.container.textContent).toContain('检测到·点击纳管');
    card.unmount();
    cleanup();

    const { container, onManageApp } = renderModalStatus(installed, managed);
    const status = container.querySelector('.install-asset-label');
    expect(status?.tagName).toBe('BUTTON');
    expect(status?.getAttribute('data-badge')).toBe('detected');
    expect(status?.textContent).toContain('检测到·点击纳管');
    fireEvent.click(status as Element);
    await waitFor(() => expect(onManageApp).toHaveBeenCalledWith(APP_ID));
  });

  it('未知态：双方一致占位，永不闪灰', () => {
    const installed = new Set(['acme/atlas']);
    const card = renderCard(installed, null);
    expect(card.container.querySelector('[data-badge="unknown"]')).toBeTruthy();
    expect(card.container.querySelector('[data-badge="detected"]')).toBeNull();
    card.unmount();
    cleanup();

    const { container } = renderModalStatus(installed, null);
    const status = container.querySelector('.install-asset-label');
    // 未知态不可点击：div 非 button
    expect(status?.tagName).toBe('DIV');
    expect(status?.getAttribute('data-badge')).toBe('unknown');
    expect(status?.textContent).toContain('正在确认安装状态');
    expect(container.querySelector('[data-badge="detected"]')).toBeNull();
    // 操作区同为占位，且启动按钮隐藏（未知时不承诺）
    expect(container.querySelector('.install-action-buttons [data-badge="unknown"]')).toBeTruthy();
  });
});
