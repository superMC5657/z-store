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
  if (!url) return;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return;
  try {
    await tauriInvoke(CMD.openUrl, { url: trimmed });
  } catch {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
  }
}
