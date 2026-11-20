/** 测试 `<CachedAvatar>` 在 Tauri 缓存、普通链接与加载失败回退下的渲染行为。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const api = vi.hoisted(() => ({ fetchOrCacheAssetUrl: vi.fn() }));
vi.mock('../services/api', () => ({ tauriApi: api }));

import { CachedAvatar } from './CachedAvatar';
import { __resetAssetCacheForTests } from '../services/assetCache';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const w = window as unknown as Record<string, unknown>;
const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';
const DATA = 'data:image/png;base64,iVBO';

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  __resetAssetCacheForTests();
  api.fetchOrCacheAssetUrl.mockReset();
});

afterEach(() => {
  cleanup();
  delete w['__TAURI_INTERNALS__'];
});

describe('CachedAvatar', () => {
  it('真实 Tauri：等待期显示首字母，解析后渲染 data: 头像', async () => {
    w['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
    api.fetchOrCacheAssetUrl.mockResolvedValue(DATA);
    const { container } = render(<CachedAvatar src={AVATAR} login="octocat" size={18} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('O');
    await flush();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA);
    expect(api.fetchOrCacheAssetUrl).toHaveBeenCalledWith(AVATAR, '');
  });

  it('非 Tauri：原链直出，不调用后端', () => {
    const { container } = render(<CachedAvatar src={AVATAR} login="octocat" size={28} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(AVATAR);
    expect(api.fetchOrCacheAssetUrl).not.toHaveBeenCalled();
  });

  it('无头像或加载失败：首字母圆形徽章', async () => {
    const { container, rerender } = render(<CachedAvatar src={null} login="zeta" size={28} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('Z');

    rerender(<CachedAvatar src={AVATAR} login="zeta" size={28} />);
    const img = container.querySelector('img')!;
    await act(async () => {
      fireEvent.error(img);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('zeta');
  });

  it('弱化态：降低不透明度并半灰度', () => {
    const { container } = render(
      <CachedAvatar src={AVATAR} login="octocat" size={18} dimmed dimmedOpacity={0.6} />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.style.opacity).toBe('0.6');
    expect(img.style.filter).toBe('grayscale(50%)');
  });
});
