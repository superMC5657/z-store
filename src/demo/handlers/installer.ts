import type {
  DownloadAssetResult,
  DownloadProgressPayload,
  InstalledApp,
  UpdateItem,
  UpdateRule,
} from '../../types';
import { buildDemoUpdates, findSummary, summaryToInstalled } from '../fixtures';
import { emitDemoEvent, getInstalledApps, LS, lsGet, lsSet, setInstalledApps } from '../demoState';
import { argStr, delay, nowSecs, warnUnknownArgs, type InvokeArgs } from './common';

export async function handleInstallApp(a: InvokeArgs): Promise<InstalledApp> {
  const appId = argStr(a, 'appId');
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
  const appId = argStr(a, 'appId');
  const assetName = argStr(a, 'assetName') || `${appId || 'app'}-demo.msi`;
  return {
    file_path: `C:\\Users\\Demo\\Downloads\\${assetName}`,
    file_name: assetName,
    dir: 'C:\\Users\\Demo\\Downloads',
    sha256: 'demo',
    verified: true,
  };
}

export function handleUninstallApp(a: InvokeArgs): boolean {
  const appId = argStr(a, 'appId').toLowerCase();
  const list = getInstalledApps().filter((i) => i.app_id.toLowerCase() !== appId);
  setInstalledApps(list);
  lsSet(LS.installed, list);
  return true;
}

export function handleUnmanageApp(a: InvokeArgs): boolean {
  const appId = argStr(a, 'appId').toLowerCase();
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

export function handleCheckForUpdates(): UpdateItem[] {
  return buildDemoUpdates(getInstalledApps(), loadRules());
}

// 缓存快照（DB 同形）：首读时冻结当前已安装集合对应的更新行，此后安装/卸载
// 不改变快照内容；与 live 的 check_for_updates（每次按现状重算）语义区分。
let cachedUpdatesSnapshot: UpdateItem[] | null = null;

export function handleGetCachedUpdates(): UpdateItem[] {
  if (!cachedUpdatesSnapshot) {
    cachedUpdatesSnapshot = buildDemoUpdates([...getInstalledApps()], loadRules());
  }
  return cachedUpdatesSnapshot.map((u) => ({ ...u }));
}

// -- 更新规则（对齐 `db/rules.rs`）：读写 `LS.updateRules`（种子见 seed.ts）------

let rules: UpdateRule[] | null = null;

function loadRules(): UpdateRule[] {
  if (!rules) {
    const stored = lsGet<unknown>(LS.updateRules, []);
    rules = Array.isArray(stored)
      ? (stored as UpdateRule[]).filter((r) => typeof r?.app_id === 'string')
      : [];
  }
  return rules;
}

function isEmptyRule(r: UpdateRule): boolean {
  return !r.is_frozen && !r.is_hidden && r.skipped_version == null;
}

/** 单字段 upsert + 刷新 `updated_at`；三项都撤销的规则直接删除。 */
function upsertRule(appId: string, patch: Partial<Pick<UpdateRule, 'is_frozen' | 'is_hidden' | 'skipped_version'>>): void {
  const id = appId.trim().toLowerCase();
  if (!id) throw new Error('demo: app id is required');
  const list = loadRules();
  let rule = list.find((r) => r.app_id.toLowerCase() === id);
  if (!rule) {
    rule = { app_id: id, is_frozen: false, is_hidden: false, skipped_version: null, updated_at: 0 };
    list.push(rule);
  }
  Object.assign(rule, patch, { updated_at: nowSecs() });
  rules = list.filter((r) => !isEmptyRule(r));
  lsSet(LS.updateRules, rules);
}

export function handleGetUpdateRules(): UpdateRule[] {
  return [...loadRules()]
    .sort((x, y) => y.updated_at - x.updated_at)
    .map((r) => ({ ...r }));
}

/** 已锁定的应用不接受跳过版本设置。 */
export function handleSetAppSkipVersion(a: InvokeArgs): boolean {
  warnUnknownArgs(['appId', 'version'], a, 'handleSetAppSkipVersion');
  const appId = argStr(a, 'appId');
  const version = argStr(a, 'version') || null;
  const frozen = loadRules().some((r) => r.app_id.toLowerCase() === appId.toLowerCase() && r.is_frozen);
  if (version !== null && frozen) return true;
  upsertRule(appId, { skipped_version: version });
  return true;
}

/** 锁定时一并清掉跳过版本。 */
export function handleSetAppFrozen(a: InvokeArgs): boolean {
  warnUnknownArgs(['appId', 'isFrozen'], a, 'handleSetAppFrozen');
  const isFrozen = a['isFrozen'] === true;
  upsertRule(argStr(a, 'appId'), isFrozen ? { is_frozen: true, skipped_version: null } : { is_frozen: false });
  return true;
}

export function handleSetAppHidden(a: InvokeArgs): boolean {
  warnUnknownArgs(['appId', 'isHidden'], a, 'handleSetAppHidden');
  upsertRule(argStr(a, 'appId'), { is_hidden: a['isHidden'] === true });
  return true;
}

/** 测试用：丢弃内存缓存，下次读取重新从 localStorage 载入。 */
export function resetUpdateRulesCache(): void {
  rules = null;
  cachedUpdatesSnapshot = null;
}

export function handleSelectFolder(): null {
  return null;
}
