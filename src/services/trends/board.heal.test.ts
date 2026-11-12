/**
 * 富卡治愈回归（经 `createTrendBoardSession` 深度控制器验证 `zstore:detail-richcard-healed`）：
 * - 占位简介即使误带 dirty 也不覆盖实值；
 * - 镜像键缺席时经行 id 别名仍可命中；
 * - 预 enrich 行创建时剥图标通道与占位简介；
 * - 会话生命周期（`dispose()` 后重新 `start()` 与多会话隔离）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DETAIL_RICHCARD_HEAL_EVENT,
  clearTrendEnrichCache,
  clearTrendsCache,
  createTrendBoardSession,
  putTrendEnrichMemory,
  type DetailRichcardHealPayload,
} from '../trends';
import { CMD, tauriApi } from '../api';
import * as clientModule from '../api/client';
import { makeEnrichedApp, makeTrendRepo } from '../../views/test-utils/trendFixture';

const REAL_DESC = 'A fast in-browser Markdown reserve editor';
const REAL_DESC_EN = 'A fast in-browser Markdown editor';
const PLACEHOLDER_DESC = 'GitHub 社区开源项目';
const PLACEHOLDER_DESC_EN = 'No description available';
const FALLBACK_BG = 'linear-gradient(135deg, #475569, #334155)';

function healPayload(overrides: Partial<DetailRichcardHealPayload>): DetailRichcardHealPayload {
  return {
    keys: ['acme/atlas'],
    summary: makeEnrichedApp({ id: 'acme/atlas' }),
    dirtyFields: [],
    ...overrides,
  };
}

function startSessionWithRepos(
  initialEnrichedApps: Record<string, ReturnType<typeof makeEnrichedApp>>,
  repoIds: string[],
) {
  const session = createTrendBoardSession({ initialEnrichedApps });
  session.start();
  session.syncBoard({
    trendResult: {
      repos: repoIds.map((id) => makeTrendRepo({ id })),
      status: 'ok',
      stale: false,
    },
    activeBoard: 'weekly',
    trendFetchOpts: {},
  });
  return session;
}

describe('富卡治愈事件占位守卫', () => {
  afterEach(() => {
    clearTrendEnrichCache();
  });

  it('占位简介误带 dirty 不覆盖实值，其余 dirty 仍覆盖', () => {
    const prev = {
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        description: REAL_DESC,
        description_en: REAL_DESC_EN,
        stars: 100,
      }),
    };
    const session = startSessionWithRepos(prev, ['acme/atlas']);
    try {
      window.dispatchEvent(
        new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, {
          detail: healPayload({
            summary: makeEnrichedApp({
              id: 'acme/atlas',
              description: PLACEHOLDER_DESC,
              description_en: PLACEHOLDER_DESC_EN,
              stars: 200,
            }),
            dirtyFields: ['description', 'description_en', 'stars'],
          }),
        }),
      );
      const next = session.getSnapshot().enrichedApps;
      expect(next).not.toBe(prev);
      expect(next['acme/atlas']?.description).toBe(REAL_DESC);
      expect(next['acme/atlas']?.description_en).toBe(REAL_DESC_EN);
      expect(next['acme/atlas']?.stars).toBe(200);
    } finally {
      session.dispose();
    }
  });

  it('真实简介 dirty 正常覆盖', () => {
    const prev = {
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', description: REAL_DESC }),
    };
    const session = startSessionWithRepos(prev, ['acme/atlas']);
    try {
      window.dispatchEvent(
        new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, {
          detail: healPayload({
            summary: makeEnrichedApp({ id: 'acme/atlas', description: 'A brand new real description' }),
            dirtyFields: ['description'],
          }),
        }),
      );
      expect(session.getSnapshot().enrichedApps['acme/atlas']?.description).toBe(
        'A brand new real description',
      );
    } finally {
      session.dispose();
    }
  });
});

describe('富卡治愈事件别名与跨榜隔离', () => {
  afterEach(() => {
    clearTrendEnrichCache();
  });

  it('镜像键缺席时经行 id 别名命中并补丁', () => {
    const prev = {
      'legacy-key': makeEnrichedApp({ id: 'acme/atlas', stars: 100 }),
    };
    const session = startSessionWithRepos(prev, ['acme/atlas']);
    try {
      window.dispatchEvent(
        new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, {
          detail: healPayload({
            summary: makeEnrichedApp({ id: 'acme/atlas', stars: 300 }),
            dirtyFields: ['stars'],
          }),
        }),
      );
      expect(session.getSnapshot().enrichedApps['legacy-key']?.stars).toBe(300);
    } finally {
      session.dispose();
    }
  });

  it('镜像与别名均未命中时保持原引用不变', () => {
    const prev = {
      'other/app': makeEnrichedApp({ id: 'other/app', stars: 100 }),
    };
    const session = startSessionWithRepos(prev, ['other/app']);
    try {
      const before = session.getSnapshot().enrichedApps;
      window.dispatchEvent(
        new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, {
          detail: healPayload({
            summary: makeEnrichedApp({ id: 'acme/atlas', stars: 300 }),
            dirtyFields: ['stars'],
          }),
        }),
      );
      expect(session.getSnapshot().enrichedApps).toBe(before);
    } finally {
      session.dispose();
    }
  });
});

describe('富卡治愈事件预 enrich 行合成', () => {
  afterEach(() => {
    clearTrendEnrichCache();
  });

  it('合成行剥图标通道与占位简介，平台取详情实值', () => {
    const session = startSessionWithRepos({}, ['acme/atlas']);
    try {
      window.dispatchEvent(
        new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, {
          detail: healPayload({
            keys: ['Acme/Atlas'],
            summary: makeEnrichedApp({
              id: 'acme/atlas',
              name: 'atlas',
              icon: 'https://cdn.example/icon.png',
              icon_bg: 'linear-gradient(red, blue)',
              description: PLACEHOLDER_DESC,
              description_en: PLACEHOLDER_DESC_EN,
              stars: 42,
              platforms: ['macos'],
            }),
            dirtyFields: ['stars'],
            platforms: ['windows', 'macos'],
          }),
        }),
      );
      const row = session.getSnapshot().enrichedApps['acme/atlas'];
      expect(row).toBeDefined();
      expect(row?.name).toBe('atlas');
      expect(row?.stars).toBe(42);
      expect(row?.icon).toBe('');
      expect(row?.icon_bg).toBe(FALLBACK_BG);
      expect(row?.description).toBe('');
      expect(row?.description_en).toBe('');
      expect(row?.platforms).toEqual(['windows', 'macos']);
    } finally {
      session.dispose();
    }
  });
});

describe('createTrendBoardSession 生命周期与会话隔离', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearTrendsCache();
    clearTrendEnrichCache();
  });

  it('dispose() 后再次 start() 可对同一 trendResult 重跑回填与 enrich（StrictMode 安全）', async () => {
    const repoAtlas = makeTrendRepo({ id: 'acme/atlas', stars: 120 });
    const repoBeacon = makeTrendRepo({ id: 'acme/beacon', stars: 90 });
    const trendResult = { status: 'ok' as const, repos: [repoAtlas, repoBeacon], stale: false };
    const bareAtlas = makeEnrichedApp({ id: 'acme/atlas', icon: '', platforms: ['windows'] });
    const fullBeacon = makeEnrichedApp({
      id: 'acme/beacon',
      icon: 'https://cdn.example/beacon.png',
      platforms: ['linux'],
    });
    // SWR 含空图标行 `acme/atlas`（触发 DB 回填）；`acme/beacon` 未命中缓存（触发 enrich）。
    putTrendEnrichMemory({ 'acme/atlas': bareAtlas });

    const confirmSpy = vi
      .spyOn(tauriApi, 'getConfirmedIconsBatch')
      .mockResolvedValue([null]);
    const enrichSpy = vi
      .spyOn(tauriApi, 'enrichTrendRepos')
      .mockResolvedValue([fullBeacon]);

    const session = createTrendBoardSession();
    try {
      session.start();
      session.syncBoard({ trendResult, activeBoard: 'weekly', trendFetchOpts: {} });
      session.syncEnrichment({
        trendResult,
        activeBoard: 'weekly',
        trendFetchOpts: {},
        displayItems: [
          { type: 'uncataloged', repo: repoAtlas },
          { type: 'uncataloged', repo: repoBeacon },
        ],
        boardReady: true,
        consumeForceEnrich: () => false,
      });

      // StrictMode unmount 触发 dispose() 取消在飞任务后，remount 再次 start() 必须重跑同一 trendResult。
      session.dispose();
      confirmSpy.mockResolvedValueOnce(['https://cdn.example/atlas.png']);
      enrichSpy.mockResolvedValueOnce([fullBeacon]);

      session.start();
      session.syncBoard({ trendResult, activeBoard: 'weekly', trendFetchOpts: {} });
      session.syncEnrichment({
        trendResult,
        activeBoard: 'weekly',
        trendFetchOpts: {},
        displayItems: [
          { type: 'uncataloged', repo: repoAtlas },
          { type: 'uncataloged', repo: repoBeacon },
        ],
        boardReady: true,
        consumeForceEnrich: () => false,
      });

      await vi.waitFor(() => {
        expect(session.getSnapshot().enrichedApps['acme/atlas']?.icon).toBe(
          'https://cdn.example/atlas.png',
        );
        expect(session.getSnapshot().enrichedApps['acme/beacon']?.icon).toBe(
          'https://cdn.example/beacon.png',
        );
      });
      expect(enrichSpy).toHaveBeenCalledTimes(2);
      expect(confirmSpy).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  it('多会话并发时 dispose 仅刷新本会话的榜单持久化引用', async () => {
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
    const savedKeys: string[] = [];
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd, args) => {
      if (cmd === CMD.getTrendBoardCache) return null;
      if (cmd === CMD.saveTrendBoardCache) {
        savedKeys.push(String((args as { cacheKey?: unknown })?.cacheKey ?? ''));
      }
      return undefined;
    });

    const repoA = makeTrendRepo({ id: 'acme/alpha', stars: 10 });
    const repoB = makeTrendRepo({ id: 'acme/beta', stars: 20 });

    const sessionA = createTrendBoardSession({
      initialEnrichedApps: {
        'acme/alpha': makeEnrichedApp({ id: 'acme/alpha', platforms: ['windows'] }),
      },
    });
    const sessionB = createTrendBoardSession({
      initialEnrichedApps: {
        'acme/beta': makeEnrichedApp({ id: 'acme/beta', platforms: ['linux'] }),
      },
    });

    sessionA.start();
    sessionA.syncBoard({
      trendResult: { status: 'ok', repos: [repoA], stale: false },
      activeBoard: 'daily',
      trendFetchOpts: {},
    });

    sessionB.start();
    sessionB.syncBoard({
      trendResult: { status: 'ok', repos: [repoB], stale: false },
      activeBoard: 'monthly',
      trendFetchOpts: {},
    });

    sessionA.dispose();
    await vi.waitFor(() => {
      expect(savedKeys.some((k) => k.startsWith('daily'))).toBe(true);
    });
    expect(savedKeys.some((k) => k.startsWith('monthly'))).toBe(false);

    sessionB.dispose();
    await vi.waitFor(() => {
      expect(savedKeys.some((k) => k.startsWith('monthly'))).toBe(true);
    });
  });
});
