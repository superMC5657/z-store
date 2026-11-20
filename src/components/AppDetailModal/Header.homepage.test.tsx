/** 测试详情顶栏「官方主页」与「问题反馈」外链入口的展示、悬停提示与事件隔离。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import type { AppDetailViewModel } from '../../types';

const hooks = vi.hoisted(() => ({
  openUrl: vi.fn(async (_url: string) => true),
  zlogWarn: vi.fn((_msg: string) => {}),
}));

vi.mock('../../lib/z-log', () => ({
  zlogInfo: () => {},
  zlogWarn: (msg: string) => hooks.zlogWarn(msg),
  zlogError: () => {},
  initZLog: () => {},
}));

vi.mock('../../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'openUrl') return (url: string) => hooks.openUrl(url);
        if (prop === 'fetchStarredStatus') return async () => false;
        if (prop === 'restoreOrFetchIconCycle') return async () => null;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function fixture(overrides: Partial<AppDetailViewModel> = {}): AppDetailViewModel {
  return {
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
    ...overrides,
  };
}

let Header: typeof import('./Header').Header;
let AppDetailModal: typeof import('./index').AppDetailModal;

beforeEach(async () => {
  vi.resetModules();
  [{ Header }, { AppDetailModal }] = await Promise.all([import('./Header'), import('./index')]);
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHeader(app: AppDetailViewModel) {
  return render(
    <Header
      app={app}
      displayName={app.name}
      displayDesc={app.description}
      displayCategory={app.category_name}
      platformLoading={false}
      onClose={() => {}}
    />,
  );
}

describe('Header 官方主页入口：展示', () => {
  it.each([
    ['https://zed.dev', 'zed.dev'],
    ['http://gitup.co', 'gitup.co'],
  ])('独立官网 %s 以「地球图标 + 域名」标签渲染于标签栏', (hp, display) => {
    const { container } = renderHeader(fixture({ homepage: hp }));
    const link = screen.getByTestId('detail-homepage-link') as HTMLAnchorElement;
    expect(container.querySelector('.modal-header-info .modal-tags')?.contains(link)).toBe(true);
    expect(link.textContent).toBe(display);
    expect(link.getAttribute('aria-label')).toBe(`官方主页 ${display}`);
    expect(link.getAttribute('href')).toBe(hp);
    expect(link.getAttribute('title')).toBe(`访问官方主页: ${hp}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('不出现在仓库元数据条，问题反馈紧随最新发布', () => {
    const { container } = renderHeader(fixture({ homepage: 'https://zed.dev' }));
    const repoRow = container.querySelector('.modal-app-repo');
    expect(repoRow?.contains(screen.getByTestId('detail-homepage-link'))).toBe(false);
    const text = repoRow?.textContent ?? '';
    expect(text).not.toContain('zed.dev');
    expect(text.indexOf('最新发布 1.2.0')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('问题反馈')).toBeGreaterThan(text.indexOf('最新发布 1.2.0'));
  });

  it('同主机不同路径与跨托管主页照常展示', () => {
    renderHeader(
      fixture({ owner: 'desktop', repo: 'desktop', homepage: 'https://github.com/apps/desktop' }),
    );
    expect(screen.getByTestId('detail-homepage-link').getAttribute('href')).toBe('https://github.com/apps/desktop');
    cleanup();
    renderHeader(fixture({ owner: 'OpenMW', repo: 'openmw', homepage: 'https://gitlab.com/OpenMW/openmw' }));
    expect(screen.getByTestId('detail-homepage-link').getAttribute('href')).toBe('https://gitlab.com/OpenMW/openmw');
  });
});

describe('Header 官方主页入口：隐藏', () => {
  it.each([
    null,
    '',
    '   ',
    'zed.dev',
    'javascript:alert(1)',
    'ftp://files.example.com',
    'mailto:dev@example.com',
  ])('非法主页 %j 不渲染', (hp) => {
    renderHeader(fixture({ homepage: hp }));
    expect(screen.queryByTestId('detail-homepage-link')).toBeNull();
  });

  it.each([
    'https://github.com/Test/Demo-App',
    'https://github.com/test/demo-app/',
    'http://www.github.com/test/demo-app.git',
    'https://github.com/test/demo-app#readme',
    'https://github.com/test/demo-app?tab=readme-ov-file',
  ])('GitHub 同仓地址 %s 不渲染', (hp) => {
    renderHeader(fixture({ homepage: hp }));
    expect(screen.queryByTestId('detail-homepage-link')).toBeNull();
  });

  it('非 GitHub 托管的同仓地址不渲染', () => {
    renderHeader(
      fixture({ forge: 'codeberg', forge_host: 'codeberg.org', homepage: 'https://codeberg.org/test/demo-app/' }),
    );
    expect(screen.queryByTestId('detail-homepage-link')).toBeNull();
  });
});

describe('Header 官方主页入口：统一外链通道', () => {
  it('点击经 tauriApi.openUrl 打开，不调 window.open，不冒泡关闭遮罩', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    render(
      <AppDetailModal
        app={fixture({ homepage: 'https://zed.dev' })}
        isInstalled={false}
        platformLoading={false}
        onClose={onClose}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('detail-homepage-link'));
    expect(hooks.openUrl).toHaveBeenCalledTimes(1);
    expect(hooks.openUrl).toHaveBeenCalledWith('https://zed.dev');
    expect(openSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('openUrl 拒绝时不抛未处理异常，改为单行告警落盘', async () => {
    hooks.openUrl.mockRejectedValueOnce(new Error('denied'));
    renderHeader(fixture({ homepage: 'https://zed.dev' }));
    fireEvent.click(screen.getByTestId('detail-homepage-link'));
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.openUrl).toHaveBeenCalledTimes(1);
    expect(hooks.zlogWarn).toHaveBeenCalledWith('open external url failed: denied');
  });

  it('问题反馈经同一外链通道打开仓库 Issues 新建页', () => {
    renderHeader(fixture());
    fireEvent.click(screen.getByText('问题反馈'));
    expect(hooks.openUrl).toHaveBeenCalledTimes(1);
    expect(hooks.openUrl.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/test\/demo-app\/issues\/new\?title=/);
  });

  it('owner/repo 缺失时不渲染问题反馈链接（避免相对地址）', () => {
    renderHeader(fixture({ repo: '' }));
    expect(screen.queryByText('问题反馈')).toBeNull();
  });
});

describe('Header 官方主页入口：单色标签样式', () => {
  it('挂载 modal-tag，无内联颜色，仅一枚 1.5 线宽 currentColor 地球图标', () => {
    renderHeader(fixture({ homepage: 'https://zed.dev' }));
    const link = screen.getByTestId('detail-homepage-link') as HTMLAnchorElement;
    expect(link.classList.contains('modal-tag')).toBe(true);
    expect(link.classList.contains('modal-homepage-tag')).toBe(true);
    expect(link.style.color).toBe('');
    const svgs = link.querySelectorAll('svg');
    expect(svgs.length).toBe(1);
    for (const svg of svgs) {
      expect(svg.getAttribute('stroke-width')).toBe('1.5');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
