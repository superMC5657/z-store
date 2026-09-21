import { AppSummary, InstalledApp } from '../types';

export interface IconInfo {
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

export interface MethodBadge {
  label: string;
  color: string;
}

/**
 * 获取安装方式标签与对应主题色彩
 */
export function getMethodBadge(method: string, t?: (key: any) => string): MethodBadge {
  switch (method) {
    case 'msi':
      return { label: t ? t('installed.method_msi') : 'MSI 官方安装', color: 'var(--brand-primary)' };
    case 'setup_exe':
      return { label: t ? t('installed.method_setup_exe') : 'EXE 安装向导', color: '#0284c7' };
    case 'portable_zip':
      return { label: t ? t('installed.method_portable') : '便携绿色版', color: '#10b981' };
    case 'system_import':
      return { label: t ? t('installed.method_import') : '本地导入', color: '#8b5cf6' };
    default:
      return { label: t ? t('installed.method_system') : '系统管理', color: 'var(--text-tertiary)' };
  }
}

