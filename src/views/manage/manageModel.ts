import type { AppSummary, InstalledApp, UpdateRule } from '../../types';
import { resolveInstalledAppName } from '../../utils/appHelper';

export type InstalledFilterTabId = 'all' | 'frozen' | 'hidden' | 'missing_path';
export type InstalledSortOrder = 'recent' | 'name';
export type UpdatesFilterTabId = 'all' | 'updates' | 'watched';

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
};

/** 将后端 `install_method` 字段映射为简短规范的技术标签；未知值安全回退原串或空。 */
export function formatInstallMethodLabel(method?: string): string {
  if (!method) return '';
  const key = method.trim().toLowerCase();
  if (!key) return '';
  return INSTALL_METHOD_LABELS[key] ?? method.trim();
}

export interface InstalledRuleStats {
  frozenCount: number;
  hiddenCount: number;
  missingPathCount: number;
}

/** 汇总已安装应用的状态计数，供筛选标签展示。 */
export function computeInstalledStats(
  installedApps: InstalledApp[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
): InstalledRuleStats {
  let frozenCount = 0;
  let hiddenCount = 0;
  let missingPathCount = 0;

  for (const app of installedApps) {
    const rule = rulesByAppId.get(app.app_id.toLowerCase());
    if (rule?.is_frozen) frozenCount++;
    if (rule?.is_hidden) hiddenCount++;
    if (!app.install_path || !app.install_path.trim()) missingPathCount++;
  }

  return { frozenCount, hiddenCount, missingPathCount };
}

/** 按规则表生成大小写归一的规则查找索引。 */
export function buildRulesMap(updateRules: UpdateRule[] = []): Map<string, UpdateRule> {
  const map = new Map<string, UpdateRule>();
  for (const rule of updateRules) {
    map.set(rule.app_id.toLowerCase(), rule);
  }
  return map;
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
): InstalledApp[] {
  const q = searchQuery.trim().toLowerCase();

  const filtered = installedApps.filter((app) => {
    const rule = rulesByAppId.get(app.app_id.toLowerCase());
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
