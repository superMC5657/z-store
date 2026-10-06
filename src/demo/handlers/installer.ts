import type {
  DownloadAssetResult,
  DownloadProgressPayload,
  InstalledApp,
  UpdateItem,
  UpdateRule,
} from '../../types';
import { buildDemoUpdates, findSummary, summaryToInstalled } from '../fixtures';
import { emitDemoEvent, getInstalledApps, LS, lsSet, setInstalledApps } from '../demoState';
import { argStr, delay, type InvokeArgs } from './common';

export async function handleInstallApp(a: InvokeArgs): Promise<InstalledApp> {
  const appId = argStr(a, 'appId', 'app_id', 'id');
  const hit = findSummary(appId);
  if (!hit) throw new Error(`demo: unknown app "${appId}"`);
  const total = 20 * 1024 * 1024;
  for (let step = 1; step <= 5; step += 1) {
    const payload: DownloadProgressPayload = {
      task_id: hit.id,
      downloaded_bytes: Math.floor((total * step) / 5),
      total_bytes: total,
      speed_bytes_per_sec: 5 * 1024 * 1024,
      state: 'downloading',
    };
    emitDemoEvent('zstore://download-progress', payload);
    await delay(220);
  }
  const done: DownloadProgressPayload = {
    task_id: hit.id,
    downloaded_bytes: total,
    total_bytes: total,
    speed_bytes_per_sec: 5 * 1024 * 1024,
    state: 'verified',
  };
  emitDemoEvent('zstore://download-progress', done);
  const installed: InstalledApp = {
    ...summaryToInstalled(hit),
    installed_at: Math.floor(Date.now() / 1000),
    asset_name:
      typeof a['assetName'] === 'string' && a['assetName']
        ? String(a['assetName'])
        : `${hit.repo}-${hit.latest_version}-windows-x64.msi`,
  };
  const list = [...getInstalledApps().filter((i) => i.app_id.toLowerCase() !== hit.id.toLowerCase()), installed];
  setInstalledApps(list);
  lsSet(LS.installed, list);
  return installed;
}

export function handleDownloadAsset(a: InvokeArgs): DownloadAssetResult {
  const appId = argStr(a, 'appId', 'app_id', 'id');
  const assetName = argStr(a, 'assetName', 'asset_name') || `${appId || 'app'}-demo.msi`;
  return {
    file_path: `C:\\Users\\Demo\\Downloads\\${assetName}`,
    file_name: assetName,
    dir: 'C:\\Users\\Demo\\Downloads',
    sha256: 'demo',
    verified: true,
  };
}

export function handleUninstallApp(a: InvokeArgs): boolean {
  const appId = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  const list = getInstalledApps().filter((i) => i.app_id.toLowerCase() !== appId);
  setInstalledApps(list);
  lsSet(LS.installed, list);
  return true;
}

export function handleUnmanageApp(a: InvokeArgs): boolean {
  const appId = argStr(a, 'appId', 'app_id', 'id').toLowerCase();
  const list = getInstalledApps().filter((i) => i.app_id.toLowerCase() !== appId);
  setInstalledApps(list);
  lsSet(LS.installed, list);
  return true;
}

export function handleLaunchApp(): boolean {
  return true;
}

export function handleOpenFolder(): boolean {
  return true;
}

export function handleShowFileInFolder(): boolean {
  return true;
}

export function handleGetInstalledApps(): InstalledApp[] {
  return [...getInstalledApps()];
}

export function handleGetDetectedInstalledAppIds(): string[] {
  return getInstalledApps().map((i) => i.app_id);
}

export function handleImportSingleApp(a: InvokeArgs): boolean {
  const id = argStr(a, 'appId', 'app_id', 'id');
  const hit = findSummary(id);
  if (hit && !getInstalledApps().some((i) => i.app_id.toLowerCase() === hit.id.toLowerCase())) {
    const list = [...getInstalledApps(), summaryToInstalled(hit)];
    setInstalledApps(list);
    lsSet(LS.installed, list);
  }
  return true;
}

export function handleCheckForUpdates(): UpdateItem[] {
  return buildDemoUpdates(getInstalledApps());
}

export function handleGetUpdateRules(): UpdateRule[] {
  return [];
}

export function handleSetAppSkipVersion(): boolean {
  return true;
}

export function handleSetAppFrozen(): boolean {
  return true;
}

export function handleSetAppHidden(): boolean {
  return true;
}

export function handleRemoveUpdateRule(): boolean {
  return true;
}

export function handleSelectFolder(): null {
  return null;
}
