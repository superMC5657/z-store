/** 测试真实 Tauri 运行时下 `<AppIcon>` 的后端单飞请求、失败直连回退与徽章定格。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../services/api/catalog', () => ({
  getOrFetchIcon: vi.fn(),
}));

import { getOrFetchIcon } from '../services/api/catalog';
import { AppIcon } from './AppIcon';
import { __resetIconStoreForTests, __resetIconWriteSubscribersForTests } from '../services/iconStore';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const ICON = 'https://raw.githubusercontent.com/o/r/main/icon.png';
const DATA = 'data:image/png;base64,AAAA';
const w = window as unknown as Record<string, unknown>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  __resetIconStoreForTests();
  __resetIconWriteSubscribersForTests();
  vi.mocked(getOrFetchIcon).mockReset();
  w['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
});

afterEach(() => {
  cleanup();
  delete w['__TAURI_INTERNALS__'];
  delete w['__ZSTORE_DEMO_MOCK__'];
});

describe('AppIcon 真实 Tauri 后端单飞', () => {
  it('在途期间不挂远端 <img>，后端 data: 就绪后渲染实图（单次 get_or_fetch_icon）', async () => {
    let resolveFetch: (v: string) => void = () => {};
    vi.mocked(getOrFetchIcon).mockImplementation(
      () => new Promise<string>((r) => (resolveFetch = r)),
    );
    const { container } = render(<AppIcon icon={ICON} name="Demo" appId="o/r" />);
    await flush();
    expect(getOrFetchIcon).toHaveBeenCalledTimes(1);
    const remote = Array.from(container.querySelectorAll('img')).filter((i) =>
      (i.getAttribute('src') || '').startsWith('https://'),
    );
    expect(remote).toHaveLength(0);
    expect(container.querySelector('.app-icon-pending')).not.toBeNull();

    await act(async () => resolveFetch(DATA));
    await flush();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA);
    expect(getOrFetchIcon).toHaveBeenCalledTimes(1);
  });

  it('后端失败即唤醒回退直连 <img>，直连再失败定格徽章且不再重试', async () => {
    vi.mocked(getOrFetchIcon).mockRejectedValue(new Error('offline'));
    const { container } = render(<AppIcon icon={ICON} name="Demo App" appId="o/r" />);
    await flush();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(ICON);

    await act(async () => {
      fireEvent.error(img!);
    });
    await flush();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.app-icon-fallback-badge')?.textContent).toBe('DA');
    expect(getOrFetchIcon).toHaveBeenCalledTimes(1);
  });

  it('退避过期后不退回空底板：已直连的 <img> 保持显示', async () => {
    vi.mocked(getOrFetchIcon).mockRejectedValue(new Error('offline'));
    const { container, rerender } = render(<AppIcon icon={ICON} name="Demo" appId="o/r" />);
    await flush();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);

    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000);
    try {
      rerender(<AppIcon icon={ICON} name="Demo" appId="o/r" className="x" />);
      await flush();
      expect(container.querySelector('.app-icon-pending')).toBeNull();
      expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
    } finally {
      spy.mockRestore();
    }
  });

  it('Demo mock 下保持同步直出远端 <img>', async () => {
    w['__ZSTORE_DEMO_MOCK__'] = true;
    vi.mocked(getOrFetchIcon).mockResolvedValue(DATA);
    const { container } = render(<AppIcon icon={ICON} name="Demo" appId="o/r" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });
});
