import { attachConsole, debug, error, info, warn } from '@tauri-apps/plugin-log';

export interface ZLogOptions {
  /** 保留参数，供向前兼容 */
  batch?: number;
  flushIntervalMs?: number;
}

// TODO(opt-in): 自动上报网络开关，默认关闭、不上报。仅落盘 + 导出，需用户显式开启后再接上报通道。

let inited = false;

/** 前端轻量脱敏：与后端 z_log::redact 同规则，避免 token 落盘。 */
function redact(msg: string): string {
  return msg
    .replace(/Bearer\s+[^\s"'；;,]+/g, 'Bearer ***')
    .replace(/bearer\s+[^\s"'；;,]+/g, 'bearer ***')
    .replace(/Token\s+[^\s"'；;,]+/g, 'Token ***')
    .replace(/token\s+[^\s"'；;,]+/g, 'token ***');
}

/** 前端直透刷盘：即时上送，杜绝 3 秒时钟延迟造成的因果颠倒与崩溃丢日志。 */
export function zlogInfo(msg: string): void {
  void info(redact(msg)).catch(() => undefined);
}

export function zlogWarn(msg: string): void {
  void warn(redact(msg)).catch(() => undefined);
}

export function zlogError(msg: string): void {
  void error(redact(msg)).catch(() => undefined);
}

export function zlogDebug(msg: string): void {
  void debug(redact(msg)).catch(() => undefined);
}

/** 兼容接口：直透模式下无需手动刷盘。 */
export async function flush(): Promise<void> {}

/**
 * 前端日志入口初始化：在 main.tsx 最早调用。
 * - 直透模式：所有 UI 日志纳秒级即时进 IPC，确保时序严格真实
 * - DEV 才 attachConsole（把 console 转发到后端）
 * - 接管 onerror / unhandledrejection
 */
export async function initZLog(_opts: ZLogOptions = {}): Promise<void> {
  if (inited) return;
  inited = true;

  if (import.meta.env.DEV) {
    try {
      await attachConsole();
    } catch {
      // 非 Tauri 环境（如纯浏览器预览）忽略
    }
  }

  window.addEventListener('error', (ev) => {
    const msg = ev.message ? `${ev.message} @${ev.filename}:${ev.lineno}:${ev.colno}` : 'window.onerror';
    void error(`[onerror] ${redact(msg)}`).catch(() => undefined);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason =
      ev.reason instanceof Error ? `${ev.reason.message}\n${ev.reason.stack ?? ''}` : String(ev.reason);
    void error(`[unhandledrejection] ${redact(reason)}`).catch(() => undefined);
  });

  zlogInfo('frontend log inited');
}
