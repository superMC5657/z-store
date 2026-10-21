import { CMD } from '../api';
import { tauriInvoke } from './client';

/** 日志目录路径（Rust `zlog_get_dir`，app_log_dir）。 */
export async function getLogDir(): Promise<string> {
  return tauriInvoke<string>(CMD.zlogGetDir);
}

/** 导出脱敏日志包（zip），返回 bundle 文件绝对路径。 */
export async function exportLogBundle(): Promise<string> {
  return tauriInvoke<string>(CMD.zlogExportBundle);
}
