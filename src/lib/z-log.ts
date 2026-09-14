import { attachConsole, error, info } from '@tauri-apps/plugin-log';

export interface ZLogOptions {
  /** 攒批条数，默认 200 */
  batch?: number;
  /** 攒批时间窗口 ms，默认 3000 */
  flushIntervalMs?: number;
}

const DEFAULT_BATCH = 200;
const DEFAULT_FLUSH_MS = 3000;

// TODO(opt-in): 自动上报网络开关，默认关闭、不上报。仅落盘 + 导出，需用户显式开启后再接上报通道。

let queue: string[] = [];
let batchSize = DEFAULT_BATCH;
let flushMs = DEFAULT_FLUSH_MS;
let timer: ReturnType<typeof setInterval> | null = null;
let inited = false;

/** 前端轻量脱敏：与后端 z_log::redact 同规则，避免 token 落盘。 */
function redact(msg: string): string {
  return msg
    .replace(/Bearer\s+[^\s"'；;,]+/g, 'Bearer ***')
    .replace(/bearer\s+[^\s"'；;,]+/g, 'bearer ***')
    .replace(/Token\s+[^\s"'；;,]+/g, 'Token ***')
    .replace(/token\s+[^\s"'；;,]+/g, 'token ***');
}

function enqueue(level: string, msg: string): void {
  queue.push(`[${level}] ${redact(msg)}`);
  if (queue.length >= batchSize) {
    void flush();
  }
}

/** 批量刷盘：一次 info() 上送，减少 IPC（前端日志量大）。 */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const lines = queue.splice(0, queue.length);
  try {
    await info(lines.join('\n'));
  } catch {
    // 日志通道失败不抛错，避免影响业务；丢弃本批
  }
}

export function zlogInfo(msg: string): void {
  enqueue('info', msg);
}

export function zlogWarn(msg: string): void {
  enqueue('warn', msg);
}

export function zlogError(msg: string): void {
  // error 级别直接透传，保证关键错误不被批量延迟
  void error(redact(msg)).catch(() => undefined);
}

export function zlogDebug(msg: string): void {
  enqueue('debug', msg);
}

/**
 * 前端日志入口初始化：在 main.tsx 最早调用。
 * - batch 攒批：满 batch 条或 flushIntervalMs 到即 flush
 * - DEV 才 attachConsole（把 console 转发到后端）
 * - 接管 onerror / unhandledrejection
 */
export async function initZLog(opts: ZLogOptions = {}): Promise<void> {
  if (inited) return;
  inited = true;
  batchSize = opts.batch ?? DEFAULT_BATCH;
  flushMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;

  if (import.meta.env.DEV) {
    try {
      await attachConsole();
    } catch {
      // 非 Tauri 环境（如纯浏览器预览）忽略
    }
  }

  timer = setInterval(() => {
    void flush();
  }, flushMs);
  // 允许进程退出时不被 timer 卡住（浏览器环境无 unref 则忽略）
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') {
    t.unref();
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

  // 页面卸载补刷：batch 剩余立即 flush，不丢尾批。
  const flushOnUnload = (): void => {
    void flush();
  };
  window.addEventListener('pagehide', flushOnUnload);
  window.addEventListener('beforeunload', flushOnUnload);

  zlogInfo('[zlog] frontend log inited');
}
