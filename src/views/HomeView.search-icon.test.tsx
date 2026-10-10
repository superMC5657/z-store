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
import { adoptEchoInWindow, settleMoreEcho, settlePageEcho } from '../app/hooks/useSearchState';
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

describe('echo-window interleavings (fix-11 hardening)', () => {
  it('1. 连输串号：快输 A→B，迟到 A-live 带 A-sid 丢，B-live 带 B-sid 收，L2→L5 只认 B', () => {
    const sidA = 'search-1-AAA';
    const sidB = 'search-2-BBB';
    // B 落定（A 迟到回包经 seq 守卫丢，从未落定期望；此处以 B-sid 为期望初态）。
    const ref = { current: '' };
    settlePageEcho(ref, sidB);
    expect(ref.current).toBe(sidB);

    const prev: SearchRow[] = [{ id: 'o/r', icon: '' }];
    // 迟到 A-live 带 A-sid：搜门丢（旧串号），图标不动。
    const aLive = applyNewIconReady(
      prev,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r-a2',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: sidA, gen: 1 },
      },
      ref.current,
    );
    expect(aLive.accepted).toBe(false);
    expect(aLive.reason).toBe('stale-search-id');
    expect(aLive.next[0].icon).toBe('');

    // B-live 带 B-sid：L2 收。
    const bL2Icon = 'https://cdn.simpleicons.org/r-b2';
    const bL2 = applyNewIconReady(
      aLive.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: bL2Icon,
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: sidB, gen: 2 },
      },
      ref.current,
    );
    expect(bL2.accepted).toBe(true);
    expect(bL2.next[0].icon).toBe(bL2Icon);

    // B 内升级 L2→L5：收。
    const bL5Icon = 'https://cdn.example.com/r-b5.png';
    const bL5 = applyNewIconReady(
      bL2.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: bL5Icon,
        level: 5,
        via: 'live',
        context: { kind: 'search', search_id: sidB, gen: 2 },
      },
      ref.current,
    );
    expect(bL5.accepted).toBe(true);
    expect(bL5.next[0].icon).toBe(bL5Icon);

    // B 内降级 L5→L2：level 门丢。
    const bDown = applyNewIconReady(
      bL5.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.simpleicons.org/r-b2-again',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: sidB, gen: 2 },
      },
      ref.current,
    );
    expect(bDown.accepted).toBe(false);
    expect(bDown.reason).toBe('level-stale');
    expect(bDown.next[0].icon).toBe(bL5Icon);

    // A 高 level 也因 sid 失配丢（搜门优先于 level，不会被高 level 冲掉 B-L5）。
    const aHigh = applyNewIconReady(
      bL5.next,
      {
        key: 'o/r',
        id: 'o/r',
        icon: 'https://cdn.example.com/r-a5.png',
        level: 9,
        via: 'live',
        context: { kind: 'search', search_id: sidA, gen: 1 },
      },
      ref.current,
    );
    expect(aHigh.accepted).toBe(false);
    expect(aHigh.reason).toBe('stale-search-id');
    expect(aHigh.next[0].icon).toBe(bL5Icon);
  });

  it('2. 翻页 interleaving：首刷 S1 落定后更多回 S2，S1 迟到 live 丢 S2 收；窗内只采首个、落定以最新覆盖', () => {
    const S1 = 'search-1-S1';
    const S2 = 'search-1-S1-p2';
    const ref = { current: '' };
    // 首刷 S1 落定。
    settlePageEcho(ref, S1);
    expect(ref.current).toBe(S1);
    // 加载更多回 S2（同 seq 落定后以最新为准）。
    expect(settleMoreEcho(ref, 2, 2, S2)).toBe(true);
    expect(ref.current).toBe(S2);
    // 旧页迟到（seq 失配）不覆盖。
    expect(settleMoreEcho(ref, 1, 2, S1)).toBe(false);
    expect(ref.current).toBe(S2);

    // S1 迟到 live 丢，S2 live 收（同行不同 sid 消歧）。
    const prev: SearchRow[] = [{ id: 'o/r-page', icon: '' }];
    const s1Late = applyNewIconReady(
      prev,
      {
        key: 'o/r-page',
        id: 'o/r-page',
        icon: 'https://cdn.simpleicons.org/r-s1',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: S1, gen: 1 },
      },
      ref.current,
    );
    expect(s1Late.accepted).toBe(false);
    expect(s1Late.reason).toBe('stale-search-id');
    expect(s1Late.next[0].icon).toBe('');
    const s2LiveIcon = 'https://cdn.simpleicons.org/r-s2';
    const s2Live = applyNewIconReady(
      s1Late.next,
      {
        key: 'o/r-page',
        id: 'o/r-page',
        icon: s2LiveIcon,
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: S2, gen: 1 },
      },
      ref.current,
    );
    expect(s2Live.accepted).toBe(true);
    expect(s2Live.next[0].icon).toBe(s2LiveIcon);

    // 窗内（期望空）S1/S2 首回声只采首个，落定后以最新覆盖。
    const w = { current: '' };
    expect(adoptEchoInWindow(w, 'search', S1)).toBe(true);
    expect(w.current).toBe(S1);
    expect(adoptEchoInWindow(w, 'search', S2)).toBe(false);
    expect(w.current).toBe(S1);
    // 首刷回声 S2 落定即覆盖窗内采用（落定后以最新为准）。
    settlePageEcho(w, S2);
    expect(w.current).toBe(S2);
    const wPrev: SearchRow[] = [{ id: 'o/r-win', icon: '' }];
    const wS1 = applyNewIconReady(
      wPrev,
      {
        key: 'o/r-win',
        id: 'o/r-win',
        icon: 'https://cdn.simpleicons.org/r-ws1',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: S1, gen: 1 },
      },
      w.current,
    );
    expect(wS1.accepted).toBe(false);
    expect(wS1.reason).toBe('stale-search-id');
    const wS2 = applyNewIconReady(
      wS1.next,
      {
        key: 'o/r-win',
        id: 'o/r-win',
        icon: 'https://cdn.simpleicons.org/r-ws2',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: S2, gen: 1 },
      },
      w.current,
    );
    expect(wS2.accepted).toBe(true);
    expect(wS2.next[0].icon).toBe('https://cdn.simpleicons.org/r-ws2');
  });

  it('3. 无 sid 兜底：legacy 无 sid 不回落请求串号，当次窗 live 照收，跨次按 sid 消歧，有 sid 到即升级', () => {
    const ref = { current: '' };
    const requestId = 'search-1-legacy-req';
    // legacy 回包无 sid：窗保持开，永不回落请求串号（echo-as-truth）。
    settlePageEcho(ref, '');
    expect(ref.current).toBe('');
    expect(ref.current).not.toBe(requestId);

    // 当次窗内无 sid live：任一空即放行，照收。
    const prev: SearchRow[] = [{ id: 'o/r-nosid-1', icon: '' }];
    const noSidIcon = 'https://cdn.simpleicons.org/r-nosid';
    const noSid = applyNewIconReady(
      prev,
      {
        key: 'o/r-nosid-1',
        id: 'o/r-nosid-1',
        icon: noSidIcon,
        level: 2,
        via: 'live',
        context: { kind: 'search', gen: 1 },
      },
      ref.current,
    );
    expect(noSid.accepted).toBe(true);
    expect(noSid.next[0].icon).toBe(noSidIcon);

    // 有 sid 回声到即升级期望（窗内首回声采用；空 kind 同语义，trend 不抢搜索窗）。
    const sidB = 'search-2-BBB';
    expect(adoptEchoInWindow(ref, 'search', sidB)).toBe(true);
    expect(ref.current).toBe(sidB);
    const ref2 = { current: '' };
    expect(adoptEchoInWindow(ref2, '', sidB)).toBe(true);
    expect(ref2.current).toBe(sidB);
    const ref3 = { current: '' };
    expect(adoptEchoInWindow(ref3, 'trend', sidB)).toBe(false);
    expect(ref3.current).toBe('');

    // 升级后：同 sid 收，旧 sid 丢（跨次消歧），无 sid 仍放行（不可区分、不锁死）。
    const cur: SearchRow[] = [{ id: 'o/r-nosid-2', icon: '' }];
    const sameSid = applyNewIconReady(
      cur,
      {
        key: 'o/r-nosid-2',
        id: 'o/r-nosid-2',
        icon: 'https://cdn.simpleicons.org/r-cur',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: sidB, gen: 2 },
      },
      ref.current,
    );
    expect(sameSid.accepted).toBe(true);
    const oldSid = applyNewIconReady(
      [{ id: 'o/r-nosid-3', icon: '' }],
      {
        key: 'o/r-nosid-3',
        id: 'o/r-nosid-3',
        icon: 'https://cdn.simpleicons.org/r-old',
        level: 2,
        via: 'live',
        context: { kind: 'search', search_id: 'search-1-AAA', gen: 1 },
      },
      ref.current,
    );
    expect(oldSid.accepted).toBe(false);
    expect(oldSid.reason).toBe('stale-search-id');
    const noSidAfter = applyNewIconReady(
      [{ id: 'o/r-nosid-4', icon: '' }],
      {
        key: 'o/r-nosid-4',
        id: 'o/r-nosid-4',
        icon: 'https://cdn.simpleicons.org/r-after',
        level: 2,
        via: 'live',
        context: { kind: 'search', gen: 2 },
      },
      ref.current,
    );
    expect(noSidAfter.accepted).toBe(true);
    expect(noSidAfter.next[0].icon).toBe('https://cdn.simpleicons.org/r-after');

    // 翻页无 sid 不覆盖旧期望；新一轮回声仍可落定（不锁死）。
    expect(settleMoreEcho(ref, 2, 2, '')).toBe(true);
    expect(ref.current).toBe(sidB);
    settlePageEcho(ref, 'search-3-CCC');
    expect(ref.current).toBe('search-3-CCC');
  });
});
