/**
 * README 特征化测试（用于从 AppDetailModal 拆分出 useDetailReadme 前的防劣化保护）。
 *
 * 通过真实组件路径锁定 README 渲染契约：
 * Markdown 被解析为 HTML，GitHub 风格警示块被转换为 alert 提示容器。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AppDetailViewModel } from '../types';

const hooks = vi.hoisted(() => ({
  isStarred: vi.fn(async (_id: string) => false),
}));

vi.mock('../services/api', () => {
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'isStarred') return (id: string) => hooks.isStarred(id);
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { api };
});

import { AppDetailModal } from './AppDetailModal';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixtureApp(readme: string): AppDetailViewModel {
  return {
    id: 'testowner/testrepo',
    name: 'Readme Fixture',
    owner: 'testowner',
    repo: 'testrepo',
    icon: '📦',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'fixture for readme characterization',
    stars: 3,
    forks: 0,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: true,
    readme_markdown: readme,
    releases: [],
    category: 'system',
    category_name: '应用',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    isLoading: false,
  };
}

function renderModal(readme: string): HTMLElement {
  const { container } = render(
    <AppDetailModal
      app={fixtureApp(readme)}
      isInstalled={false}
      onClose={() => {}}
      onInstall={async () => {}}
      onLaunch={() => {}}
    />,
  );
  return container;
}

describe('readme characterization (real AppDetailModal path)', () => {
  it('renders markdown headings and links as HTML', async () => {
    const container = renderModal('# Char Readme Title\n\n[docs](https://example.com/docs)');
    await waitFor(() => {
      expect(hooks.isStarred).toHaveBeenCalled();
    });
    const body = container.querySelector('.readme-markdown-body');
    expect(body?.innerHTML).toContain('Char Readme Title');
    const link = body?.querySelector('a[href="https://example.com/docs"]');
    expect(link?.textContent).toBe('docs');
  });

  it('preprocesses GitHub alert blocks into alert divs', async () => {
    const container = renderModal('> [!NOTE]\n> char alert body');
    await waitFor(() => {
      expect(hooks.isStarred).toHaveBeenCalled();
    });
    const body = container.querySelector('.readme-markdown-body');
    expect(body?.querySelector('.markdown-alert-note')).toBeTruthy();
    expect(body?.innerHTML).toContain('char alert body');
  });

  it('shows loading description when readme is absent while loading', () => {
    const app = { ...fixtureApp(''), isLoading: true };
    render(
      <AppDetailModal
        app={app}
        isInstalled={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByText('fixture for readme characterization')).toBeTruthy();
  });
});
