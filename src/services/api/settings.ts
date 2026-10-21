import type {
  DeepLinkAction,
  ImportUserDataCounts,
  MirrorNodeStatus,
  ProxyTestResult,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';
import { resolveFallbackOpener } from '../../utils/fallbackOpener';

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
