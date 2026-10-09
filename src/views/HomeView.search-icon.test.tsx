/**
 * 回归：搜索页首屏 icon='' 经 `zstore://search-icon-ready` 回填后转 img，
 * search_id 失配时丢弃保持 initials（与 App.tsx 世代门控同语义）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';

vi.mock('../services/api', () => {
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'searchAppsOnline')
          return async () => [
            {
              id: 'o/r',
              name: 'OR',
              owner: 'o',
              repo: 'r',
              icon: '',
              icon_bg: 'linear-gradient(135deg, #475569, #334155)',
              description: 'd',
              stars: 1,
              forks: 0,
              license: 'OpenSource',
              latest_version: 'latest',
              category: 'external',
              category_name: 'x',
              is_verified: false,
              platforms: [],
            },
          ];
        if (prop === 'getOrFetchIcon') return async (_id: unknown, icon: unknown) => icon;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { api, isTauri: false, ONLINE_SEARCH_PER_PAGE: 12 };
});

import { patchAppIconList } from '../App';
import { AppIcon } from '../components/AppIcon';
import { api } from '../services/api';

interface SearchRow {
  id: string;
  icon: string;
}

// 与 App.tsx onSearchIconUpgraded 世代门控同语义的精简复刻。
function applySearchIconReady(
  prev: SearchRow[],
  payload: { search_id: string; app_id: string; icon: string },
  currentSearchId: string,
): SearchRow[] {
  if (payload.search_id && currentSearchId && payload.search_id !== currentSearchId) {
    return prev;
  }
  return patchAppIconList(prev as never[], payload.app_id.toLowerCase(), payload.icon) as never as SearchRow[];
}

afterEach(() => cleanup());

describe('search-icon-ready backfill', () => {
  it('first paint icon is empty via searchAppsOnline', async () => {
    const rows = await (
      api as never as { searchAppsOnline: () => Promise<SearchRow[]> }
    ).searchAppsOnline();
    expect(rows[0].id).toBe('o/r');
    expect(rows[0].icon).toBe('');
  });

  it('matching search_id: empty -> emit -> img', () => {
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const next = applySearchIconReady(
      prev,
      { search_id: 'search-1-123', app_id: 'o/r', icon: 'https://cdn.simpleicons.org/r' },
      'search-1-123',
    );
    expect(next[0].icon).toBe('https://cdn.simpleicons.org/r');
    const before = render(<AppIcon icon="" name="OR" appId="o/r" />);
    expect(before.container.querySelector('img')).toBeNull();
    before.unmount();
    const after = render(<AppIcon icon={next[0].icon} name="OR" appId="o/r" />);
    expect(after.container.querySelector('img')).not.toBeNull();
  });

  it('mismatched search_id stays initials', () => {
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const next = applySearchIconReady(
      prev,
      { search_id: 'search-2-999', app_id: 'o/r', icon: 'https://cdn.simpleicons.org/r' },
      'search-1-123',
    );
    expect(next[0].icon).toBe('');
    const { container } = render(<AppIcon icon={next[0].icon} name="OR" appId="o/r" />);
    expect(container.querySelector('img')).toBeNull();
  });
});
