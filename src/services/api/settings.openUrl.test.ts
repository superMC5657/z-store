import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from './client';
import { openUrl } from './settings';

describe('settings.openUrl direct/fallback/true-failure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__;
    delete (window as unknown as Record<string, unknown>).__ZSTORE_DEMO_NATIVE_OPEN__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__;
    delete (window as unknown as Record<string, unknown>).__ZSTORE_DEMO_NATIVE_OPEN__;
  });

  it('direct success returns without touching window.open', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockResolvedValue(undefined as never);
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(openUrl('https://example.com/prefill?body=1')).resolves.toBeUndefined();
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('legal https with surrounding spaces and upper scheme still opens direct', async () => {
    const invokeSpy = vi
      .spyOn(clientModule, 'tauriInvoke')
      .mockResolvedValue(undefined as never);
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(openUrl('  HTTPS://example.com/new?body=1  ')).resolves.toBeUndefined();
    expect(invokeSpy).toHaveBeenCalledWith('open_url', { url: 'HTTPS://example.com/new?body=1' });
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('empty/illegal scheme throws without invoking backend or fallback', async () => {
    const invokeSpy = vi
      .spyOn(clientModule, 'tauriInvoke')
      .mockResolvedValue(undefined as never);
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue({} as unknown as Window);

    await expect(openUrl('   ')).rejects.toThrow('empty url');
    await expect(openUrl('ftp://example.com/x')).rejects.toThrow('unsupported url scheme');
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('fallback success when direct fails but native window.open returns a handle', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('Not in Tauri environment'));
    const windowOpenSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({} as unknown as Window);

    await expect(openUrl('https://example.com/prefill?body=2')).resolves.toBeUndefined();
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=2',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('native null throws popup_blocked instead of the backend direct error', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('shell open denied'));
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const err = (await openUrl('https://example.com/prefill?body=3').catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch('popup_blocked');
    expect(err.code).toBe('popup_blocked');
    // 不复用后端 directErr，避免把后端失败当拦截原因误导排查
    expect(err.message).not.toMatch('shell open denied');
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=3',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('native throw is also mapped to popup_blocked', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('shell open denied'));
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });

    await expect(openUrl('https://example.com/prefill?body=3b')).rejects.toThrow('popup_blocked');
  });

  it('no opener at all rethrows the direct error', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('shell open denied'));
    // 模拟无原生可用：当前本体不可调用且无劫持前缓存键
    const original = window.open;
    Object.defineProperty(window, 'open', { value: undefined, configurable: true });
    try {
      await expect(openUrl('https://example.com/prefill?body=3c')).rejects.toThrow('shell open denied');
    } finally {
      Object.defineProperty(window, 'open', { value: original, configurable: true });
    }
  });

  it('bypasses the hijacked window.open via the captured native open', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('Not in Tauri environment'));
    const nativeHandle = {} as unknown as Window;
    const nativeSpy = vi.fn().mockReturnValue(nativeHandle);
    (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__ = nativeSpy;
    const hijackedSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(openUrl('https://example.com/prefill?body=4')).resolves.toBeUndefined();
    expect(nativeSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=4',
      '_blank',
      'noopener,noreferrer',
    );
    expect(hijackedSpy).not.toHaveBeenCalled();
  });

  it('bypasses via the demo captured native open', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('Not in Tauri environment'));
    const nativeHandle = {} as unknown as Window;
    const demoSpy = vi.fn().mockReturnValue(nativeHandle);
    (window as unknown as Record<string, unknown>).__ZSTORE_DEMO_NATIVE_OPEN__ = demoSpy;
    const hijackedSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(openUrl('https://example.com/prefill?body=5')).resolves.toBeUndefined();
    expect(demoSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=5',
      '_blank',
      'noopener,noreferrer',
    );
    expect(hijackedSpy).not.toHaveBeenCalled();
  });
});
