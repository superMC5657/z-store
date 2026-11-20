/** `iconStore` 内存容器上限（FIFO 淘汰）与淘汰后落盘重读测试。 */
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
  it('超量远端命中后四容器存量均钳在 ICON_STORE_MAX_ENTRIES', async () => {
    const total = ICON_STORE_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    await flushAsync();
    const sizes = __getIconStoreSizesForTests();
    expect(sizes.iconById).toBe(ICON_STORE_MAX_ENTRIES);
    expect(sizes.levelById).toBe(ICON_STORE_MAX_ENTRIES);
    expect(sizes.dataCache).toBe(ICON_STORE_MAX_ENTRIES);
  });

  it('FIFO 删最旧：最早条目被淘汰，最新条目保留', async () => {
    const total = ICON_STORE_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    await flushAsync();
    expect(getBufferedIcon(idOf(0))).toBeUndefined();
    expect(getBufferedIcon(idOf(total - 1))).toBe(urlOf(total - 1));
    expect(getCachedIconDataUri(urlOf(0))).toBeUndefined();
    expect(getCachedIconDataUri(urlOf(total - 1))).toBe(DATA_URI);
  });

  it('iconDataCache 经测试 seam 写入同走有界口（超量钳在 ICON_STORE_MAX_ENTRIES）', () => {
    const total = ICON_STORE_MAX_ENTRIES + 20;
    for (let i = 0; i < total; i += 1) {
      __setIconDataCacheForTests(`cache-key-${i}`, DATA_URI);
    }
    expect(__getIconStoreSizesForTests().dataCache).toBe(ICON_STORE_MAX_ENTRIES);
    expect(getCachedIconDataUri('cache-key-0')).toBeUndefined();
    expect(getCachedIconDataUri(`cache-key-${total - 1}`)).toBe(DATA_URI);
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

  it('同 tick 预热入队超上限时队列钳在 ICON_STORE_MAX_ENTRIES', () => {
    const total = ICON_STORE_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) {
      admitIconHit({ id: idOf(i), icon: urlOf(i), level: 2 });
    }
    expect(__getIconStoreSizesForTests().preloadQueue).toBe(ICON_STORE_MAX_ENTRIES);
  });

  it('预热失败后：在途/别名清空，退避表钳在 ICON_STORE_MAX_ENTRIES', async () => {
    vi.mocked(getOrFetchIcon).mockRejectedValue(new Error('offline'));
    try {
      const total = ICON_STORE_MAX_ENTRIES + 10;
      for (let i = 0; i < total; i += 1) {
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
