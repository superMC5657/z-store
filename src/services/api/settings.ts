import type {
  DeepLinkAction,
  ImportUserDataCounts,
  MirrorNodeStatus,
  ProxyTestResult,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';

export async function getMirrorStatus(): Promise<MirrorNodeStatus[]> {
  return tauriInvoke<MirrorNodeStatus[]>(CMD.getMirrorStatus);
}

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

export async function openUrl(url: string): Promise<void> {
  // 合法 https 预填 URL 必过：先 trim 去首尾空白，再大小写不敏感判 http(s)，
  // 仅空值/非法 scheme 抛错，不误杀合法预填长链。
  const trimmed = (url ?? '').trim();
  if (!trimmed) throw new Error('empty url');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`unsupported url scheme: ${trimmed}`);
  try {
    // 先直调后端 open_url（rundll32 拉起默认浏览器），成功即返。
    await tauriInvoke(CMD.openUrl, { url: trimmed });
    return;
  } catch (directErr) {
    // 直调失败（非 Tauri 的 Not in Tauri / 后端 rundll32 spawn 失败等）才走原生兜底：
    // 经劫持前捕获的原生 opener 绕过 `window.open` 劫持（直接调会被拦截返回 null），
    // 返回 null（弹窗拦截/无原生可用）则抛出来源错保留失败感知，杜绝静默谎报成功。
    const opener = resolveSettingsFallbackOpener();
    if (opener) {
      try {
        const ret = opener(trimmed, '_blank', 'noopener,noreferrer');
        if (ret) return;
      } catch {
        /* 原生调用抛错则落到下方抛出来源错 */
      }
    }
    throw directErr;
  }
}

/**
 * settings 层兜底 opener 解析（不导入 browserLockdown，避免
 * `settings → browserLockdown → services/api → settings` 循环）：
 * 劫持版 `window.open` 直接调用必返 null，须经 `__ZSTORE_NATIVE_OPEN__` /
 * `__ZSTORE_DEMO_NATIVE_OPEN__`（劫持前捕获）绕过；非劫持时用当前本体（单测可桩）。
 */
function resolveSettingsFallbackOpener(): typeof window.open | null {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return null;
  try {
    const cur = window.open as unknown as Record<string, unknown>;
    if (cur?.['__zstoreHijacked']) {
      const w = window as unknown as Record<string, unknown>;
      const stored = w['__ZSTORE_NATIVE_OPEN__'] ?? w['__ZSTORE_DEMO_NATIVE_OPEN__'];
      if (typeof stored === 'function') return (stored as typeof window.open).bind(window);
      return null;
    }
    return window.open.bind(window);
  } catch {
    return null;
  }
}
