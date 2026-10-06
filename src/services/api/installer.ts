import { listen } from '@tauri-apps/api/event';
import type {
  DownloadAssetResult,
  DownloadProgressPayload,
  InstalledApp,
  UpdateCheckProgressPayload,
  UpdateItem,
  UpdateRule,
} from '../../types';
import { CMD } from '../api';
import { isTauri, tauriInvoke } from './client';

export async function getInstalledApps(): Promise<InstalledApp[]> {
  return tauriInvoke<InstalledApp[]>(CMD.getInstalledApps);
}

export async function installApp(
  appId: string,
  assetName?: string,
  customInstallDir?: string,
): Promise<InstalledApp> {
  return tauriInvoke<InstalledApp>(CMD.installApp, {
    appId,
    assetName: assetName || null,
    customInstallDir: customInstallDir || null,
  });
}

export async function downloadAsset(
  appId: string,
  assetName?: string,
): Promise<DownloadAssetResult> {
  return tauriInvoke<DownloadAssetResult>(CMD.downloadAsset, {
    appId,
    assetName: assetName || null,
  });
}

export async function showFileInFolder(path: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.showFileInFolder, { path });
}

export async function openFolder(path: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.openFolder, { path });
}

export async function uninstallApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.uninstallApp, { appId });
}

export async function unmanageApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.unmanageApp, { appId });
}

export async function launchApp(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.launchApp, { appId });
}

export async function checkForUpdates(forceRefresh = false): Promise<UpdateItem[]> {
  return tauriInvoke<UpdateItem[]>(CMD.checkForUpdates, { forceRefresh });
}

export async function onUpdateItemFound(callback: (item: UpdateItem) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<UpdateItem>('zstore://update-item-found', (e) => {
    callback(e.payload);
  });
}

export async function onUpdateCheckProgress(
  callback: (payload: UpdateCheckProgressPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<UpdateCheckProgressPayload>('zstore://update-check-progress', (e) => {
    callback(e.payload);
  });
}

export async function onUpdateCheckFinished(
  callback: (payload: { total_checked: number; total_found: number }) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<{ total_checked: number; total_found: number }>('zstore://update-check-finished', (e) => {
    callback(e.payload);
  });
}

export async function onDownloadProgress(
  callback: (payload: DownloadProgressPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<DownloadProgressPayload>('zstore://download-progress', (e) => {
    callback(e.payload);
  });
}

export async function getUpdateRules(): Promise<UpdateRule[]> {
  return tauriInvoke<UpdateRule[]>(CMD.getUpdateRules);
}

export async function setAppSkipVersion(appId: string, version: string | null): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.setAppSkipVersion, { appId, version });
}

export async function setAppFrozen(appId: string, isFrozen: boolean): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.setAppFrozen, { appId, isFrozen });
}

export async function setAppHidden(appId: string, isHidden: boolean): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.setAppHidden, { appId, isHidden });
}

export async function removeUpdateRule(appId: string): Promise<boolean> {
  return tauriInvoke<boolean>(CMD.removeUpdateRule, { appId });
}

export async function selectFolder(defaultPath?: string, title?: string): Promise<string | null> {
  return tauriInvoke<string | null>(CMD.selectFolder, { defaultPath, title });
}
