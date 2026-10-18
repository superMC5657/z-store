import { invoke } from '@tauri-apps/api/core';
import { zlogError } from '../../lib/z-log';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
    for (const key of Object.keys(args ?? {})) {
      if (key.includes('_')) zlogError(`[ipc-args] snake_case key "${key}" for cmd "${cmd}" — use camelCase`);
    }
  }
  if (isTauri) {
    return invoke<T>(cmd, args);
  }
  throw new Error('Not in Tauri environment');
}
