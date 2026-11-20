import { attachConsole, error, info, warn } from '@tauri-apps/plugin-log';

let isInitialized = false;

/** 前端轻量脱敏：与后端 z_log::redact 同规则，避免 token 落盘。 */
function redact(msg: string): string {
  return (
    msg
      .replace(/Bearer\s+[^\s"'；;,]+/g, 'Bearer ***')
      .replace(/bearer\s+[^\s"'；;,]+/g, 'bearer ***')
      .replace(/Token\s+[^\s"'；;,]+/g, 'Token ***')
      .replace(/token\s+[^\s"'；;,]+/g, 'token ***')
      // 与后端 code/device_code/user_code/api_key 键值脱敏对齐（\b 护住 vscode 类路径；
      // 键后 `["']?` 容纳 JSON 紧凑/宽松形态 `"code":"v"`，与后端 is_kv_post 含引号一致）。
      .replace(
        /\b(device_code|user_code|api_key|api-key|apikey)["']?\s*[:=]\s*"?[^"'\s,;}]+/gi,
        (_m, k: string) => `${k}=***`,
      )
      .replace(/\bcode["']?\s*[:=]\s*"?[^"'\s,;}]+/gi, (_m) => 'code=***')
      .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '***@***')
  );
}

// StrictMode 双调用去重窗（毫秒）：同一行 1s 内重复只送一行，
// 去重发生在日志送达前，不影响业务行为。
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

/** 前端直透刷盘：即时上送，由后端格式器统一落盘至 [ui] 标签。 */
export function zlogInfo(msg: string): void {
  if (isDuplicate(msg)) return;
  void info(redact(msg)).catch(() => undefined);
}

export function zlogWarn(msg: string): void {
  if (isDuplicate(msg)) return;
  void warn(redact(msg)).catch(() => undefined);
}

export function zlogError(msg: string): void {
  if (isDuplicate(msg)) return;
  void error(redact(msg)).catch(() => undefined);
}

/** 初始化前端日志：DEV 下转发后端控制台日志，并接管全局未捕获错误脱敏上报。 */
export async function initZLog(): Promise<void> {
  if (isInitialized) return;
  isInitialized = true;

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
}
