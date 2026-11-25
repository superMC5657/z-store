/** 测试详情弹窗的 README Markdown 渲染与 GitHub 风格警示块转换。 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppDetailViewModel } from '../types';
// Header 文案经 i18n：渲染 AppDetailModal 须初始化 i18n
import '../i18n';

const hooks = vi.hoisted(() => ({
  fetchStarredStatus: vi.fn(async (_id: string) => false),
}));

vi.mock('../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'fetchStarredStatus') return (id: string) => hooks.fetchStarredStatus(id);
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
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
      platformLoading={false}
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
      expect(hooks.fetchStarredStatus).toHaveBeenCalled();
    });
    const body = container.querySelector('.readme-markdown-body');
    expect(body?.innerHTML).toContain('Char Readme Title');
    const link = body?.querySelector('a[href="https://example.com/docs"]');
    expect(link?.textContent).toBe('docs');
  });

  it('preprocesses GitHub alert blocks into alert divs', async () => {
    const container = renderModal('> [!NOTE]\n> char alert body');
    await waitFor(() => {
      expect(hooks.fetchStarredStatus).toHaveBeenCalled();
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
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getAllByText('fixture for readme characterization').length).toBeGreaterThan(0);
  });

  it('handles malformed percent-encoded and metacharacter #anchors safely (F-25)', async () => {
    const scrollSpy = vi.fn();
    const container = renderModal(
      [
        '[bad](#bad%E0%A4%A)',
        '[special](#sec%22quote%5Dbracket)',
        '<a name=\'sec"quote]bracket\'>Target</a>',
      ].join('\n\n'),
    );
    await waitFor(() => {
      expect(hooks.fetchStarredStatus).toHaveBeenCalled();
    });

    const body = container.querySelector('.readme-markdown-body')!;
    const badLink = body.querySelector('a[href="#bad%E0%A4%A"]')!;
    const specialLink = body.querySelector('a[href="#sec%22quote%5Dbracket"]')!;
    const namedTarget = body.querySelector('[name]') as HTMLElement | null;
    if (namedTarget) {
      namedTarget.scrollIntoView = scrollSpy;
    }

    expect(() => fireEvent.click(badLink)).not.toThrow();
    expect(() => fireEvent.click(specialLink)).not.toThrow();
    if (namedTarget) {
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    }
  });
});
