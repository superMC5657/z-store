import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '../i18n';
import type { LaunchpadEntry, LaunchpadFeedResponse, LaunchpadPulseItem, OAuthUser } from '../types';
import type { PlatformId } from '../lib/platformFilter';
import { PLATFORM_IDS } from '../lib/platformFilter';
import { sortLaunchpadItems } from './LaunchpadView/sortLaunchpad';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const api = vi.hoisted(() => ({
  getLaunchpadFeed: vi.fn(),
  syncLaunchpadDiscussions: vi.fn(async (): Promise<LaunchpadPulseItem[]> => []),
  starApp: vi.fn(),
  unstarApp: vi.fn(),
  openUrl: vi.fn(async () => undefined),
  toggleLaunchpadUpvote: vi.fn(),
  getLaunchpadDiscussion: vi.fn(),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        prop in api ? api[prop as keyof typeof api] : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

import { LaunchpadView } from './LaunchpadView';

const NOW = Date.parse('2027-01-15T00:00:00Z');

function entry(
  id: string,
  opts: Partial<LaunchpadEntry> & { forge?: string; platforms?: string[]; stars?: number } = {},
): LaunchpadEntry {
  const coord = id.includes(':') ? id.split(':')[1] : id;
  const [owner, repo] = coord.split('/');
  const { forge = 'github', platforms = ['windows'], stars = 10, ...rest } = opts;
  return {
    summary: {
      id,
      name: repo,
      owner,
      repo,
      icon: '',
      icon_bg: '',
      description: `${repo} desc`,
      stars,
      forks: 0,
      license: 'MIT',
      latest_version: 'v1.0.0',
      category: 'dev',
      category_name: 'Dev',
      is_verified: false,
      is_cataloged: false,
      forge,
      forge_host: forge === 'github' ? 'github.com' : 'codeberg.org',
      homepage: null,
      platforms,
    },
    maker_note: `${repo} 中文自荐`,
    maker_note_en: `${repo} english pitch`,
    maker: { login: owner, avatar_url: '', html_url: `https://codeberg.org/${owner}` },
    launched_at: '2027-01-10T00:00:00Z',
    stars_7d_delta: 0,
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 1,
    discussion_node_id: 'D_1',
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
    discussion_comments_count: 0,
    discussion_upvotes: 0,
    is_pinned: false,
    viewer_has_starred: false,
    ...rest,
  };
}

function feed(spotlight: LaunchpadEntry[], items: LaunchpadEntry[]): LaunchpadFeedResponse {
  return {
    spotlight,
    items,
    discussions_repo: 'superMC5657/z-store-launchpad',
    submit_issue_url: 'https://github.com/x/issues/new',
    submit_web_url: 'https://z-store-web.pages.dev/launchpad/submit',
    is_stale: false,
  };
}

const user: OAuthUser = { login: 'me', has_list_scope: true, is_expired: false };

function renderView(overrides: Partial<React.ComponentProps<typeof LaunchpadView>> = {}) {
  const props = {
    selectedPlatforms: new Set<PlatformId>(PLATFORM_IDS),
    installedIds: new Set<string>(),
    oauthUser: user as OAuthUser | null,
    onOpenDetail: vi.fn(),
    onQuickInstall: vi.fn(),
    onOpenDeveloper: vi.fn(),
    onOpenAccount: vi.fn(),
    onResetPlatformFilter: vi.fn(),
    onDisplayPlatformCounts: vi.fn(),
    ...overrides,
  };
  const r = render(<LaunchpadView {...props} />);
  return { ...r, props };
}

function recentOrder(): string[] {
  const grid = document.querySelector('.launchpad-grid')!;
  return Array.from(grid.querySelectorAll('[data-launchpad-id]')).map((el) => el.getAttribute('data-launchpad-id')!);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => cleanup());

describe('LaunchpadView', () => {
  it('置顶卡带「置顶推荐」标签与自荐语，且不在最新上架里重复', async () => {
    const pinned = entry('acme/hyper', { is_pinned: true, pin_tier: 'sponsor' });
    api.getLaunchpadFeed.mockResolvedValue(feed([pinned], [entry('b/two'), entry('c/three')]));
    renderView();
    const card = await screen.findByTestId('launchpad-card-acme/hyper');
    expect(within(card).getByText('置顶推荐').className).toBe('status-tag');
    expect(within(card).getByText('hyper 中文自荐')).toBeTruthy();
    expect(screen.getAllByTestId('launchpad-card-acme/hyper')).toHaveLength(1);
    expect(recentOrder()).not.toContain('acme/hyper');
    const badges = Array.from(document.querySelectorAll('.launchpad-section-title .count-badge')).map((b) => b.textContent);
    expect(badges).toEqual(['1', '2']);
  });

  it('三档排序重排新品流且不改变集合大小', async () => {
    const fresh = entry('a/fresh', { launched_at: '2027-01-14T00:00:00Z' });
    const talked = entry('b/talked', { launched_at: '2027-01-01T00:00:00Z', discussion_comments_count: 40, discussion_upvotes: 5 });
    const starry = entry('c/starry', { launched_at: '2027-01-14T00:00:00Z', stars: 900 });
    api.getLaunchpadFeed.mockResolvedValue(feed([], [fresh, talked, starry]));
    renderView();
    await screen.findByTestId('launchpad-card-a/fresh');
    fireEvent.click(screen.getByRole('tab', { name: '最新上架' }));
    expect(recentOrder()).toEqual(['c/starry', 'a/fresh', 'b/talked']);
    fireEvent.click(screen.getByRole('tab', { name: '讨论热度' }));
    expect(recentOrder()[0]).toBe('b/talked');
    expect(recentOrder()).toHaveLength(3);
  });

  it('点击作者头像呼起开发者画像（非 GitHub 源走外链）', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed([], [entry('acme/hyper'), entry('codeberg:pix/palette', { forge: 'codeberg' })]),
    );
    const { props } = renderView();
    const card = await screen.findByTestId('launchpad-card-acme/hyper');
    fireEvent.click(within(card).getByRole('button', { name: '查看 @acme 的主页' }));
    expect(props.onOpenDeveloper).toHaveBeenCalledWith('acme');
    expect(props.onOpenDetail).not.toHaveBeenCalled();

    const cb = screen.getByTestId('launchpad-card-codeberg:pix/palette');
    fireEvent.click(within(cb).getByRole('button', { name: '查看 @pix 的主页' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://codeberg.org/pix');
  });

  it('GitHub 源一键 Star / 取消 Star 更新星数；Codeberg 源无 Star 写按钮、外链走 openUrl', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed([], [entry('acme/hyper', { stars: 10 }), entry('codeberg:pix/palette', { forge: 'codeberg', stars: 5 })]),
    );
    api.starApp.mockResolvedValue({ starred: true, in_list: true });
    api.unstarApp.mockResolvedValue(true);
    renderView();
    const star = await screen.findByTestId('launchpad-star-acme/hyper');
    await act(async () => {
      fireEvent.click(star);
    });
    expect(api.starApp).toHaveBeenCalledWith('acme/hyper');
    await waitFor(() => expect(screen.getByTestId('launchpad-star-acme/hyper').textContent).toContain('11'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-star-acme/hyper'));
    });
    expect(api.unstarApp).toHaveBeenCalledWith('acme/hyper');
    await waitFor(() => expect(screen.getByTestId('launchpad-star-acme/hyper').textContent).toContain('10'));

    expect(screen.queryByTestId('launchpad-star-codeberg:pix/palette')).toBeNull();
    fireEvent.click(screen.getByTestId('launchpad-source-codeberg:pix/palette'));
    expect(api.openUrl).toHaveBeenCalledWith('https://codeberg.org/pix/palette');
  });

  it('未登录点击 Star 不发写请求并引导账号设置', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feed([], [entry('acme/hyper')]));
    const { props } = renderView({ oauthUser: null });
    fireEvent.click(await screen.findByTestId('launchpad-star-acme/hyper'));
    expect(api.starApp).not.toHaveBeenCalled();
    expect(props.onOpenAccount).toHaveBeenCalled();
  });

  it('平台筛空时渲染 FilterEmptyState，侧栏上报全量未裁剪分布', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed([entry('a/win', { is_pinned: true, platforms: ['windows'] })], [entry('b/mac', { platforms: ['macos'] })]),
    );
    const onDisplayPlatformCounts = vi.fn();
    const { props } = renderView({ selectedPlatforms: new Set<PlatformId>(['linux']), onDisplayPlatformCounts });
    const reset = await screen.findByRole('button', { name: '重置设备筛选' });
    fireEvent.click(reset);
    expect(props.onResetPlatformFilter).toHaveBeenCalled();
    await waitFor(() => expect(onDisplayPlatformCounts).toHaveBeenCalled());
    const counts = onDisplayPlatformCounts.mock.calls.at(-1)?.[0] as Record<string, number>;
    expect(counts.windows).toBe(1);
    expect(counts.macos).toBe(1);
    expect(counts.linux).toBe(0);
  });

  it('英文界面优先展示 maker_note_en 且无残留中文', async () => {
    await i18n.changeLanguage('en-US');
    api.getLaunchpadFeed.mockResolvedValue(feed([entry('acme/hyper', { is_pinned: true })], [entry('b/two')]));
    renderView();
    const card = await screen.findByTestId('launchpad-card-acme/hyper');
    expect(within(card).getByText('hyper english pitch')).toBeTruthy();
    expect(within(card).getByText('Spotlight')).toBeTruthy();
    const text = document.querySelector('.launchpad-view')!.textContent ?? '';
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it('网络失败且无缓存时展示重试', async () => {
    api.getLaunchpadFeed.mockRejectedValueOnce(new Error('offline'));
    api.getLaunchpadFeed.mockResolvedValueOnce(feed([], [entry('acme/hyper')]));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('launchpad-card-acme/hyper')).toBeTruthy();
    expect(api.getLaunchpadFeed).toHaveBeenLastCalledWith(true);
  });

  it('离线快照展示提示条但不阻断浏览', async () => {
    api.getLaunchpadFeed.mockResolvedValue({ ...feed([], [entry('acme/hyper')]), is_stale: true });
    renderView();
    expect(await screen.findByTestId('launchpad-card-acme/hyper')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('离线缓存');
  });

  it('登录态在卡片上顶帖并回写计数', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feed([], [entry('acme/hyper', { discussion_upvotes: 3 })]));
    api.toggleLaunchpadUpvote.mockResolvedValue({ subject_id: 'D_1', upvote_count: 4, viewer_has_upvoted: true, mode: 'upvote' });
    renderView();
    const btn = await screen.findByTestId('launchpad-upvote-acme/hyper');
    expect(btn.querySelector('svg')?.getAttribute('fill')).toBe('none');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(api.toggleLaunchpadUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 1,
      subjectId: 'D_1',
      currentlyUpvoted: false,
    });
    await waitFor(() => expect(screen.getByTestId('launchpad-upvote-acme/hyper').textContent).toBe('4'));
    expect(screen.getByTestId('launchpad-upvote-acme/hyper').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-upvote-acme/hyper').querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
  });

  it('点击卡片默认打开讨论弹窗，详情从讨论内跳转；无讨论绑定的卡片直接打开详情', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed([], [entry('acme/hyper'), entry('solo/tool', { discussion_number: 0, discussion_repo: '' })]),
    );
    api.getLaunchpadDiscussion.mockResolvedValue({
      id: 'D_1',
      number: 1,
      title: 'hyper',
      body: 'post body',
      url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
      created_at: '2027-01-10T00:00:00Z',
      locked: false,
      closed: false,
      author: { login: 'zstore-bot', avatar_url: '', html_url: '' },
      category_name: 'Launches',
      upvote_count: 0,
      viewer_has_upvoted: false,
      viewer_can_upvote: true,
      viewer_can_comment: true,
      auth_required_for_write: false,
      comments_total: 0,
      has_next_page: false,
      end_cursor: null,
      comments: [],
      is_stale: false,
    });
    const { props } = renderView();
    fireEvent.click(await screen.findByTestId('launchpad-card-acme/hyper'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('launchpad-discussion-modal');
    expect(props.onOpenDetail).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('launchpad-open-detail'));
    expect(props.onOpenDetail).toHaveBeenCalledWith('acme/hyper');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('launchpad-card-solo/tool'));
    expect(props.onOpenDetail).toHaveBeenLastCalledWith('solo/tool');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开讨论弹窗拿到最新 discussions 数据后同步更新卡片顶帖数、已顶态与评论数', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed([], [entry('acme/hyper', { discussion_upvotes: 0, discussion_comments_count: 0 })]),
    );
    api.getLaunchpadDiscussion.mockResolvedValue({
      id: 'D_1',
      number: 1,
      title: 'HyperTerm',
      body: 'hello',
      url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
      created_at: '2027-01-10T00:00:00Z',
      locked: false,
      closed: false,
      author: { login: 'acme', avatar_url: '', html_url: '' },
      category_name: 'Launches',
      upvote_count: 7,
      viewer_has_upvoted: true,
      viewer_can_upvote: true,
      viewer_can_comment: true,
      auth_required_for_write: false,
      comments_total: 4,
      has_next_page: false,
      end_cursor: null,
      comments: [],
      is_stale: false,
    });
    renderView();
    const card = await screen.findByTestId('launchpad-card-acme/hyper');
    expect(within(card).getByTestId('launchpad-upvote-acme/hyper').textContent).toBe('0');
    expect(within(card).getByTestId('launchpad-discussion-acme/hyper').textContent).toBe('0');

    fireEvent.click(within(card).getByTestId('launchpad-discussion-acme/hyper'));
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByTestId('launchpad-discussion-upvote').textContent).toBe('7'));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByTestId('launchpad-upvote-acme/hyper').textContent).toBe('7');
    expect(screen.getByTestId('launchpad-upvote-acme/hyper').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-discussion-acme/hyper').textContent).toBe('4');
  });

  it('进入广场时自动根据 syncLaunchpadDiscussions 刷新卡片计数/已顶态/星数，且数据库水合的已顶态跨重启保留', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed(
        [],
        [
          entry('supermc5657/z-viewer', {
            stars: 0,
            discussion_number: 3,
            discussion_upvotes: 0,
            discussion_comments_count: 0,
            viewer_has_upvoted: false,
          }),
        ],
      ),
    );
    api.syncLaunchpadDiscussions.mockResolvedValueOnce([
      {
        id: 'supermc5657/z-viewer',
        discussion_repo: 'superMC5657/z-store-launchpad',
        discussion_number: 3,
        discussion_node_id: 'D_3',
        discussion_upvotes: 6,
        discussion_comments_count: 2,
        viewer_has_upvoted: true,
        stars: 12,
        latest_version: 'v0.3.3',
        viewer_has_starred: true,
      },
    ]);

    const first = renderView();
    await waitFor(() =>
      expect(screen.getByTestId('launchpad-upvote-supermc5657/z-viewer').textContent).toBe('6'),
    );
    expect(api.syncLaunchpadDiscussions).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('launchpad-upvote-supermc5657/z-viewer').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-discussion-supermc5657/z-viewer').textContent).toBe('2');
    expect(screen.getByTestId('launchpad-star-supermc5657/z-viewer').textContent).toContain('12');
    expect(screen.getByTestId('launchpad-star-supermc5657/z-viewer').getAttribute('aria-pressed')).toBe('true');
    first.unmount();

    // 模拟重启应用后数据库直接水合出已保存的 viewer_has_upvoted / 计数（离线时 sync 返回空）
    api.getLaunchpadFeed.mockResolvedValueOnce(
      feed(
        [],
        [
          entry('supermc5657/z-viewer', {
            stars: 12,
            discussion_number: 3,
            discussion_node_id: 'D_3',
            discussion_upvotes: 6,
            discussion_comments_count: 2,
            viewer_has_upvoted: true,
            viewer_has_starred: true,
          }),
        ],
      ),
    );
    api.syncLaunchpadDiscussions.mockResolvedValueOnce([]);
    api.toggleLaunchpadUpvote.mockResolvedValueOnce({
      subject_id: 'D_3',
      upvote_count: 5,
      viewer_has_upvoted: false,
      mode: 'upvote',
    });

    renderView();
    const upvoteBtn = await screen.findByTestId('launchpad-upvote-supermc5657/z-viewer');
    expect(upvoteBtn.textContent).toBe('6');
    expect(upvoteBtn.getAttribute('aria-pressed')).toBe('true');

    // 再次点击应发送 currentlyUpvoted: true（取消顶帖），而非丢失状态误发 false
    await act(async () => {
      fireEvent.click(upvoteBtn);
    });
    expect(api.toggleLaunchpadUpvote).toHaveBeenCalledWith({
      discussionRepo: 'superMC5657/z-store-launchpad',
      discussionNumber: 3,
      subjectId: 'D_3',
      currentlyUpvoted: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('launchpad-upvote-supermc5657/z-viewer').textContent).toBe('5'),
    );
    expect(screen.getByTestId('launchpad-upvote-supermc5657/z-viewer').getAttribute('aria-pressed')).toBe('false');
  });

  it('空状态时页头与空态投稿按钮互不串扰，一次只展开一个菜单', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feed([], []));
    renderView();
    await screen.findByText('广场还没有上架作品');
    const buttons = screen.getAllByRole('button', { name: '提交我的开源作品' });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(buttons[1].getAttribute('aria-expanded')).toBe('true');
    const emptyWrapper = screen.getAllByRole('menuitem')[0].closest('.flyout-menu')?.parentElement;
    expect(emptyWrapper?.getAttribute('data-align')).toBe('center');
    expect(emptyWrapper?.style.left).toBe('50%');
    expect(emptyWrapper?.style.transform).toBe('translateX(-50%)');
    expect(screen.getAllByRole('menuitem')[0].closest<HTMLElement>('.flyout-menu')?.style.transform).toBe('');

    fireEvent.click(buttons[0]);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    expect(buttons[1].getAttribute('aria-expanded')).toBe('false');
    const headerWrapper = screen.getAllByRole('menuitem')[0].closest('.flyout-menu')?.parentElement;
    expect(headerWrapper?.getAttribute('data-align')).toBe('right');
    expect(headerWrapper?.style.right).toBe('0px');
  });

  it('首次加载中与空态刷新期间不闪出排序栏（推荐/最新上架/讨论热度）', async () => {
    let resolveInitial!: (v: LaunchpadFeedResponse) => void;
    api.getLaunchpadFeed.mockImplementationOnce(
      () => new Promise<LaunchpadFeedResponse>((resolve) => { resolveInitial = resolve; }),
    );
    renderView();
    expect(screen.queryByRole('tablist', { name: '最新上架排序' })).toBeNull();
    expect(screen.queryByText('广场还没有上架作品')).toBeNull();

    await act(async () => {
      resolveInitial(feed([], []));
    });
    expect(await screen.findByText('广场还没有上架作品')).toBeTruthy();

    let resolveRefresh!: (v: LaunchpadFeedResponse) => void;
    api.getLaunchpadFeed.mockImplementationOnce(
      () => new Promise<LaunchpadFeedResponse>((resolve) => { resolveRefresh = resolve; }),
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(screen.getByText('广场还没有上架作品')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: '最新上架排序' })).toBeNull();

    await act(async () => {
      resolveRefresh(feed([], []));
    });
    expect(screen.getByText('广场还没有上架作品')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: '最新上架排序' })).toBeNull();
  });

  it('局部脉冲缺失讨论计数时不冲零卡片原有顶帖数与评论数', async () => {
    api.getLaunchpadFeed.mockResolvedValue(
      feed(
        [],
        [
          entry('acme/hyper', {
            stars: 10,
            discussion_upvotes: 4,
            discussion_comments_count: 7,
            viewer_has_upvoted: true,
          }),
        ],
      ),
    );
    api.syncLaunchpadDiscussions.mockResolvedValueOnce([
      {
        id: 'acme/hyper',
        discussion_repo: 'superMC5657/z-store-launchpad',
        discussion_number: 1,
        discussion_upvotes: null,
        discussion_comments_count: null,
        viewer_has_upvoted: null,
        stars: 22,
        forks: 3,
        latest_version: 'v1.2.0',
        viewer_has_starred: true,
      },
    ]);
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId('launchpad-star-acme/hyper').textContent).toContain('22'),
    );
    expect(screen.getByTestId('launchpad-upvote-acme/hyper').textContent).toBe('4');
    expect(screen.getByTestId('launchpad-upvote-acme/hyper').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('launchpad-discussion-acme/hyper').textContent).toBe('7');
  });

  it('讨论抽屉打开期间完成登录会自动重拉详情并解锁评论输入', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feed([], [entry('acme/hyper')]));
    api.getLaunchpadDiscussion
      .mockResolvedValueOnce({
        id: 'D_1',
        number: 1,
        title: 'HyperTerm',
        body: 'hello',
        url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
        created_at: '2027-01-10T00:00:00Z',
        locked: false,
        closed: false,
        author: { login: 'acme', avatar_url: '', html_url: '' },
        category_name: 'Launches',
        upvote_count: 1,
        viewer_has_upvoted: false,
        viewer_can_upvote: false,
        viewer_can_comment: false,
        auth_required_for_write: true,
        comments_total: 0,
        has_next_page: false,
        end_cursor: null,
        comments: [],
        is_stale: false,
      })
      .mockResolvedValueOnce({
        id: 'D_1',
        number: 1,
        title: 'HyperTerm',
        body: 'hello',
        url: 'https://github.com/superMC5657/z-store-launchpad/discussions/1',
        created_at: '2027-01-10T00:00:00Z',
        locked: false,
        closed: false,
        author: { login: 'acme', avatar_url: '', html_url: '' },
        category_name: 'Launches',
        upvote_count: 2,
        viewer_has_upvoted: true,
        viewer_can_upvote: true,
        viewer_can_comment: true,
        auth_required_for_write: false,
        comments_total: 0,
        has_next_page: false,
        end_cursor: null,
        comments: [],
        is_stale: false,
      });

    const view = renderView({ oauthUser: null });
    const card = await screen.findByTestId('launchpad-card-acme/hyper');
    fireEvent.click(within(card).getByTestId('launchpad-discussion-acme/hyper'));
    expect(await screen.findByTestId('launchpad-login-bar')).toBeTruthy();

    view.rerender(
      <LaunchpadView
        selectedPlatforms={new Set<PlatformId>(PLATFORM_IDS)}
        installedIds={new Set<string>()}
        oauthUser={user}
        onOpenDetail={vi.fn()}
        onQuickInstall={vi.fn()}
        onOpenDeveloper={vi.fn()}
        onOpenAccount={vi.fn()}
        onResetPlatformFilter={vi.fn()}
        onDisplayPlatformCounts={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('launchpad-comment-input')).toBeTruthy();
    expect(screen.getByTestId('launchpad-discussion-upvote').textContent).toBe('2');
    expect(screen.getByTestId('launchpad-discussion-upvote').getAttribute('aria-pressed')).toBe('true');
  });

  it('从 Flyout 打开应用内投稿预检向导，从卡片分享按钮打开 README 徽章弹窗', async () => {
    api.getLaunchpadFeed.mockResolvedValue(feed([], [entry('acme/hyper')]));
    renderView();
    const card = await screen.findByTestId('launchpad-card-acme/hyper');

    // Open share badge modal from LaunchpadCard
    fireEvent.click(within(card).getByTestId('launchpad-share-acme/hyper'));
    const shareDialog = await screen.findByRole('dialog');
    expect(shareDialog.className).toContain('share-badge-modal');
    expect(within(shareDialog).getByTestId('share-code-deeplink').textContent).toBe(
      'zstore://launchpad/acme/hyper',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Open submission preflight wizard from header flyout menu
    fireEvent.click(screen.getByRole('button', { name: '提交我的开源作品' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /应用内预检投稿/ }));
    const wizardDialog = await screen.findByRole('dialog');
    expect(wizardDialog.className).toContain('launchpad-submit-modal');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('sortLaunchpadItems', () => {
  it('推荐分随时间衰减，并列按上架时间与 id 决胜', () => {
    const old = entry('a/old', { launched_at: '2026-11-01T00:00:00Z', discussion_upvotes: 5 });
    const fresh = entry('b/fresh', { launched_at: '2027-01-14T00:00:00Z' });
    const twinA = entry('c/twin', { launched_at: '2027-01-14T00:00:00Z' });
    const out = sortLaunchpadItems([old, twinA, fresh], 'recommended', NOW).map((e) => e.summary.id);
    expect(out).toEqual(['b/fresh', 'c/twin', 'a/old']);
  });
});
