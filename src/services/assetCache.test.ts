/** 远端图片缓存收敛与并发去重测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const api = vi.hoisted(() => ({ fetchOrCacheAssetUrl: vi.fn() }));
vi.mock('./api', () => ({ tauriApi: api }));

import {
  ASSET_PLACEHOLDER_SRC,
  __resetAssetCacheForTests,
  getSyncCachedAssetUri,
  prepareInitialHtml,
  resolveCachedAssetUri,
  useResolvedMarkdownImages,
} from './assetCache';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const w = window as unknown as Record<string, unknown>;
const PNG = 'https://raw.githubusercontent.com/o/r/main/demo.png';
const GIF = 'https://raw.githubusercontent.com/o/r/main/demo.gif';
const BADGE = 'https://img.shields.io/badge/x-y-green';

function dataFor(url: string): string {
  return url.endsWith('.gif') ? 'data:image/gif;base64,R0lG' : 'data:image/png;base64,iVBO';
}

function imgSrcs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('img')).map((i) => i.getAttribute('src') || '');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  __resetAssetCacheForTests();
  api.fetchOrCacheAssetUrl.mockReset();
  w['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
});

afterEach(() => {
  delete w['__TAURI_INTERNALS__'];
  delete w['__ZSTORE_DEMO_MOCK__'];
  vi.useRealTimers();
});

describe('useResolvedMarkdownImages（真实 Tauri）', () => {
  it('首屏不暴露远端 src（含 .gif），解析后回填 data:，动态徽章保持直连', async () => {
    const pending = new Map<string, (v: string) => void>();
    api.fetchOrCacheAssetUrl.mockImplementation(
      (url: string) => new Promise<string>((r) => pending.set(url, r)),
    );
    const html = `<p>x</p><img src="${PNG}"><img src="${GIF}"><img src="${BADGE}">`;
    const { result } = renderHook(() => useResolvedMarkdownImages(html, 'o/r'));

    const first = imgSrcs(result.current);
    expect(first[0]).toBe(ASSET_PLACEHOLDER_SRC);
    expect(first[1]).toBe(ASSET_PLACEHOLDER_SRC);
    expect(first[2]).toBe(BADGE);
    expect(first).not.toContain(PNG);

    await flush();
    expect(api.fetchOrCacheAssetUrl).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.get(PNG)!(dataFor(PNG));
      pending.get(GIF)!(dataFor(GIF));
    });
    await flush();
    const after = imgSrcs(result.current);
    expect(after).toEqual([dataFor(PNG), dataFor(GIF), BADGE]);
    expect(result.current).not.toContain('data-zstore-src');
    // 内存缓存命中：再次渲染同步直填，零 IPC。
    expect(prepareInitialHtml(`<img src="${PNG}">`).pending).toEqual([]);
    expect(getSyncCachedAssetUri(PNG)).toBe(dataFor(PNG));
  });

  it('并发 ≤ 4 且同 URL 单飞', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/a${i}.png`);
    let inflight = 0;
    let peak = 0;
    const resolvers: (() => void)[] = [];
    api.fetchOrCacheAssetUrl.mockImplementation(
      (url: string) =>
        new Promise<string>((r) => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          resolvers.push(() => {
            inflight -= 1;
            r(dataFor(url));
          });
        }),
    );
    const html = [...urls, urls[0], urls[1]].map((u) => `<img src="${u}">`).join('');
    const { result } = renderHook(() => useResolvedMarkdownImages(html, 'o/r'));
    await flush();
    expect(inflight).toBe(4);
    while (resolvers.length > 0) {
      await act(async () => {
        resolvers.shift()!();
      });
      await flush();
    }
    expect(peak).toBeLessThanOrEqual(4);
    expect(api.fetchOrCacheAssetUrl).toHaveBeenCalledTimes(urls.length);
    expect(imgSrcs(result.current).every((s) => s.startsWith('data:image/png'))).toBe(true);
  });

  it('后端回退原链（如超 5MB 动图）时回填原地址', async () => {
    api.fetchOrCacheAssetUrl.mockImplementation(async (url: string) => url);
    const { result } = renderHook(() => useResolvedMarkdownImages(`<img src="${GIF}">`, 'o/r'));
    await flush();
    expect(imgSrcs(result.current)).toEqual([GIF]);
    expect(getSyncCachedAssetUri(GIF)).toBeUndefined();
  });

  it('srcset 未解析前摘除，解析后以 data: 重建', async () => {
    api.fetchOrCacheAssetUrl.mockImplementation(async (url: string) => dataFor(url));
    const html = `<img src="${PNG}" srcset="${PNG} 1x, https://example.com/b@2x.png 2x">`;
    const prepared = prepareInitialHtml(html);
    expect(prepared.html).not.toMatch(/\ssrcset="/);
    const { result } = renderHook(() => useResolvedMarkdownImages(html, 'o/r'));
    await flush();
    const doc = new DOMParser().parseFromString(result.current, 'text/html');
    const srcset = doc.querySelector('img')?.getAttribute('srcset') || '';
    expect(srcset).toContain('data:image/png;base64,iVBO 1x');
    expect(srcset).not.toContain('https://');
  });
});

describe('非真实 Tauri 运行时', () => {
  it('jsdom 无 IPC：原样直出，不调用后端', async () => {
    delete w['__TAURI_INTERNALS__'];
    const html = `<img src="${PNG}">`;
    const { result } = renderHook(() => useResolvedMarkdownImages(html, 'o/r'));
    expect(result.current).toBe(html);
    await expect(resolveCachedAssetUri(PNG)).resolves.toBe(PNG);
    expect(api.fetchOrCacheAssetUrl).not.toHaveBeenCalled();
  });

  it('官网 Demo mock：原样直出', () => {
    w['__ZSTORE_DEMO_MOCK__'] = true;
    const html = `<img src="${PNG}">`;
    const { result } = renderHook(() => useResolvedMarkdownImages(html, 'o/r'));
    expect(result.current).toBe(html);
  });
});
