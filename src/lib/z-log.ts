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
  return (
    msg
      .replace(/Bearer\s+[^\s"'；;,]+/g, 'Bearer ***')
      .replace(/bearer\s+[^\s"'；;,]+/g, 'bearer ***')
      .replace(/Token\s+[^\s"'；;,]+/g, 'Token ***')
      .replace(/token\s+[^\s"'；;,]+/g, 'token ***')
      // Wave2：与后端 code/device_code/user_code/api_key 键值脱敏对齐（\b 护住 vscode 类路径）。
      .replace(
        /\b(device_code|user_code|api_key|api-key|apikey)\s*[:=]\s*"?[^"'\s,;}]+/gi,
        (_m, k: string) => `${k}=***`,
      )
      .replace(/\bcode\s*[:=]\s*"?[^"'\s,;}]+/gi, (_m) => 'code=***')
      .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '***@***')
  );
}

/** 前端会话 ID：进程级一次生成全局复用，与后端 sid 行为链对齐。 */
let frontendSid = '';
export function getSid(): string {
  if (!frontendSid) {
    frontendSid = `s${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0')}`;
  }
  return frontendSid;
}

let reqSeq = 0;
/** 生成前端请求短 ID（8 位 hex），调用方透传为 req 关联。 */
export function newReqId(): string {
  reqSeq += 1;
  return `${(Date.now() ^ reqSeq).toString(16).slice(-4)}${reqSeq.toString(16).padStart(4, '0')}`;
}

export interface ZLogMeta {
  sid?: string;
  req?: string;
}

function withPrefix(msg: string, meta?: ZLogMeta): string {
  const sid = meta?.sid ?? getSid();
  const req = meta?.req ?? '';
  let prefix = '';
  if (sid) prefix += `[sid=${sid}]`;
  if (req) prefix += `[req=${req}]`;
  return prefix ? `${prefix} ${msg}` : msg;
}

// Wave2：StrictMode 双调用去重窗（毫秒）。同一行 1s 内重复只送一行，
// 行为本身不受影响，去重只发生在日志送达前。
let lastLine = '';
let lastAt = 0;
const DEDUP_WINDOW_MS = 1000;
function isDuplicate(line: string): boolean {
  const now = Date.now();
  if (line === lastLine && now - lastAt < DEDUP_WINDOW_MS) return true;
  lastLine = line;
  lastAt = now;
  return false;
}

/** 前端直透刷盘：即时上送，杜绝 3 秒时钟延迟造成的因果颠倒与崩溃丢日志。 */
export function zlogInfo(msg: string, meta?: ZLogMeta): void {
  const line = withPrefix(msg, meta);
  if (isDuplicate(line)) return;
  void info(redact(line)).catch(() => undefined);
}

export function zlogWarn(msg: string, meta?: ZLogMeta): void {
  const line = withPrefix(msg, meta);
  if (isDuplicate(line)) return;
  void warn(redact(line)).catch(() => undefined);
}

export function zlogError(msg: string, meta?: ZLogMeta): void {
  const line = withPrefix(msg, meta);
  if (isDuplicate(line)) return;
  void error(redact(line)).catch(() => undefined);
}

export function zlogDebug(msg: string, meta?: ZLogMeta): void {
  const line = withPrefix(msg, meta);
  if (isDuplicate(line)) return;
  void debug(redact(line)).catch(() => undefined);
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
