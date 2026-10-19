import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from './client';
import { openUrl } from './settings';

describe('settings.openUrl direct/fallback/true-failure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('true failure throws the direct error when fallback returns null', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('shell open denied'));
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(openUrl('https://example.com/prefill?body=3')).rejects.toThrow('shell open denied');
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=3',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('bypasses the hijacked window.open via the captured native open', async () => {
    vi.spyOn(clientModule, 'tauriInvoke').mockRejectedValue(new Error('Not in Tauri environment'));
    const nativeHandle = {} as unknown as Window;
    const nativeSpy = vi.fn().mockReturnValue(nativeHandle);
    (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__ = nativeSpy;
    const hijackedSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    (window.open as unknown as Record<string, unknown>).__zstoreHijacked = true;

    await expect(openUrl('https://example.com/prefill?body=4')).resolves.toBeUndefined();
    expect(nativeSpy).toHaveBeenCalledWith(
      'https://example.com/prefill?body=4',
      '_blank',
      'noopener,noreferrer',
    );
    expect(hijackedSpy).not.toHaveBeenCalled();
    delete (window as unknown as Record<string, unknown>).__ZSTORE_NATIVE_OPEN__;
  });
});
