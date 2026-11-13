import type { AppSummary, InstalledApp, UpdateItem, UpdateRule } from '../../types';
import { resolveInstalledAppName } from '../../utils/appHelper';

export type InstalledFilterTabId = 'all' | 'updatable' | 'frozen' | 'hidden' | 'missing_path';
export type InstalledSortOrder = 'recent' | 'name';

const INSTALL_METHOD_LABELS: Readonly<Record<string, string>> = {
  msi: 'MSI',
  setup_exe: 'Setup',
  installer: 'Installer',
  portable_zip: 'Portable',
  portable_tarball: 'Portable',
  dmg: 'DMG',
  pkg: 'PKG',
  deb: 'DEB',
  rpm: 'RPM',
  appimage: 'AppImage',
  winget: 'WinGet',
  external: 'External',
  scanned: 'Local',
  system_import: 'Local',
};

/** 将后端 `install_method` 字段映射为简短规范的技术标签；未知值安全回退原串或空。 */
export function formatInstallMethodLabel(method?: string): string {
  if (!method) return '';
  const key = method.trim().toLowerCase();
  if (!key) return '';
  return INSTALL_METHOD_LABELS[key] ?? method.trim();
}

export interface InstalledRuleStats {
  updatableCount: number;
  frozenCount: number;
  hiddenCount: number;
  missingPathCount: number;
}

/**
 * 「有更新」口径：有已装行、未被隐藏、且在更新快照里的更新项（按已装列表顺序）。
 * 「有更新」签计数、侧栏角标与「全部更新」的目标都取这一份。
 */
export function selectUpdatableInstalled(
  installedApps: InstalledApp[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
  updatesById: ReadonlyMap<string, UpdateItem>,
): UpdateItem[] {
  const out: UpdateItem[] = [];
  for (const app of installedApps) {
    const key = app.app_id.toLowerCase();
    if (rulesByAppId.get(key)?.is_hidden) continue;
    const update = updatesById.get(key);
    if (update) out.push(update);
  }
  return out;
}

/** 汇总已安装应用的状态计数，供筛选标签展示；`updatesById` 键为小写规范 app_id。 */
export function computeInstalledStats(
  installedApps: InstalledApp[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
  updatesById: ReadonlyMap<string, UpdateItem> = new Map(),
): InstalledRuleStats {
  let frozenCount = 0;
  let hiddenCount = 0;
  let missingPathCount = 0;

  for (const app of installedApps) {
    const key = app.app_id.toLowerCase();
    const rule = rulesByAppId.get(key);
    // 已隐藏的应用只归「已隐藏」签，不计入其余签，与 filterAndSortInstalledApps 同口径
    if (rule?.is_hidden) {
      hiddenCount++;
      continue;
    }
    if (rule?.is_frozen) frozenCount++;
    if (!app.install_path || !app.install_path.trim()) missingPathCount++;
  }

  const updatableCount = selectUpdatableInstalled(installedApps, rulesByAppId, updatesById).length;
  return { updatableCount, frozenCount, hiddenCount, missingPathCount };
}

/** 按规则表生成大小写归一的规则查找索引。 */
export function buildRulesMap(updateRules: UpdateRule[] = []): Map<string, UpdateRule> {
  const map = new Map<string, UpdateRule>();
  for (const rule of updateRules) {
    map.set(rule.app_id.toLowerCase(), rule);
  }
  return map;
}

/** 按可用更新列表生成小写规范 app_id → 更新项索引，供已装行就地呈现版本差与升级动作。 */
export function buildUpdatesMap(updates: UpdateItem[] = []): Map<string, UpdateItem> {
  return new Map(updates.map((u) => [u.app_id.toLowerCase(), u]));
}

/** 按目录应用列表生成小写规范 id 查找索引，供各管理视图复用。 */
export function buildCatalogLookup(apps: AppSummary[] = []): Map<string, AppSummary> {
  return new Map(apps.map((a) => [a.id.toLowerCase(), a]));
}

/** 已安装列表筛选 + 搜索 + 排序纯函数。 */
export function filterAndSortInstalledApps(
  installedApps: InstalledApp[],
  apps: AppSummary[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
  tab: InstalledFilterTabId,
  searchQuery: string,
  sortOrder: InstalledSortOrder,
  updatesById: ReadonlyMap<string, UpdateItem> = new Map(),
): InstalledApp[] {
  const q = searchQuery.trim().toLowerCase();

  const filtered = installedApps.filter((app) => {
    const rule = rulesByAppId.get(app.app_id.toLowerCase());
    // 隐藏的应用只在「已隐藏」签出现，其余签（含「全部」）一律排除
    if (tab !== 'hidden' && rule?.is_hidden) return false;
    if (tab === 'updatable' && !updatesById.has(app.app_id.toLowerCase())) return false;
    if (tab === 'frozen' && !rule?.is_frozen) return false;
    if (tab === 'hidden' && !rule?.is_hidden) return false;
    if (tab === 'missing_path' && app.install_path && app.install_path.trim() !== '') return false;

    if (!q) return true;
    const displayName = resolveInstalledAppName(app, apps).toLowerCase();
    return (
      displayName.includes(q) ||
      app.app_name.toLowerCase().includes(q) ||
      app.app_id.toLowerCase().includes(q) ||
      (app.install_path && app.install_path.toLowerCase().includes(q))
    );
  });

  if (sortOrder === 'name') {
    return [...filtered].sort((a, b) =>
      resolveInstalledAppName(a, apps).localeCompare(resolveInstalledAppName(b, apps)),
    );
  }

  return [...filtered].sort((a, b) => (b.installed_at || 0) - (a.installed_at || 0));
}
