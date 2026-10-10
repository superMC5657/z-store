/**
 * 回归：搜索页首屏 icon='' 经统一 `zstore://icon-ready` 回填后转 img。
 * 回声 sid 为唯一真源：回声窗内（期望空）live L2/L3 按回声 sid 即收；
 * 期望立定后 `context.search_id` 失配（旧串号）才丢弃保持 initials
 * （与 App.tsx + `iconStore.applyHit` 世代门控同语义）。
 * `level`纯L单调（via正交）；`data:`/`via=m2`只进M1内存；M2首屏直填不走emit。
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
          return async () => ({
            rows: [
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
            ],
            sid: 'search-1-123',
          });
        if (prop === 'getOrFetchIcon') return async (_id: unknown, icon: unknown) => icon;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { api, isTauri: false, ONLINE_SEARCH_PER_PAGE: 12 };
});

import { patchAppIconList } from '../services/iconStore';
import { AppIcon } from '../components/AppIcon';
import { api } from '../services/api';
import {
  __resetIconStoreForTests,
  applyHit,
  getBufferedIcon,
  type IconReadyPayload,
} from '../services/iconStore';

interface SearchRow {
  id: string;
  icon: string;
}

// 事件直通 `applyHit`：`context.search_id` 世代门控 + 列表 `patch` 写透（与 App.tsx 回调同语义，`via`透传）。
function applyNewIconReady(
  prev: SearchRow[],
  payload: IconReadyPayload,
  currentSearchId: string,
): { next: SearchRow[]; accepted: boolean; reason?: string; persisted?: boolean } {
  let next = prev;
  const res = applyHit({
    key: payload.key,
    id: payload.id,
    icon: payload.icon,
    level: payload.level,
    via: payload.via,
    context: payload.context,
    currentSearchId,
    getCurrentIcon: (tid) =>
      prev.find((r) => r.id.toLowerCase() === tid.toLowerCase())?.icon,
    patch: (tid, icon) => {
      next = patchAppIconList(next as never[], tid, icon) as never as SearchRow[];
    },
  });
  return { next, accepted: res.accepted, reason: res.reason, persisted: res.persisted };
}

beforeEach(() => __resetIconStoreForTests());
afterEach(() => cleanup());

describe('icon-ready backfill', () => {
  it('first paint icon is empty via searchAppsOnline', async () => {
    const res = await (
      api as never as { searchAppsOnline: () => Promise<{ rows: SearchRow[]; sid: string }> }
    ).searchAppsOnline();
    expect(res.rows[0].id).toBe('o/r');
    expect(res.rows[0].icon).toBe('');
    expect(res.sid).toBe('search-1-123');
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
        via: 'live',
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

  it('首刷回声窗内 live L2/L3 按回声 sid 即收（期望空不判 stale）', () => {
    const echo = 'search-9-echo';
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const l2 = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: echo, gen: 9 },
      },
      '',
    );
    expect(l2.reason).toBeUndefined();
    expect(l2.accepted).toBe(true);
    expect(l2.next[0].icon).toBe('https://cdn.simpleicons.org/r');
    const l3 = applyNewIconReady(
      l2.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://raw.githubusercontent.com/o/r/main/icon.png',
        level: 3,
        via: 'live',
        context: { kind: 'search', search_id: echo, gen: 9 },
      },
      '',
    );
    expect(l3.accepted).toBe(true);
    expect(l3.next[0].icon).toBe('https://raw.githubusercontent.com/o/r/main/icon.png');
    const after = render(<AppIcon icon={l3.next[0].icon} name="OR" appId="o/r" />);
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
        via: 'live',
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

  it('via=m2 http 只进M1内存不落盘（仍patch+缓冲）', () => {
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const { next, accepted, reason, persisted } = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r',
        level: 2,
        via: 'm2',
        context: { kind: 'search', search_id: 'search-1-123', gen: 1 },
      },
      'search-1-123',
    );
    expect(accepted).toBe(true);
    expect(persisted).toBe(false);
    expect(reason).toBe('m2-memory-only');
    expect(next[0].icon).toBe('https://cdn.simpleicons.org/r');
    expect(getBufferedIcon('o/r')).toBe('https://cdn.simpleicons.org/r');
  });

  it('level纯L单调：4为L（2→4接受，4→2丢弃，via正交不绕单调）', () => {
    const sid = 'search-1-123';
    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    const first = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r2',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: sid, gen: 1 },
      },
      sid,
    );
    expect(first.accepted).toBe(true);
    const second = applyNewIconReady(
      first.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.example.com/r4.png',
        level: 4,
        via: 'live',
        context: { kind: 'search', search_id: sid, gen: 1 },
      },
      sid,
    );
    expect(second.accepted).toBe(true);
    expect(second.next[0].icon).toBe('https://cdn.example.com/r4.png');
    const stale = applyNewIconReady(
      second.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r2-again',
        level: 2,
        via: 'm2',
        context: { kind: 'search', search_id: sid, gen: 1 },
      },
      sid,
    );
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('level-stale');
    expect(stale.next[0].icon).toBe('https://cdn.example.com/r4.png');
  });
});
