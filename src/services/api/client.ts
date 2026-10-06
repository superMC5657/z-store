import { invoke } from '@tauri-apps/api/core';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    return invoke<T>(cmd, args);
  }
  throw new Error('Not in Tauri environment');
}
