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
  // 空值/非法 scheme 全 repo 调用方扫描结论：均为合法 https 外链透传（`void openUrl`
  // fire-and-forget 或 try/catch 自处理，无调用方依赖静默吞错），故保留 fail-closed 抛错，
  // 避免空串/非 http(s) 被误打开或谎报成功。
  const trimmed = (url ?? '').trim();
  if (!trimmed) throw new Error('empty url');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`unsupported url scheme: ${trimmed}`);
  try {
    // 先直调后端 open_url（rundll32 拉起默认浏览器），成功即返。
    await tauriInvoke(CMD.openUrl, { url: trimmed });
    return;
  } catch (directErr) {
    // 直调失败（非 Tauri 的 Not in Tauri / 后端 rundll32 spawn 失败等）才走原生兜底：
    // 经劫持前捕获的原生 opener 绕过 `window.open` 劫持（劫持版直接调必返回 null），
    // 原生返回 null（弹窗拦截/无原生可用）则抛 `popup_blocked` 语义错保留失败感知，
    // 调用方按自身失败文案 toast，不谎报成功；此处不复用 directErr，
    // 避免把后端失败当拦截原因误导排查。
    const opener = resolveSettingsFallbackOpener();
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

/**
 * settings 层兜底 opener 解析（不导入 browserLockdown，避免
 * `settings → browserLockdown → services/api → settings` 循环）：
 * 劫持版 `window.open` 同步返回 null，直接调用必被拦截，故必须经 `__ZSTORE_NATIVE_OPEN__` /
 * `__ZSTORE_DEMO_NATIVE_OPEN__`（劫持前捕获的原生 opener，见 browserLockdown/demo-mock
 * 在覆写前缓存的原因）绕过劫持；无缓存键时（未初始化/单测桩）回落到当前 `window.open`
 * 本体，调用方可桩返回值；两者皆无时返回 null，调用方按无原生处理。
 */
function resolveSettingsFallbackOpener(): typeof window.open | null {
  if (typeof window === 'undefined') return null;
  try {
    const w = window as unknown as Record<string, unknown>;
    const stored = w['__ZSTORE_NATIVE_OPEN__'] ?? w['__ZSTORE_DEMO_NATIVE_OPEN__'];
    if (typeof stored === 'function') return (stored as typeof window.open).bind(window);
    if (typeof window.open === 'function') return window.open.bind(window);
    return null;
  } catch {
    return null;
  }
}
