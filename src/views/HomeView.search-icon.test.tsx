/**
 * 回归：搜索页首屏 icon='' 经新统一 `zstore://icon-ready` 回填后转 img，
 * `context.search_id` 失配时丢弃保持 initials（与 App.tsx + `iconStore.applyHit` 世代门控同语义）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
import {
  __resetIconStoreForTests,
  applyHit,
  type IconReadyPayload,
} from '../services/iconStore';

interface SearchRow {
  id: string;
  icon: string;
}

// 新事件直通 `applyHit`：`context.search_id` 世代门控 + 列表 `patch` 写透（与 App.tsx 回调同语义）。
function applyNewIconReady(
  prev: SearchRow[],
  payload: IconReadyPayload,
  currentSearchId: string,
): { next: SearchRow[]; accepted: boolean; reason?: string } {
  let next = prev;
  const res = applyHit({
    key: payload.key,
    id: payload.id,
    icon: payload.icon,
    level: payload.level,
    context: payload.context,
    currentSearchId,
    getCurrentIcon: (tid) =>
      prev.find((r) => r.id.toLowerCase() === tid.toLowerCase())?.icon,
    patch: (tid, icon) => {
      next = patchAppIconList(next as never[], tid, icon) as never as SearchRow[];
    },
  });
  return { next, accepted: res.accepted, reason: res.reason };
}

beforeEach(() => __resetIconStoreForTests());
afterEach(() => cleanup());

describe('icon-ready backfill', () => {
  it('first paint icon is empty via searchAppsOnline', async () => {
    const rows = await (
      api as never as { searchAppsOnline: () => Promise<SearchRow[]> }
    ).searchAppsOnline();
    expect(rows[0].id).toBe('o/r');
    expect(rows[0].icon).toBe('');
  });

  it('matching search_id: empty -> new event -> img', () => {
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const { next, accepted } = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r',
        level: 2,
        context: { kind: 'search', search_id: 'search-1-123', gen: 1 },
      },
      'search-1-123',
    );
    expect(accepted).toBe(true);
    expect(next[0].icon).toBe('https://cdn.simpleicons.org/r');
    const before = render(<AppIcon icon="" name="OR" appId="o/r" />);
    expect(before.container.querySelector('img')).toBeNull();
    before.unmount();
    const after = render(<AppIcon icon={next[0].icon} name="OR" appId="o/r" />);
    expect(after.container.querySelector('img')).not.toBeNull();
  });

  it('mismatched search_id stays initials', () => {
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const { next, accepted, reason } = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r',
        level: 2,
        context: { kind: 'search', search_id: 'search-2-999', gen: 2 },
      },
      'search-1-123',
    );
    expect(accepted).toBe(false);
    expect(reason).toBe('stale-search-id');
    expect(next[0].icon).toBe('');
    const { container } = render(<AppIcon icon={next[0].icon} name="OR" appId="o/r" />);
    expect(container.querySelector('img')).toBeNull();
  });
});
