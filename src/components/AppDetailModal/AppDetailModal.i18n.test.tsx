/**
 * AppDetailModal 三组件 i18n 行为级验证（views.i18n.test.tsx 同机制扩展到 components）：
 * Header / AssetList / IconLevelBadge（经 Header 的 nextLevelTitle 承载）在 zh-CN 与
 * en-US 间完整切换，aria-label/title 同属用户可见文案一并断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import i18n from '../../i18n';
import type { AppDetailViewModel, ReleaseAsset } from '../../types';

const hooks = vi.hoisted(() => ({
  cycleAppIcon: vi.fn(async (_id: string) => ({
    url: '',
    remote_url: '',
    level: 2,
    source: 'simple-icons',
    is_fallback: false,
    total_levels: 5,
    is_cataloged: false,
  })),
  fetchStarredStatus: vi.fn(async (_id: string) => false),
}));

vi.mock('../../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'cycleAppIcon') return (...a: unknown[]) => hooks.cycleAppIcon(...(a as [string]));
        if (prop === 'fetchStarredStatus') return (id: string) => hooks.fetchStarredStatus(id);
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const FIXTURE_APP: AppDetailViewModel = {
  id: 'test/demo-app',
  name: 'Demo App',
  owner: 'test',
  repo: 'demo-app',
  icon: 'https://cdn.example.com/icon.png',
  icon_bg: '#333333',
  description: 'A test demo app',
  stars: 10,
  forks: 1,
  license: 'MIT',
  latest_version: '1.2.0',
  changelog: '',
  is_verified: false,
  readme_markdown: '',
  releases: [],
  category: 'dev',
  category_name: '开发工具',
  forge: 'github',
  forge_host: 'github.com',
  homepage: null,
  platforms: ['windows'],
  isLoading: false,
  is_stale: true,
};

const FIXTURE_ASSETS: ReleaseAsset[] = [
  {
    name: 'demo-app-1.2.0-windows.zip',
    download_url: 'https://github.com/test/demo-app/releases/download/1.2.0/demo.zip',
    size_bytes: 1024 * 1024 * 24,
    sha256: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
    os: 'windows',
    arch: 'x64',
    kind: 'zip',
  },
  {
    name: 'demo-app-1.2.0-macos.dmg',
    download_url: 'https://github.com/test/demo-app/releases/download/1.2.0/demo.dmg',
    size_bytes: 1024 * 1024 * 48,
    os: 'darwin',
    arch: 'arm64',
    kind: 'dmg',
  },
];

type HeaderModule = typeof import('./Header');
let Header: HeaderModule['Header'];
let AssetList: typeof import('./AssetList').AssetList;

beforeEach(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const [headerMod, assetMod] = await Promise.all([import('./Header'), import('./AssetList')]);
  Header = headerMod.Header;
  AssetList = assetMod.AssetList;
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await i18n.changeLanguage('zh-CN');
});

describe('AppDetailModal components i18n (zh-CN <-> en-US)', () => {
  it('switches Header action buttons, titles, and aria-labels between Chinese and English', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="开发工具"
        platformLoading={false}
        onClose={() => {}}
        onRefresh={async () => {}}
        onToggleFavorite={() => {}}
        onToggleWatch={() => {}}
      />,
    );

    expect(screen.getByTitle('强制从远端刷新 (穿透本地缓存)')).toBeTruthy();
    expect(screen.getByTitle('应用内收藏：保存至本机数据库，离线随时可用')).toBeTruthy();
    expect(screen.getByTitle('关注 Release 更新：该应用发布新版本时在应用内提醒')).toBeTruthy();
    expect(screen.getByLabelText('GitHub 标星 (Star)')).toBeTruthy();
    expect(screen.getByLabelText('关闭详情弹窗')).toBeTruthy();
    expect(screen.getByLabelText('强制从远端刷新应用信息与最新发布')).toBeTruthy();
    expect(screen.getByText('最新发布 1.2.0')).toBeTruthy();
    expect(screen.getByText('问题反馈')).toBeTruthy();
    expect(screen.getByTitle('在浏览器中查看开源仓库')).toBeTruthy();
    expect(screen.getByTitle('网络不可用或请求受限，当前正在呈现本地历史数据')).toBeTruthy();
    expect(screen.getByText('离线缓存')).toBeTruthy();
    // IconLevelBadge 承载：iconCycle=null 时下一档 L2（品牌库）
    expect(screen.getByTitle(/下一档：L2品牌库 \(2\/5\)/)).toBeTruthy();
    unmount();

    await i18n.changeLanguage('en-US');
    render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="Development"
        platformLoading={false}
        onClose={() => {}}
        onRefresh={async () => {}}
        onToggleFavorite={() => {}}
        onToggleWatch={() => {}}
      />,
    );

    expect(screen.getByTitle('Force refresh from remote (bypasses local cache)')).toBeTruthy();
    expect(screen.getByTitle('App favorites: saved to the local database, available offline')).toBeTruthy();
    expect(
      screen.getByTitle('Watch release updates: get an in-app notice when this app ships a new version'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Star on GitHub (Star)')).toBeTruthy();
    expect(screen.getByLabelText('Close detail dialog')).toBeTruthy();
    expect(screen.getByLabelText('Force refresh app info and latest release from remote')).toBeTruthy();
    expect(screen.getByText('Latest release 1.2.0')).toBeTruthy();
    expect(screen.getByText('Report an Issue')).toBeTruthy();
    expect(screen.getByTitle('View the open-source repo in your browser')).toBeTruthy();
    expect(screen.getByTitle('Network unavailable or request throttled; showing local historical data')).toBeTruthy();
    expect(screen.getByText('Offline cache')).toBeTruthy();
    expect(screen.getByTitle(/Next level: L2Brand Asset \(2\/5\)/)).toBeTruthy();
  });

  it('switches the icon-cycle success toast between Chinese and English', async () => {
    const toastTexts: string[] = [];
    const listener = (e: Event): void => {
      toastTexts.push((e as CustomEvent<{ text: string }>).detail.text);
    };
    window.addEventListener('zstore:toast', listener);

    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="开发工具"
        platformLoading={false}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTitle(/下一档/));
    });
    await waitFor(() => {
      expect(toastTexts).toContain('图标已切换为 L2品牌库 (2/5)');
    });
    unmount();

    await i18n.changeLanguage('en-US');
    render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="Development"
        platformLoading={false}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTitle(/Next level/));
    });
    await waitFor(() => {
      expect(toastTexts).toContain('Icon switched to L2Brand Asset (2/5)');
    });
    window.removeEventListener('zstore:toast', listener);
  });

  it('switches refresh status tags between Chinese and English', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="开发工具"
        platformLoading={false}
        onClose={() => {}}
        onRefresh={async () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTitle('强制从远端刷新 (穿透本地缓存)'));
    });
    expect(await screen.findByText('已同步最新数据')).toBeTruthy();
    expect(screen.getByTitle('已成功同步最新版本与文档数据')).toBeTruthy();
    unmount();

    await i18n.changeLanguage('en-US');
    render(
      <Header
        app={FIXTURE_APP}
        displayName="Demo App"
        displayDesc="A test demo app"
        displayCategory="Development"
        platformLoading={false}
        onClose={() => {}}
        onRefresh={async () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTitle('Force refresh from remote (bypasses local cache)'));
    });
    expect(await screen.findByText('Latest data synced')).toBeTruthy();
    expect(screen.getByTitle('Successfully synced the latest release and readme data')).toBeTruthy();
  });

  it('switches AssetList titles, badges, and actions between Chinese and English', async () => {
    const commonProps = {
      showAllAssets: true,
      releases: FIXTURE_ASSETS,
      primaryAsset: FIXTURE_ASSETS[0],
      currentOs: 'windows',
      currentArch: 'x64',
      effectiveIsBusy: false,
      onSelectAsset: () => {},
      onOpenExternal: () => {},
    };

    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(<AssetList {...commonProps} />);
    expect(screen.getByText('GitHub Release 原生构建设施产物')).toBeTruthy();
    expect(screen.getByText('宿主环境匹配: windows (x64)')).toBeTruthy();
    expect(screen.getByText('当前目标')).toBeTruthy();
    expect(screen.getByText(/目标平台: windows \(x64\) · 类型: zip · 体积: /)).toBeTruthy();
    expect(screen.getByTitle(/官方校验值: abc123def4567890/)).toBeTruthy();
    expect(screen.getByText('✓ 已选用')).toBeTruthy();
    expect(screen.getByText('选用此包')).toBeTruthy();
    expect(screen.getAllByText('直链').length).toBe(2);
    expect(screen.getAllByTitle('在浏览器中直接下载').length).toBe(2);
    unmount();

    await i18n.changeLanguage('en-US');
    render(<AssetList {...commonProps} />);
    expect(screen.getByText('GitHub Release native build artifacts')).toBeTruthy();
    expect(screen.getByText('Host environment match: windows (x64)')).toBeTruthy();
    expect(screen.getByText('Current target')).toBeTruthy();
    expect(screen.getByText(/Target platform: windows \(x64\) · Type: zip · Size: /)).toBeTruthy();
    expect(screen.getByTitle(/Official checksum: abc123def4567890/)).toBeTruthy();
    expect(screen.getByText('✓ Selected')).toBeTruthy();
    expect(screen.getByText('Use this package')).toBeTruthy();
    expect(screen.getAllByText('Direct link').length).toBe(2);
    expect(screen.getAllByTitle('Download directly in your browser').length).toBe(2);
  });

  it('resolves install-confirm dialog keys from App.tsx in both languages', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('install_confirm.deeplink_intro')).toBe('外部链接请求安装以下应用，请确认后再继续：');
    expect(i18n.t('install_confirm.unknown_source')).toBe('未知来源');
    expect(i18n.t('install_confirm.unverified_intro')).toContain('SHA-256 校验清单');
    expect(i18n.t('install_confirm.unverified_source')).toBe('未校验资产（Release 未附带 checksums 清单）');

    await i18n.changeLanguage('en-US');
    expect(i18n.t('install_confirm.deeplink_intro')).toBe(
      'An external link requests installing the following app, please review before continuing:',
    );
    expect(i18n.t('install_confirm.unknown_source')).toBe('Unknown source');
    expect(i18n.t('install_confirm.unverified_intro')).toContain('SHA-256 checksum list');
    expect(i18n.t('install_confirm.unverified_source')).toBe('Unverified asset (Release has no checksums list)');
  });
});
