import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../i18n';
import type { AppSummary } from '../types';
import { SearchResultsView } from './SearchResultsView';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
});

function makeApp(id: string, name: string, alternatives?: string[]): AppSummary {
  const [owner = 'acme', repo = id] = id.split('/');
  return {
    id,
    name,
    owner,
    repo,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${name} open source app`,
    stars: 5000,
    forks: 120,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    alternatives,
  };
}

describe('SearchResultsView commercial alternative hint', () => {
  it('shows .status-tag hint when query matches alternatives rather than app name', () => {
    const rustdesk = makeApp('rustdesk/rustdesk', 'RustDesk', ['TeamViewer', 'AnyDesk']);
    const teamviewerHelper = makeApp('acme/teamviewer-helper', 'TeamViewer Helper', ['TeamViewer']);

    const { rerender } = render(
      <SearchResultsView
        apps={[rustdesk, teamviewerHelper]}
        searchQuery="TeamViewer"
      />,
    );

    const rustdeskHint = screen.getByTestId('alt-hint-rustdesk/rustdesk');
    expect(rustdeskHint.className).toContain('status-tag');
    expect(rustdeskHint.textContent).toContain('TeamViewer');
    // 应用名自身已包含查询词时不再重复显示平替提示
    expect(screen.queryByTestId('alt-hint-acme/teamviewer-helper')).toBeNull();

    rerender(
      <SearchResultsView
        apps={[rustdesk]}
        searchQuery="RustDesk"
      />,
    );
    expect(screen.queryByTestId('alt-hint-rustdesk/rustdesk')).toBeNull();
  });
});
