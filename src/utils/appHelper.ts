import { AppSummary, InstalledApp } from '../types';

interface IconInfo {
  icon: string;
  iconBg: string;
}

/**
 * 统一解析应用的图标与背景色：
 * 优先使用自身覆盖配置，其次按 canonical id（owner/repo）在收录库中精确查找，未匹配则提供稳健默认兜底。
 */
export function resolveAppIconInfo(
  appId: string,
  apps: AppSummary[] = [],
  iconOverride?: string,
  iconBgOverride?: string
): IconInfo {
  const catalogApp = apps.find((a) => a.id === appId);

  return {
    icon: iconOverride || catalogApp?.icon || '📦',
    iconBg: iconBgOverride || catalogApp?.icon_bg || 'linear-gradient(135deg, #475569, #334155)',
  };
}

/**
 * 解析已安装应用图标信息（快捷包装）
 */
export function resolveInstalledIconInfo(
  app: InstalledApp,
  apps: AppSummary[] = []
): IconInfo {
  return resolveAppIconInfo(app.app_id, apps, app.icon, app.icon_bg);
}

/**
 * 解析已安装应用的展示名称：
 * 优先匹配收录库中的名称，未匹配则回退到原生 app_name。
 */
export function resolveInstalledAppName(
  app: InstalledApp,
  apps: AppSummary[] = []
): string {
  const catalogApp = apps.find((a) => a.id === app.app_id);
  if (catalogApp) {
    return getAppDisplayName(catalogApp);
  }
  return app.app_name;
}

/**
 * 格式化秒级 Unix 时间戳为本地日期字符串 (YYYY/MM/DD)
 */
export function formatAppDate(ts: number, locale = 'zh-CN'): string {
  return new Date(ts * 1000).toLocaleDateString(locale === 'en-US' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * 格式化字节大小为可读字符串 (B / KB / MB / GB)
 */
export function formatBytes(bytes?: number): string {
  if (!bytes || typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i] || 'MB'}`;
}

/**
 * 获取应用展示名称：直接返回英文原名 name。
 */
export function getAppDisplayName(app: { name: string }): string {
  return app.name;
}

/**
 * 根据当前语言获取应用展示描述
 * 英文或非中文环境下优先展示 description_en，无则回退到 description
 */
export function getAppDescription(
  app: { description: string; description_en?: string },
  locale?: string
): string {
  const isZh = !locale || locale.startsWith('zh');
  if (!isZh && app.description_en && app.description_en.trim()) {
    return app.description_en;
  }
  return app.description;
}

/**
 * 根据当前语言和分类代码获取本地化分类名称
 */
export function getCategoryLabel(
  category: string,
  defaultName: string,
  t?: (key: any, options?: any) => string
): string {
  if (!t) return defaultName;
  const key = `categories.cat_${category}_name`;
  const translated = t(key, { defaultValue: defaultName });
  return translated || defaultName;
}

/**
 * 收录态判定（展示层唯一口径，与详情页 Header 一致）：
 * 显式 `is_cataloged` / `isCataloged` 标记优先（数据层占位行携带），
 * 缺席时按 `category !== 'external'` 兜底；空分类视为未收录。
 * 仅展示层读取，绝不参与数据源 join。
 */
export function isAppCataloged(app: {
  category?: string | null;
  is_cataloged?: unknown;
  isCataloged?: unknown;
}): boolean {
  const raw = app as { is_cataloged?: unknown; isCataloged?: unknown };
  if (typeof raw.is_cataloged === 'boolean') return raw.is_cataloged;
  if (typeof raw.isCataloged === 'boolean') return raw.isCataloged;
  const cat = typeof app.category === 'string' ? app.category.trim().toLowerCase() : '';
  if (!cat) return false;
  return cat !== 'external';
}

/**
 * 非产物后缀：签名 / 校验和 / 元数据 / 映射表，不可安装也无需展示。
 * 命中任一即视为非产物（大小写不敏感）。
 */
const NON_PRODUCT_SUFFIXES = [
  '.sig',
  '.asc',
  '.pem',
  '.gpg',
  '.sign',
  '.signature',
  '.sha256',
  '.sha512',
  '.sha1',
  '.md5',
  '.checksum',
  '.hash',
  '.sbom',
  '.blockmap',
  '.zsync',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
  '.md',
];

/** 非产物文件名关键字：校验和汇总文件（如 SHA256SUMS / checksums.txt 已被后缀覆盖，此处补聚合命名）。 */
const NON_PRODUCT_NAME_HINTS = [
  'checksum',
  'checksums',
  'sha256sums',
  'sha512sums',
  'md5sums',
];

/**
 * 判断 Release 资产是否为真实产物：
 * 过滤签名（.sig/.asc）、校验和与汇总文件、元数据（latest.json / .yml / .blockmap 等）。
 * 后缀产物（.tar.gz / .7z / .apk 等）一律保留——它们仍可下载。
 */
export function isProductAssetName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (NON_PRODUCT_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  if (NON_PRODUCT_NAME_HINTS.some((h) => lower.includes(h))) return false;
  return true;
}

/**
 * 宿主原生可安装的资产类型（与后端 execute_installation_inner 的平台分发对齐）：
 * - windows: msi / setup_exe
 * - macos: dmg / pkg
 * - linux: deb / rpm / appimage
 * - portable_zip / portable_tarball（二进制 tar.gz，便携解压纳入管理）：仅本平台可安装，
 *   要求资产 os 与宿主一致或为通用 all（大小写不敏感），缺 os 时 fail-closed 仅下载。
 *   跨平台仅下载，与后端 select_best_asset 一致。
 * 其余（apk / tarball / other 等）后端只会跳过，前端应提供下载而非安装。
 */
export function isInstallableAssetKind(kind: string, hostOs: string, assetOs?: string): boolean {
  const k = (kind || '').toLowerCase();
  const os = (hostOs || '').toLowerCase();
  if (k === 'portable_zip' || k === 'portable_tarball') {
    if (assetOs === undefined || assetOs === null) return false;
    const aOs = String(assetOs).toLowerCase();
    if (!aOs) return false;
    return aOs === os || aOs === 'all';
  }
  if (os === 'windows') return k === 'msi' || k === 'setup_exe';
  if (os === 'macos') return k === 'dmg' || k === 'pkg';
  if (os === 'linux') return k === 'deb' || k === 'rpm' || k === 'appimage';
  return false;
}

/** 便携包类型档位单映射（与后端 SCORE_ASSET_KIND_* 对齐，tar +5 < zip +10 < 原生，垫底）。 */
const PORTABLE_KIND_TIER_SCORE: Record<string, number> = {
  portable_tarball: 5,
  portable_zip: 10,
};

/** 资产类型档位分（便携档与宿主无关走单映射，原生档按宿主分发）。 */
function assetKindTierScore(kind: string, hostOs: string): number {
  const k = (kind || '').toLowerCase();
  const os = (hostOs || '').toLowerCase();
  const portableTier = PORTABLE_KIND_TIER_SCORE[k];
  if (portableTier !== undefined) return portableTier;
  if (os === 'windows') {
    if (k === 'msi') return 20;
    if (k === 'setup_exe') return 15;
    return 0;
  }
  if (os === 'macos') {
    if (k === 'dmg') return 20;
    if (k === 'pkg') return 15;
    return 0;
  }
  if (os === 'linux') {
    if (k === 'appimage') return 20;
    if (k === 'deb') return 15;
    if (k === 'rpm') return 12;
    return 0;
  }
  return 0;
}

interface AssetRelevance {
  os: string;
  arch: string;
  kind: string;
  name: string;
}

/**
 * 资产相对宿主的相关度打分（与后端 score_asset 权重对齐）：
 * 系统匹配 +100 / 通用 +30 / 系统失配 -100；
 * 架构一致 +50 / 通用 +25 / x86_64 宿主兼容 x86 +10 / 失配 -50；
 * 类型档位 +20/+15/+12/+10，tar 便携包 +5 垫底（有原生包永远选原生）。
 */
function scoreAssetRelevance(a: AssetRelevance, hostOs: string, hostArch: string): number {
  const os = (hostOs || '').toLowerCase();
  const arch = (hostArch || '').toLowerCase();
  const aOs = (a.os || '').toLowerCase();
  const aArch = (a.arch || '').toLowerCase();
  let score = 0;
  if (aOs === os) score += 100;
  else if (aOs === 'all') score += 30;
  else score -= 100;
  if (aArch === arch) score += 50;
  else if (aArch === 'universal') score += 25;
  else if (arch === 'x86_64' && aArch === 'x86') score += 10;
  else score -= 50;
  score += assetKindTierScore(a.kind, os);
  return score;
}

/**
 * 按宿主相关度降序排列资产（分数相同按文件名稳定排序，保证抽屉顺序确定）。
 * 返回新数组，不修改入参。
 */
export function sortAssetsByRelevance<T extends AssetRelevance>(
  assets: T[],
  hostOs: string,
  hostArch: string
): T[] {
  return [...assets].sort((x, y) => {
    const diff = scoreAssetRelevance(y, hostOs, hostArch) - scoreAssetRelevance(x, hostOs, hostArch);
    if (diff !== 0) return diff;
    return x.name.localeCompare(y.name);
  });
}



