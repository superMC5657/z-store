import type { TFunction } from 'i18next';
import { AppSummary, InstalledApp } from '../types';
import { DEFAULT_ICON_BG } from '../styles/tokens';

interface IconInfo {
  icon: string;
  iconBg: string;
}

/** 统一解析应用的图标与背景色（优先覆盖值，其次按 id 查收录库，否则返回默认兜底）。 */
export function resolveAppIconInfo(
  appId: string,
  apps: AppSummary[] = [],
  iconOverride?: string,
  iconBgOverride?: string
): IconInfo {
  const catalogApp = apps.find((a) => a.id === appId);

  return {
    icon: iconOverride || catalogApp?.icon || '📦',
    iconBg: iconBgOverride || catalogApp?.icon_bg || DEFAULT_ICON_BG,
  };
}

/** 解析已安装应用的展示名称（优先使用收录库名称，未命中回退 `app.app_name`）。 */
export function resolveInstalledAppName(
  app: InstalledApp,
  apps: AppSummary[] = []
): string {
  const catalogApp = apps.find((a) => a.id === app.app_id);
  if (catalogApp) {
    return catalogApp.name;
  }
  return app.app_name;
}

/** 展示用版本号：去掉首尾空白与前导 `v`/`V`。 */
export function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/** 格式化秒级 Unix 时间戳为本地日期字符串。 */
export function formatAppDate(ts: number, locale = 'zh-CN'): string {
  return new Date(ts * 1000).toLocaleDateString(locale === 'en-US' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 比较两组平台标识数组内容与顺序是否一致。 */
export function arePlatformsEqual(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 格式化字节大小为可读字符串；无效或非正输入返回 `'0 B'`。 */
export function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 文本复制（剪贴板 API 优先，失败回退 textarea + execCommand；永远不抛异常）。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退 textarea 方案
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 根据当前语言获取应用描述（非中文环境优先 `description_en`）。 */
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
  t?: TFunction
): string {
  if (!t) return defaultName;
  const key = `categories.cat_${category}_name`;
  const translated = t(key, { defaultValue: defaultName });
  return translated || defaultName;
}

/** 显式收录位 fail-closed 读取：仅布尔值按原值返回，缺席或非布尔返回 false。 */
export function isCatalogedFailClosed(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

/** 卡片层收录态判定：显式 `is_cataloged` 优先，缺席时按 `category !== 'external'` 兜底。 */
export function isAppCataloged(app: {
  category?: string | null;
  is_cataloged?: unknown;
}): boolean {
  const raw = app as { is_cataloged?: unknown };
  if (typeof raw.is_cataloged === 'boolean') return raw.is_cataloged;
  const cat = typeof app.category === 'string' ? app.category.trim().toLowerCase() : '';
  if (!cat) return false;
  return cat !== 'external';
}

/** 非产物文件名后缀（签名、校验和、元数据等）。 */
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

/** 判断 Release 资产是否为可下载的真实产物（排除签名、校验和与元数据文件）。 */
export function isProductAssetName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (NON_PRODUCT_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  if (NON_PRODUCT_NAME_HINTS.some((h) => lower.includes(h))) return false;
  return true;
}

/** 判断资产类型是否支持在当前宿主原生安装或便携接入（便携包仅限与宿主同 OS 或 `all`）。 */
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

/** 计算资产相对宿主的匹配分（与后端 `score_asset` 权重对齐）。 */
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

/** 按宿主相关度降序排列资产副本（同分按文件名排序）。 */
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

type HostOs = 'windows' | 'macos' | 'linux';
type HostArch = 'x86_64' | 'aarch64';

/** 宿主系统环境嗅探（navigator.userAgent 级联），供详情弹窗安装包版本资产匹配，测试可注入 UA。 */
export function detectHostOs(userAgent?: string): HostOs {
  if (userAgent === undefined) {
    if (typeof navigator === 'undefined') return 'windows';
    userAgent = navigator.userAgent;
  }
  const ua = userAgent.toLowerCase();
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

/** 宿主 CPU 架构嗅探（navigator.userAgent 级联），供详情弹窗资产匹配，测试可注入 UA。 */
export function detectHostArch(userAgent?: string): HostArch {
  if (userAgent === undefined) {
    if (typeof navigator === 'undefined') return 'x86_64';
    userAgent = navigator.userAgent;
  }
  const ua = userAgent.toLowerCase();
  if (ua.includes('arm64') || ua.includes('aarch64')) return 'aarch64';
  return 'x86_64';
}

/** 构造仓库网页地址，缺失 `owner` 或 `repo` 返回空串。 */
export function buildAppRepoUrl(app: {
  forge_host?: string | null;
  owner?: string | null;
  repo?: string | null;
}): string {
  const host =
    (app.forge_host ?? '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '') || 'github.com';
  const owner = (app.owner ?? '').trim().replace(/^\/+|\/+$/g, '');
  const repo = (app.repo ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!owner || !repo) return '';
  return `https://${host}/${owner}/${repo}`;
}

function comparableHost(u: URL): string {
  const host = u.hostname.replace(/\.+$/, '').toLowerCase().replace(/^www\./, '');
  return u.port ? `${host}:${u.port}` : host;
}

function comparableRepoPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // 非法 % 序列按原文比较
  }
  return decoded
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** 校验并解析「官方主页」外链：拒绝非 http(s)、含凭据或与仓库同址的 URL。 */
export function resolveExternalHomepageUrl(homepage: unknown, repoUrl: string): string | null {
  if (typeof homepage !== 'string') return null;
  const trimmed = homepage.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const cleanHost = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  if (!cleanHost || cleanHost.startsWith('.')) return null;
  if (
    !cleanHost.includes('.') &&
    cleanHost !== 'localhost' &&
    !(cleanHost.startsWith('[') && cleanHost.endsWith(']'))
  ) {
    return null;
  }
  const repoTrimmed = repoUrl.trim();
  if (repoTrimmed) {
    try {
      const repoParsed = new URL(repoTrimmed);
      if (
        comparableHost(parsed) === comparableHost(repoParsed) &&
        comparableRepoPath(parsed.pathname) === comparableRepoPath(repoParsed.pathname)
      ) {
        return null;
      }
    } catch {
      // repoUrl 不可解析时不做判重
    }
  }
  return trimmed.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
}

/** 格式化主页显示文案（纯文本裁剪，避免草稿输入或非 ASCII 域名被转码）。 */
export function formatHomepageDisplay(url: string | null | undefined): string {
  if (typeof url !== 'string') return '';
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}
