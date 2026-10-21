/**
 * iconStore URL 键回归：URL 键按去空白小写比较，不经 `normalizeId` 解析成仓库 canonical。
 * 因此同仓不同图标文件（`.../a.png` 与 `.../b.png`）不共享缓存/在途键。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api/catalog', () => ({
  getOrFetchIcon: vi.fn(async () => 'data:image/png;base64,AAAAAAAA'),
}));

import {
  admitIconHit,
  getCachedIconDataUri,
  isIconPersistedOrQueued,
  __resetIconStoreForTests,
  __resetIconWriteSubscribersForTests,
} from './iconStore';

const DATA_URI = 'data:image/png;base64,AAAAAAAA';
const URL_A = 'https://github.com/acme/atlas/a.png';
const URL_B = 'https://github.com/acme/atlas/b.png';

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('iconStore URL 键不互串', () => {
  it('同仓不同 URL 不共享展示数据键', async () => {
    admitIconHit({ id: 'acme/atlas', icon: URL_A, level: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedIconDataUri(URL_A)).toBe(DATA_URI);
    expect(getCachedIconDataUri(URL_B)).toBeUndefined();
    expect(isIconPersistedOrQueued(URL_B)).toBe(false);
  });
});
