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

/**
 * 官方插件命令透传（`plugin:*`）：插件命令不在本仓 lib.rs 注册集内，故不进 `CMD` 表
 * （cmdAlignment 按注册集对齐）；这是插件命令唯一前端出口，同一 `isTauri` 守卫与
 * 请求键 camelCase 检查。插件未引入/未启用时 invoke 照常 reject，由调用方提示。
 */
export async function tauriInvokePlugin<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}
