/**
 * 在线搜索段「亮边界 + 越界续拉」回归测试。
 *
 * 锁定手感：
 * - 到底先亮 `online-armed-boundary`（「已到底 · 继续下拉加载更多」），哨兵进入视口也不自动拉；
 * - 在底部继续下拉（滚轮）/点按钮才续下一页（每次 1 页 20 个由 `handleOnlineLoadMore` 保证，此处只锁触发）；
 * - 加载中不重复触发；无下一页时回到真·到底态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { SearchResultsView } from './SearchResultsView';
import { makeApp } from './test-utils/filterFixture';

type IoCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let observed: Array<{ el: Element; cb: IoCallback }>;

function stubIntersectionObserver() {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      cb: IoCallback;
      constructor(cb: IoCallback) {
        this.cb = cb;
      }
      observe(el: Element): void {
        observed.push({ el, cb: this.cb });
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

function setVisibleForTestId(testId: string, visible: boolean): void {
  const targets = observed.filter(
    (o) => o.el instanceof HTMLElement && o.el.getAttribute('data-testid') === testId,
  );
  act(() => {
    for (const t of targets) t.cb([{ isIntersecting: visible }]);
  });
}

function fireWheelDown(): void {
  let event: Event;
  try {
    event = new WheelEvent('wheel', { deltaY: 120, bubbles: true });
  } catch {
    event = new Event('wheel', { bubbles: true });
    (event as unknown as { deltaY: number }).deltaY = 120;
  }
  window.dispatchEvent(event);
}

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderOnlineSearch(extraProps?: Partial<React.ComponentProps<typeof SearchResultsView>>) {
  const onOnlineLoadMore = vi.fn();
  const onlineApps = Array.from({ length: 20 }, (_, i) =>
    makeApp({ id: `online/app-${i}`, name: `Online${i}` }),
  );
  const localApps = [
    makeApp({ id: 'local/a', name: 'LocalA' }),
    makeApp({ id: 'local/b', name: 'LocalB' }),
  ];
  const view = render(
    <SearchResultsView
      apps={localApps}
      installedIds={new Set<string>()}
      favoriteIds={new Set<string>()}
      onOpenDetail={() => {}}
      onQuickInstall={() => {}}
      onToggleFavorite={() => {}}
      searchQuery="rustdesk"
      isOnlineResults
      onlineApps={onlineApps}
      onlineSearchPerformed
      onlineHasMore
      onOnlineLoadMore={onOnlineLoadMore}
      {...extraProps}
    />,
  );
  return { ...view, onOnlineLoadMore };
}

describe('SearchResultsView online search armed boundary', () => {
  it('reaching the bottom arms the boundary instead of auto-loading', () => {
    const { getByTestId, onOnlineLoadMore } = renderOnlineSearch();
    expect(getByTestId('online-armed-boundary').textContent).toContain('已到底 · 继续下拉加载更多');
    expect(getByTestId('online-armed-boundary').textContent).toContain('已加载 20 个 · 每次续拉 20 个');
    expect(getByTestId('feed-load-more')).toBeTruthy();
    // 哨兵进入视口不自动触发在线续拉……
    setVisibleForTestId('feed-sentinel', true);
    expect(onOnlineLoadMore).not.toHaveBeenCalled();
    // …armed 条可见本身也只亮边界，不触发。
    setVisibleForTestId('online-armed-boundary', true);
    expect(onOnlineLoadMore).not.toHaveBeenCalled();
  });

  it('continued pull-down at the bottom loads the next page once per burst', () => {
    const { onOnlineLoadMore } = renderOnlineSearch();
    setVisibleForTestId('online-armed-boundary', true);
    fireWheelDown();
    fireWheelDown();
    fireWheelDown();
    expect(onOnlineLoadMore).toHaveBeenCalledTimes(1);
  });

  it('button click still loads more as a fallback', () => {
    const { getByTestId, onOnlineLoadMore } = renderOnlineSearch();
    fireEvent.click(getByTestId('feed-load-more'));
    expect(onOnlineLoadMore).toHaveBeenCalledTimes(1);
  });

  it('loading state shows progress copy, disables the button and ignores gestures', () => {
    const { getByTestId, onOnlineLoadMore } = renderOnlineSearch({ isLoadingOnlineMore: true });
    expect(getByTestId('online-armed-boundary').textContent).toContain('正在加载下 20 个…');
    expect(getByTestId('feed-load-more').hasAttribute('disabled')).toBe(true);
    setVisibleForTestId('online-armed-boundary', true);
    fireWheelDown();
    expect(onOnlineLoadMore).not.toHaveBeenCalled();
  });

  it('without a next page the true end state returns and the boundary is gone', () => {
    const { getByTestId, queryByTestId } = renderOnlineSearch({ onlineHasMore: false });
    expect(queryByTestId('online-armed-boundary')).toBeNull();
    expect(queryByTestId('feed-load-more')).toBeNull();
    expect(getByTestId('feed-end').textContent).toContain('到底了 · 在线共 20 个');
  });

  it('local search stage hides stale onlineApps when isOnlineResults is false and lets user trigger online search', () => {
    const onSearchOnline = vi.fn();
    const { getByTestId, queryByTestId } = renderOnlineSearch({
      isOnlineResults: false,
      onlineSearchPerformed: false,
      onlineHasMore: false,
      onSearchOnline,
    });
    expect(queryByTestId('search-online-grid')).toBeNull();
    expect(getByTestId('search-online-section').textContent).toBe('在线结果 0');
    const triggerBtn = getByTestId('search-online-trigger');
    expect(triggerBtn.textContent).toContain('在线搜索');
    fireEvent.click(triggerBtn);
    expect(onSearchOnline).toHaveBeenCalledTimes(1);
    expect(onSearchOnline).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it('已搜过再点「重试在线搜索」传 forceRefresh=true', () => {
    const onSearchOnline = vi.fn();
    const { getByTestId } = renderOnlineSearch({
      isOnlineResults: false,
      onlineSearchPerformed: true,
      onlineHasMore: false,
      onlineApps: [],
      onSearchOnline,
    });
    fireEvent.click(getByTestId('search-online-trigger'));
    expect(onSearchOnline).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('hides online trigger button while local search is still running', () => {
    const { getByTestId, queryByTestId } = renderOnlineSearch({
      isOnlineResults: false,
      isSearchingLocal: true,
      onlineSearchPerformed: false,
      onlineHasMore: false,
      onSearchOnline: vi.fn(),
    });
    expect(getByTestId('search-online-empty').textContent).toContain('正在搜索本地应用');
    expect(queryByTestId('search-online-trigger')).toBeNull();
  });
});
