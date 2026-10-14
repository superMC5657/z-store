/**
 * L5 配线回归（用户报障：详情切到 L5 后富卡/列表不变旧图 stale）。
 *
 * 驱动精确症状的真实代码路径：渲染详情 Header，点击轮换按钮切到 L5，
 * 断言切流经店内唯一写口 `applyHit({ icon: '', level: 5 })`（P1 后架构约束）。
 * 当前代码 L5 分支只调 `clearBufferedIcon`（清内存、不通知列表/镜像），
 * 故本断言为红；修完变绿。另断言弹窗自身即时变徽章（两版本皆绿，防误伤）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { AppDetailViewModel } from '../../types';

const APP_ID = 'o/r';
const REAL_ICON = 'https://cdn.simpleicons.org/r';

const hooks = vi.hoisted(() => ({
  getAppIconCycle: vi.fn(async (_id: string) => ({
    url: REAL_ICON,
    remote_url: REAL_ICON,
    level: 2,
    source: 'simple-icons',
    is_fallback: false,
    total_levels: 5,
    is_cataloged: false,
  })),
  cycleAppIcon: vi.fn(async (_id: string) => ({
    url: '',
    remote_url: '',
    level: 5,
    source: 'none',
    is_fallback: true,
    total_levels: 5,
    is_cataloged: false,
  })),
  isStarred: vi.fn(async (_id: string) => false),
  applyHit: vi.fn(),
  clearBufferedIcon: vi.fn(),
}));

vi.mock('../../services/api', () => {
  const api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getAppIconCycle') return (...a: unknown[]) => hooks.getAppIconCycle(...(a as [string]));
        if (prop === 'cycleAppIcon') return (...a: unknown[]) => hooks.cycleAppIcon(...(a as [string]));
        if (prop === 'isStarred') return (id: string) => hooks.isStarred(id);
        if (prop === 'normalizeIconCycle') {
          return (d: any) =>
            d ? { ...d, remoteUrl: d.remote_url ?? d.remoteUrl } : null;
        }
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { api, normalizeIconCycle: (d: any) => (d ? { ...d, remoteUrl: d.remote_url ?? d.remoteUrl } : null) };
});

vi.mock('../../services/iconStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/iconStore')>();
  return {
    ...mod,
    applyHit: (...a: Parameters<typeof mod.applyHit>) => hooks.applyHit(...a),
    clearBufferedIcon: (...a: Parameters<typeof mod.clearBufferedIcon>) => hooks.clearBufferedIcon(...a),
  };
});

type HeaderModule = typeof import('./Header');
let Header: HeaderModule['Header'];

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function fixtureApp(): AppDetailViewModel {
  return {
    id: APP_ID,
    name: 'L5 Fixture',
    owner: 'o',
    repo: 'r',
    icon: REAL_ICON,
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'l5 cycle fixture',
    stars: 10,
    forks: 1,
    license: 'MIT',
    latest_version: '1.0.0',
    changelog: '',
    is_verified: false,
    readme_markdown: '',
    releases: [],
    category: 'external',
    category_name: '跨平台开源',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
    isLoading: false,
  };
}

beforeEach(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const mod = await import('./Header');
  Header = mod.Header;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('Header L5 cycle goes through the sole write', () => {
  it('切到 L5 时调用 applyHit({ icon: "", level: 5 })（富卡/列表才能跟进）', async () => {
    render(
      <Header
        app={fixtureApp()}
        displayName="L5 Fixture"
        displayDesc="l5 cycle fixture"
        displayCategory="跨平台开源"
        platformPending={false}
        onClose={() => {}}
      />,
    );
    const cycleBtn = await screen.findByTitle(/下一档/);
    await act(async () => {
      fireEvent.click(cycleBtn);
    });
    await waitFor(() => {
      expect(hooks.cycleAppIcon).toHaveBeenCalledWith(APP_ID);
    });
    // 核心断言：L5 必须走唯一写口（当前代码只调 clearBufferedIcon → 此处为红）。
    await waitFor(() => {
      expect(hooks.applyHit).toHaveBeenCalledWith(
        expect.objectContaining({ icon: '', level: 5 }),
      );
    });
  });

  it('弹窗自身切 L5 即时变徽章（不受本次回归影响）', async () => {
    const { container } = render(
      <Header
        app={fixtureApp()}
        displayName="L5 Fixture"
        displayDesc="l5 cycle fixture"
        displayCategory="跨平台开源"
        platformPending={false}
        onClose={() => {}}
      />,
    );
    const cycleBtn = await screen.findByTitle(/下一档/);
    await act(async () => {
      fireEvent.click(cycleBtn);
    });
    await waitFor(() => {
      expect(container.querySelector('.app-icon-fallback-badge')).toBeTruthy();
    });
  });
});
