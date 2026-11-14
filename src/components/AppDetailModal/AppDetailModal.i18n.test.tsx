/**
 * AppDetailModal 组件 i18n 行为级验证（views.i18n.test.tsx 同机制扩展到 components）：
 * Header / AssetList / IconLevelBadge / InstallActions / ReadmeSection 在 zh-CN 与
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
let InstallActions: typeof import('./InstallActions').InstallActions;
let ReadmeSection: typeof import('./ReadmeSection').ReadmeSection;

beforeEach(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const [headerMod, assetMod, installMod, readmeMod] = await Promise.all([
    import('./Header'),
    import('./AssetList'),
    import('./InstallActions'),
    import('./ReadmeSection'),
  ]);
  Header = headerMod.Header;
  AssetList = assetMod.AssetList;
  InstallActions = installMod.InstallActions;
  ReadmeSection = readmeMod.ReadmeSection;
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
    expect(screen.getByTitle('加入收藏')).toBeTruthy();
    expect(screen.getByTitle('关注更新')).toBeTruthy();
    expect(screen.getByLabelText('GitHub 标星 (Star)')).toBeTruthy();
    expect(screen.getByLabelText('关闭详情弹窗')).toBeTruthy();
    expect(screen.getByLabelText('强制从远端刷新应用信息与最新发布')).toBeTruthy();
    expect(screen.getByText('最新发布 1.2.0')).toBeTruthy();
    expect(screen.getByText('问题反馈')).toBeTruthy();
    expect(screen.getByTitle('在浏览器中查看开源仓库')).toBeTruthy();
    expect(screen.getByTitle('网络受限，正在展示本地缓存')).toBeTruthy();
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
    expect(screen.getByTitle('Add to favorites')).toBeTruthy();
    expect(
      screen.getByTitle('Watch updates'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Star on GitHub (Star)')).toBeTruthy();
    expect(screen.getByLabelText('Close detail dialog')).toBeTruthy();
    expect(screen.getByLabelText('Force refresh app info and latest release from remote')).toBeTruthy();
    expect(screen.getByText('Latest release 1.2.0')).toBeTruthy();
    expect(screen.getByText('Report an Issue')).toBeTruthy();
    expect(screen.getByTitle('View the open-source repo in your browser')).toBeTruthy();
    expect(screen.getByTitle('Offline: showing local cached data')).toBeTruthy();
    expect(screen.getByText('Offline cache')).toBeTruthy();
    expect(screen.getByTitle(/Next level: L2Brand Asset \(2\/5\)/)).toBeTruthy();
  });

  it('switches the official homepage entry between Chinese and English', async () => {
    const url = 'https://demo.example.org/docs?ref=zstore';
    const renderWith = (app: AppDetailViewModel) =>
      render(
        <Header
          app={app}
          displayName="Demo App"
          displayDesc="A test demo app"
          displayCategory="开发工具"
          platformLoading={false}
          onClose={() => {}}
        />,
      );

    await i18n.changeLanguage('zh-CN');
    let view = renderWith({ ...FIXTURE_APP, homepage: url });
    expect(screen.getByText('官方主页')).toBeTruthy();
    expect(screen.getByTitle(`访问官方主页: ${url}`)).toBeTruthy();
    view.unmount();
    view = renderWith(FIXTURE_APP);
    expect(screen.queryByTestId('detail-homepage-link')).toBeNull();
    view.unmount();

    await i18n.changeLanguage('en-US');
    view = renderWith({ ...FIXTURE_APP, homepage: url });
    expect(screen.getByText('Homepage')).toBeTruthy();
    expect(screen.getByTitle(`Open official homepage: ${url}`)).toBeTruthy();
    view.unmount();
    renderWith(FIXTURE_APP);
    expect(screen.queryByTestId('detail-homepage-link')).toBeNull();
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
    expect(screen.getByText('构建产物')).toBeTruthy();
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
    expect(screen.getByText('Build Artifacts')).toBeTruthy();
    expect(screen.getByText('Host environment match: windows (x64)')).toBeTruthy();
    expect(screen.getByText('Current target')).toBeTruthy();
    expect(screen.getByText(/Target platform: windows \(x64\) · Type: zip · Size: /)).toBeTruthy();
    expect(screen.getByTitle(/Official checksum: abc123def4567890/)).toBeTruthy();
    expect(screen.getByText('✓ Selected')).toBeTruthy();
    expect(screen.getByText('Use this package')).toBeTruthy();
    expect(screen.getAllByText('Direct link').length).toBe(2);
    expect(screen.getAllByTitle('Download directly in your browser').length).toBe(2);
  });

  it('switches InstallActions buttons, labels, and dialog titles between Chinese and English', async () => {
    const baseInstallProps = {
      app: FIXTURE_APP,
      displayName: 'Demo App',
      releases: FIXTURE_ASSETS,
      primaryAsset: FIXTURE_ASSETS[0],
      hasNoReleases: false,
      isAuthExpired: false,
      canInstallPrimary: true,
      currentOs: 'windows',
      currentArch: 'x64',
      selectedAssetName: null,
      showSkeleton: false,
      downloadProgress: null,
      installError: null,
      showAllAssets: false,
      onToggleShowAllAssets: () => {},
      isInstalled: false,
      isExploreMode: false,
      isManaged: null,
      isUninstallingGlobal: false,
      downloadedFile: null,
      isRevealingFolder: false,
      isDownloadingOnly: false,
      effectiveIsInstalling: false,
      effectiveIsBusy: false,
      onLaunch: () => {},
      onUninstall: () => {},
      onUnmanage: () => {},
      onOpenAccountSettings: () => {},
      onClose: () => {},
      onRevealDownload: () => {},
      onDownloadPrimary: () => {},
      onAction: () => {},
    };

    // 1. zh-CN: not installed state
    await i18n.changeLanguage('zh-CN');
    const { unmount: unmount1 } = render(<InstallActions {...baseInstallProps} />);
    expect(screen.getByText('推荐版本 · Windows x64')).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部资产 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    unmount1();

    // 2. en-US: not installed state
    await i18n.changeLanguage('en-US');
    const { unmount: unmount2 } = render(<InstallActions {...baseInstallProps} />);
    expect(screen.getByText('Recommended · Windows x64')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All assets 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
    unmount2();

    // 3. zh-CN: installed & managed state
    await i18n.changeLanguage('zh-CN');
    const { unmount: unmount3 } = render(
      <InstallActions
        {...baseInstallProps}
        isInstalled={true}
        isManaged={true}
      />,
    );
    expect(screen.getByText('已安装就绪')).toBeTruthy();
    expect(screen.getByText('取消管理')).toBeTruthy();
    expect(screen.getByText('卸载应用')).toBeTruthy();
    expect(screen.getByText('启动')).toBeTruthy();
    unmount3();

    // 4. en-US: installed & managed state
    await i18n.changeLanguage('en-US');
    const { unmount: unmount4 } = render(
      <InstallActions
        {...baseInstallProps}
        isInstalled={true}
        isManaged={true}
      />,
    );
    expect(screen.getByText('Installed and ready')).toBeTruthy();
    expect(screen.getByText('Unmanage')).toBeTruthy();
    expect(screen.getByText('Uninstall')).toBeTruthy();
    expect(screen.getByText('Launch')).toBeTruthy();
    unmount4();

    // 5. Progress display in zh-CN and en-US
    await i18n.changeLanguage('zh-CN');
    const { unmount: unmount5 } = render(
      <InstallActions
        {...baseInstallProps}
        downloadProgress={{
          task_id: 'test/demo-app',
          state: 'downloading',
          message: '',
          downloaded_bytes: 50,
          total_bytes: 100,
          speed_bytes_per_sec: 1024 * 1024 * 2.5,
        }}
      />,
    );
    expect(screen.getByText('正在下载...')).toBeTruthy();
    expect(screen.getByText('2.5 MB/s')).toBeTruthy();
    unmount5();

    await i18n.changeLanguage('en-US');
    render(
      <InstallActions
        {...baseInstallProps}
        downloadProgress={{
          task_id: 'test/demo-app',
          state: 'downloading',
          message: '',
          downloaded_bytes: 50,
          total_bytes: 100,
          speed_bytes_per_sec: 1024 * 1024 * 2.5,
        }}
      />,
    );
    expect(screen.getByText('Downloading...')).toBeTruthy();
    expect(screen.getByText('2.5 MB/s')).toBeTruthy();
  });

  it('switches ReadmeSection error and loading states between Chinese and English', async () => {
    // 1. Error state in zh-CN
    await i18n.changeLanguage('zh-CN');
    const { unmount: unmount1 } = render(
      <ReadmeSection
        app={{ ...FIXTURE_APP, loadError: 'Network 503' }}
        displayDesc="A test demo app"
        showSkeleton={false}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText('获取详情失败: Network 503')).toBeTruthy();
    expect(screen.getByText('重试加载')).toBeTruthy();
    unmount1();

    // 2. Error state in en-US
    await i18n.changeLanguage('en-US');
    const { unmount: unmount2 } = render(
      <ReadmeSection
        app={{ ...FIXTURE_APP, loadError: 'Network 503' }}
        displayDesc="A test demo app"
        showSkeleton={false}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText('Failed to get details: Network 503')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    unmount2();

    // 3. Loading skeleton state in zh-CN
    await i18n.changeLanguage('zh-CN');
    const { unmount: unmount3 } = render(
      <ReadmeSection
        app={{ ...FIXTURE_APP, isLoading: true, readme_markdown: '' }}
        displayDesc="A test demo app"
        showSkeleton={true}
      />,
    );
    expect(screen.getByText('正在加载完整文档...')).toBeTruthy();
    unmount3();

    // 4. Loading skeleton state in en-US
    await i18n.changeLanguage('en-US');
    render(
      <ReadmeSection
        app={{ ...FIXTURE_APP, isLoading: true, readme_markdown: '' }}
        displayDesc="A test demo app"
        showSkeleton={true}
      />,
    );
    expect(
      screen.getByText('Loading full documentation...'),
    ).toBeTruthy();
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
