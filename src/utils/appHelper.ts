import { AppSummary, InstalledApp } from '../types';

export interface IconInfo {
  icon: string;
  iconBg: string;
  owner?: string;
  repo?: string;
}

/**
 * 统一解析应用的图标与背景色：
 * 优先使用自身覆盖配置，其次在收录库汇总列表中查找匹配项，未匹配则提供稳健默认兜底。
 */
export function resolveAppIconInfo(
  appId: string,
  appName: string,
  apps: AppSummary[] = [],
  iconOverride?: string,
  iconBgOverride?: string
): IconInfo {
  const idLower = appId.toLowerCase();
  const nameLower = appName.toLowerCase();

  const catalogApp = apps.find(
    (a) =>
      a.id.toLowerCase() === idLower ||
      (a.owner && a.repo && `${a.owner}/${a.repo}`.toLowerCase() === idLower) ||
      a.name.toLowerCase() === nameLower
  );

  return {
    icon: iconOverride || catalogApp?.icon || '📦',
    iconBg: iconBgOverride || catalogApp?.icon_bg || 'linear-gradient(135deg, #475569, #334155)',
    owner: catalogApp?.owner,
    repo: catalogApp?.repo,
  };
}

/**
 * 解析已安装应用图标信息（快捷包装）
 */
export function resolveInstalledIconInfo(
  app: InstalledApp,
  apps: AppSummary[] = []
): IconInfo {
  return resolveAppIconInfo(app.app_id, app.app_name, apps, app.icon, app.icon_bg);
}

/**
 * 格式化时间戳为本地日期字符串 (YYYY/MM/DD)
 */
export function formatAppDate(ts: number): string {
  const normalizedTs = ts < 10000000000 ? ts * 1000 : ts;
  return new Date(normalizedTs).toLocaleDateString('zh-CN', {
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

export interface MethodBadge {
  label: string;
  color: string;
}

/**
 * 获取安装方式标签与对应主题色彩
 */
export function getMethodBadge(method: string): MethodBadge {
  switch (method) {
    case 'msi':
      return { label: 'MSI 官方安装', color: 'var(--brand-primary)' };
    case 'setup_exe':
      return { label: 'EXE 安装向导', color: '#0284c7' };
    case 'portable_zip':
      return { label: '便携绿色版', color: '#10b981' };
    case 'system_import':
      return { label: '系统纳管', color: '#8b5cf6' };
    default:
      return { label: '系统管理', color: 'var(--text-tertiary)' };
  }
}

