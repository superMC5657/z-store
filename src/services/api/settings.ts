import type {
  DeepLinkAction,
  ImportUserDataCounts,
  ProxyTestResult,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';
import { resolveFallbackOpener } from '../../utils/browserLockdown';

export async function switchMirror(mirrorId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.switchMirror, { mirrorId });
}

export async function testProxy(proxyUrl?: string): Promise<ProxyTestResult> {
  return tauriInvoke<ProxyTestResult>(CMD.testProxy, { proxyUrl: proxyUrl || null });
}

export async function fetchTrendsText(url: string): Promise<string> {
  if (!isTauri) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`trends text returned status ${res.status}`) as Error & {
        status: number;
      };
      err.status = res.status;
      throw err;
    }
    return res.text();
  }
  return tauriInvoke<string>(CMD.fetchTrendsText, { url });
}

export async function getSettings(): Promise<Record<string, string>> {
  return tauriInvoke<Record<string, string>>(CMD.getSettings);
}

export async function saveSetting(key: string, value: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.saveSetting, { key, value });
}

export async function registerDeepLinkScheme(): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.registerDeepLinkScheme);
}

export async function handleDeepLink(url: string): Promise<DeepLinkAction> {
  return tauriInvoke<DeepLinkAction>(CMD.handleDeepLink, { url });
}

export async function getCliDeepLink(): Promise<string | null> {
  return tauriInvoke<string | null>(CMD.getCliDeepLink);
}

export async function importUserData(json: string): Promise<ImportUserDataCounts> {
  return tauriInvoke<ImportUserDataCounts>(CMD.importUserData, { json });
}

export async function exportBackupFile(fileName: string, content: string): Promise<string | null> {
  return tauriInvoke<string | null>(CMD.exportBackupFile, { fileName, content });
}

export async function getLogDir(): Promise<string> {
  return tauriInvoke<string>(CMD.zlogGetDir);
}

export async function exportLogBundle(): Promise<string | null> {
  return tauriInvoke<string | null>(CMD.zlogExportBundle);
}

export async function openUrl(url: string): Promise<void> {
  // 拒绝空串与非 http(s) 协议，避免误打开或谎报成功。
  const trimmed = (url ?? '').trim();
  if (!trimmed) throw new Error('empty url');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`unsupported url scheme: ${trimmed}`);
  try {
    await tauriInvoke(CMD.openUrl, { url: trimmed });
    return;
  } catch (directErr) {
    // 非 Tauri 或后端打开失败时，经原生 opener 绕过 `window.open` 劫持兜底。
    const opener = resolveFallbackOpener();
    if (!opener) throw directErr;
    let ret: WindowProxy | Window | null = null;
    try {
      ret = opener(trimmed, '_blank', 'noopener,noreferrer');
    } catch {
      // 原生调用抛错与返回 null 同语义（拦截/不可用），统一抛 popup_blocked。
      throw popupBlockedError(trimmed);
    }
    if (ret) return;
    throw popupBlockedError(trimmed);
  }
}

function popupBlockedError(url: string): Error & { code?: string } {
  const err = new Error(`popup_blocked: native window.open returned null for ${url}`) as Error & {
    code?: string;
  };
  err.code = 'popup_blocked';
  return err;
}
