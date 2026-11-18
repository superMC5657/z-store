import type { AppSummary, InstalledApp, UpdateItem, UpdateRule } from '../../types';
import { resolveInstalledAppName } from '../../utils/appHelper';
import type { PlatformId } from '../../lib/platformFilter';

export type InstalledFilterTabId = 'all' | 'updatable' | 'frozen';
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

const INSTALL_METHOD_PLATFORMS: Readonly<Record<string, PlatformId>> = {
  msi: 'windows',
  setup_exe: 'windows',
  winget: 'windows',
  dmg: 'macos',
  pkg: 'macos',
  deb: 'linux',
  rpm: 'linux',
  appimage: 'linux',
};

/**
 * 无目录/卡片记录的已装应用平台兜底：按安装方式推导，无法判定的本地安装（便携包、扫描导入等）
 * 视为装在当前宿主平台上。
 */
export function inferInstalledFallbackPlatforms(
  installMethod?: string,
  hostPlatform: PlatformId = 'windows',
): string[] {
  const key = installMethod?.trim().toLowerCase() ?? '';
  return [INSTALL_METHOD_PLATFORMS[key] ?? hostPlatform];
}

export interface InstalledRuleStats {
  /** 「全部」签：未隐藏的条数。 */
  allCount: number;
  updatableCount: number;
  frozenCount: number;
}

/**
 * 「有更新」口径：有已装行、未被隐藏或锁定、且在更新快照里的更新项（按已装列表顺序）。
 * 「有更新」签计数、侧栏角标、检查更新 Toast 与「全部更新」的目标都取这一份。
 */
export function selectUpdatableInstalled(
  installedApps: InstalledApp[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
  updatesById: ReadonlyMap<string, UpdateItem>,
): UpdateItem[] {
  const out: UpdateItem[] = [];
  for (const app of installedApps) {
    const key = app.app_id.toLowerCase();
    const rule = rulesByAppId.get(key);
    if (rule?.is_hidden || rule?.is_frozen) continue;
    const update = updatesById.get(key);
    if (update) out.push(update);
  }
  return out;
}

/**
 * 汇总已安装应用的状态计数，供筛选标签展示；`updatesById` 键为小写规范 app_id。
 * 传入已按页内搜索词过滤的列表时，各计数即为切到对应签后的可见行数。
 */
export function computeInstalledStats(
  installedApps: InstalledApp[],
  rulesByAppId: ReadonlyMap<string, UpdateRule>,
  updatesById: ReadonlyMap<string, UpdateItem> = new Map(),
): InstalledRuleStats {
  let allCount = 0;
  let frozenCount = 0;

  for (const app of installedApps) {
    const key = app.app_id.toLowerCase();
    const rule = rulesByAppId.get(key);
    // 已隐藏的应用不计入「我的应用」各筛选签，与 filterAndSortInstalledApps 同口径
    if (rule?.is_hidden) continue;
    allCount++;
    if (rule?.is_frozen) frozenCount++;
  }

  const updatableCount = selectUpdatableInstalled(installedApps, rulesByAppId, updatesById).length;
  return { allCount, updatableCount, frozenCount };
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
export function buildCatalogLookup(apps: readonly AppSummary[] = []): Map<string, AppSummary> {
  return new Map(apps.map((a) => [a.id.toLowerCase(), a]));
}

/** 页内搜索词命中判定：显示名、原始名、app_id 或安装路径包含关键词（大小写不敏感，空词恒命中）。 */
export function matchesInstalledSearch(app: InstalledApp, apps: AppSummary[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    resolveInstalledAppName(app, apps).toLowerCase().includes(q) ||
    app.app_name.toLowerCase().includes(q) ||
    app.app_id.toLowerCase().includes(q) ||
    Boolean(app.install_path && app.install_path.toLowerCase().includes(q))
  );
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
  const filtered = installedApps.filter((app) => {
    const rule = rulesByAppId.get(app.app_id.toLowerCase());
    // 已隐藏的应用不在「我的应用」出现，可在规则管理中查看与恢复
    if (rule?.is_hidden) return false;
    if (tab === 'updatable' && (rule?.is_frozen || !updatesById.has(app.app_id.toLowerCase()))) return false;
    if (tab === 'frozen' && !rule?.is_frozen) return false;
    return matchesInstalledSearch(app, apps, searchQuery);
  });

  if (sortOrder === 'name') {
    return [...filtered].sort((a, b) =>
      resolveInstalledAppName(a, apps).localeCompare(resolveInstalledAppName(b, apps)),
    );
  }

  return [...filtered].sort((a, b) => (b.installed_at || 0) - (a.installed_at || 0));
}
