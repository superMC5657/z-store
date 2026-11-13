import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSummary } from '../types';
import {
  filterMaskedRecentViews,
  loadRecentViewsMask,
  maskRecentViews,
  unmaskRecentViewApp,
} from './recentViewsMask';

function makeApp(id: string, viewedAt?: number): AppSummary {
  const [owner = 'acme', repo = id] = id.split('/');
  return {
    id,
    name: repo,
    owner,
    repo,
    icon: '',
    icon_bg: '#000',
    description: 'desc',
    stars: 10,
    forks: 1,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: false,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    viewed_at: viewedAt,
  };
}

describe('recentViewsMask', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('无遮罩时原样返回全部最近浏览条目', () => {
    const items = [makeApp('acme/alpha', 1000), makeApp('acme/beta', 900)];
    expect(loadRecentViewsMask()).toEqual({ clearedAtSec: 0, reopenedAt: {} });
    expect(filterMaskedRecentViews(items)).toEqual(items);
  });

  it('清空后遮罩当下及更早记录，新浏览记录（viewed_at > clearedAtSec）自动可见', () => {
    const before = [makeApp('acme/alpha', 1000), makeApp('acme/beta', 1005)];
    maskRecentViews(before, 1002);

    // clearedAtSec 取 nowSec 与条目最大 viewed_at 的较大值（1005），确保同批全部隐藏
    expect(filterMaskedRecentViews(before)).toEqual([]);

    const after = [makeApp('acme/gamma', 1006), ...before];
    expect(filterMaskedRecentViews(after).map((a) => a.id)).toEqual(['acme/gamma']);
  });

  it('在 30 秒 DB 防抖期内重开被遮罩应用，unmaskRecentViewApp 使其立即重现并置顶且可再次清空', () => {
    const items = [makeApp('acme/alpha', 1000), makeApp('acme/beta', 950)];
    maskRecentViews(items, 1010);
    expect(filterMaskedRecentViews(items)).toEqual([]);

    // 先打开新应用 gamma（viewed_at = 1015），再在 30s 防抖期内重开旧应用 alpha（viewed_at 仍为 1000）
    const withNew = [makeApp('acme/gamma', 1015), ...items];
    unmaskRecentViewApp('Acme/Alpha', 1020_000);
    expect(filterMaskedRecentViews(withNew).map((a) => a.id)).toEqual([
      'acme/alpha',
      'acme/gamma',
    ]);

    // 再次点击清空后，重新遮罩全部历史
    maskRecentViews(withNew, 1025);
    expect(filterMaskedRecentViews(withNew)).toEqual([]);
  });
});
