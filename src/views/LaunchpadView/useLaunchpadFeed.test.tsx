/** `useLaunchpadFeed`：后台脉冲版本栅栏不覆盖本地乐观写入，讨论状态写回口。 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchpadEntry, LaunchpadFeedResponse, LaunchpadPulseItem } from '../../types';

const api = vi.hoisted(() => ({
  getLaunchpadFeed: vi.fn(),
  syncLaunchpadDiscussions: vi.fn(),
  toggleLaunchpadUpvote: vi.fn(),
  starApp: vi.fn(async () => ({})),
  unstarApp: vi.fn(async () => undefined),
}));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        prop in api ? api[prop as keyof typeof api] : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

import { applyDiscussionPatch, useLaunchpadFeed } from './useLaunchpadFeed';

function entry(id: string, overrides: Partial<LaunchpadEntry> = {}): LaunchpadEntry {
  const [owner, repo] = id.split('/');
  return {
    summary: {
      id,
      name: repo,
      owner,
      repo,
      icon: '',
      icon_bg: '',
      description: '',
      stars: 1,
      forks: 0,
      license: 'MIT',
      latest_version: 'v1',
      category: 'dev',
      category_name: 'Dev',
      is_verified: false,
      forge: 'github',
      forge_host: 'github.com',
      homepage: null,
      platforms: ['windows'],
    },
    maker_note: '',
    maker: { login: owner, avatar_url: '', html_url: '' },
    launched_at: '2027-01-10T00:00:00Z',
    stars_7d_delta: 0,
    discussion_repo: 'owner/launchpad',
    discussion_number: 7,
    discussion_node_id: 'D_7',
    discussion_url: '',
    discussion_comments_count: 2,
    discussion_upvotes: 3,
    is_pinned: false,
    viewer_has_starred: false,
    viewer_has_upvoted: false,
    ...overrides,
  };
}

function feedOf(items: LaunchpadEntry[]): LaunchpadFeedResponse {
  return {
    spotlight: [],
    items,
    discussions_repo: 'owner/launchpad',
    submit_issue_url: '',
    submit_web_url: '',
    is_stale: false,
  } as LaunchpadFeedResponse;
}

function pulse(id: string, overrides: Partial<LaunchpadPulseItem> = {}): LaunchpadPulseItem {
  return {
    id,
    discussion_repo: 'owner/launchpad',
    discussion_number: 7,
    discussion_upvotes: 3,
    discussion_comments_count: 9,
    viewer_has_upvoted: false,
    viewer_has_starred: false,
    stars: 1,
    ...overrides,
  } as LaunchpadPulseItem;
}

function find(feed: LaunchpadFeedResponse | null, id: string): LaunchpadEntry | undefined {
  return feed?.items.find((e) => e.summary.id === id);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLaunchpadFeed', () => {
  it('后台脉冲不覆盖其发起后本地写入的 Star 与顶帖，未改写条目照常合并', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feedOf([entry('acme/a'), entry('acme/b')]));
    let resolvePulse!: (v: LaunchpadPulseItem[]) => void;
    api.syncLaunchpadDiscussions.mockImplementation(
      () => new Promise<LaunchpadPulseItem[]>((r) => {
        resolvePulse = r;
      }),
    );
    api.toggleLaunchpadUpvote.mockResolvedValue({
      subject_id: 'D_7',
      upvote_count: 10,
      viewer_has_upvoted: true,
      mode: 'upvote',
    });

    const { result } = renderHook(() =>
      useLaunchpadFeed({ loggedIn: true, authKey: '1:me', onRequireLogin: vi.fn() }),
    );
    await waitFor(() => expect(result.current.feed).not.toBeNull());
    await waitFor(() => expect(api.syncLaunchpadDiscussions).toHaveBeenCalled());

    const a = find(result.current.feed, 'acme/a')!;
    await act(async () => {
      await result.current.upvote(a);
      await result.current.toggleStar(a);
    });
    await act(async () => {
      resolvePulse([
        pulse('acme/a', { discussion_upvotes: 3, viewer_has_upvoted: false, viewer_has_starred: false }),
        pulse('acme/b', { discussion_upvotes: 42, discussion_comments_count: 5, stars: 99 }),
      ]);
    });

    const nextA = find(result.current.feed, 'acme/a')!;
    expect(nextA.discussion_upvotes).toBe(10);
    expect(nextA.viewer_has_upvoted).toBe(true);
    expect(nextA.viewer_has_starred).toBe(true);
    expect(nextA.summary.stars).toBe(2);
    const nextB = find(result.current.feed, 'acme/b')!;
    expect(nextB.discussion_upvotes).toBe(42);
    expect(nextB.discussion_comments_count).toBe(5);
    expect(nextB.summary.stars).toBe(99);
  });

  it('未登录 Star 引导登录且不发写请求', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feedOf([entry('acme/a')]));
    api.syncLaunchpadDiscussions.mockResolvedValue([]);
    const onRequireLogin = vi.fn();
    const { result } = renderHook(() => useLaunchpadFeed({ loggedIn: false, authKey: '0', onRequireLogin }));
    await waitFor(() => expect(result.current.feed).not.toBeNull());
    await act(async () => {
      await result.current.toggleStar(find(result.current.feed, 'acme/a')!);
    });
    expect(onRequireLogin).toHaveBeenCalled();
    expect(api.starApp).not.toHaveBeenCalled();
  });

  it('patchDiscussionState 累加评论数、未登录恒不标记已顶', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feedOf([entry('acme/a')]));
    api.syncLaunchpadDiscussions.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useLaunchpadFeed({ loggedIn: true, authKey: '1:me', onRequireLogin: vi.fn() }),
    );
    await waitFor(() => expect(result.current.feed).not.toBeNull());
    act(() => {
      result.current.patchDiscussionState('ACME/A', { commentsDelta: 1, upvotes: 8, viewerHasUpvoted: true });
    });
    const a = find(result.current.feed, 'acme/a')!;
    expect(a.discussion_comments_count).toBe(3);
    expect(a.discussion_upvotes).toBe(8);
    expect(a.viewer_has_upvoted).toBe(true);

    expect(applyDiscussionPatch(a, { viewerHasUpvoted: true }, false).viewer_has_upvoted).toBe(false);
  });
});
