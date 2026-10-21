/**
 * iconStore 容器有界回归：
 * `iconLevelById`/`iconById`/`iconDataCache`/`iconPersistedKeys` 与预热态
 * `iconPreloadQueue`/`iconPendingAliases`/`iconPendingPromises`/`iconPreloadBackoffUntil`
 * 均按 `ICON_STORE_MAX_ENTRIES`（200，与榜缓存 `TRENDS_CACHE_MAX_ENTRIES` 同口径）
 * 写时 FIFO 删最旧。已落盘条目被淘汰后经 `get_or_fetch_icon` 落盘缓存重读自愈。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api/catalog', () => ({
  getOrFetchIcon: vi.fn(async () => 'data:image/png;base64,AAAAAAAA'),
}));

import {
  ICON_STORE_MAX_ENTRIES,
  admitIconHit,
  getBufferedIcon,
  getCachedIconDataUri,
  __flushIconPreloadsForTests,
  __getIconStoreSizesForTests,
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
  __setIconDataCacheForTests,
} from './iconStore';
import { getOrFetchIcon } from './api/catalog';

const DATA_URI = 'data:image/png;base64,AAAAAAAA';

function urlOf(i: number): string {
  return `https://example.com/icons/${i}.png`;
}

function idOf(i: number): string {
  return `owner${i}/repo${i}`;
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
  // 桩 Tauri 环境让预热真跑（getOrFetchIcon 已 mock，无 IPC）；非 Tauri 只收队不清耗。
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('iconStore 四容器有界', () => {
  it('210 个远端命中后四容器存量均钳在 200', async () => {
    for (let i = 0; i < 210; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    await flushAsync();
    const sizes = __getIconStoreSizesForTests();
    expect(sizes.iconById).toBe(ICON_STORE_MAX_ENTRIES);
    expect(sizes.levelById).toBe(ICON_STORE_MAX_ENTRIES);
    expect(sizes.dataCache).toBe(ICON_STORE_MAX_ENTRIES);
    expect(sizes.persistedKeys).toBe(ICON_STORE_MAX_ENTRIES);
  });

  it('FIFO 删最旧：最早条目被淘汰，最新条目保留', async () => {
    for (let i = 0; i < 210; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    await flushAsync();
    expect(getBufferedIcon(idOf(0))).toBeUndefined();
    expect(getBufferedIcon(idOf(209))).toBe(urlOf(209));
    expect(getCachedIconDataUri(urlOf(0))).toBeUndefined();
    expect(getCachedIconDataUri(urlOf(209))).toBe(DATA_URI);
  });

  it('iconDataCache 经测试 seam 写入同走有界口（220 条钳 200）', () => {
    for (let i = 0; i < 220; i += 1) {
      __setIconDataCacheForTests(`cache-key-${i}`, DATA_URI);
    }
    expect(__getIconStoreSizesForTests().dataCache).toBe(ICON_STORE_MAX_ENTRIES);
    expect(getCachedIconDataUri('cache-key-0')).toBeUndefined();
    expect(getCachedIconDataUri('cache-key-219')).toBe(DATA_URI);
  });

  it('同 id 覆盖写不增长（覆盖不重排，超限才裁剪）', async () => {
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 50; i += 1) {
        admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
      }
    }
    await flushAsync();
    const sizes = __getIconStoreSizesForTests();
    expect(sizes.iconById).toBe(50);
    expect(sizes.levelById).toBe(50);
  });

  it('同 tick 预热入队超 200 时队列钳在 200', () => {
    for (let i = 0; i < 210; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    expect(__getIconStoreSizesForTests().preloadQueue).toBe(ICON_STORE_MAX_ENTRIES);
  });

  it('预热失败后：在途/别名清空，退避表钳在 200', async () => {
    vi.mocked(getOrFetchIcon).mockRejectedValue(new Error('offline'));
    try {
      for (let i = 0; i < 210; i += 1) {
        admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
      }
      await __flushIconPreloadsForTests();
      const sizes = __getIconStoreSizesForTests();
      expect(sizes.pendingPromises).toBe(0);
      expect(sizes.pendingAliases).toBe(0);
      expect(sizes.preloadBackoff).toBe(ICON_STORE_MAX_ENTRIES);
    } finally {
      vi.mocked(getOrFetchIcon).mockResolvedValue(DATA_URI);
    }
  });
});
