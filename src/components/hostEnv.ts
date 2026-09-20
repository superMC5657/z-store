/**
 * 宿主系统环境嗅探工具，用于 AppDetailModal 安装包版本资产匹配。
 * 纯粹提取原内联在 AppDetailModal.tsx 中作为 `currentOs`/`currentArch` memo 的
 * 重复 `navigator.userAgent` 级联嗅探逻辑（每个维度独立辅助函数，测试可注入 UA）。无任何行为变更。
 */

export type HostOs = 'windows' | 'macos' | 'linux';
export type HostArch = 'x86_64' | 'aarch64';

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

export function detectHostArch(userAgent?: string): HostArch {
  if (userAgent === undefined) {
    if (typeof navigator === 'undefined') return 'x86_64';
    userAgent = navigator.userAgent;
  }
  const ua = userAgent.toLowerCase();
  if (ua.includes('arm64') || ua.includes('aarch64')) return 'aarch64';
  return 'x86_64';
}
