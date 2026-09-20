/**
 * Host environment detection for AppDetailModal asset matching.
 * Pure move of the duplicated `navigator.userAgent` cascade previously
 * inline as `currentOs`/`currentArch` memos (one helper per axis,
 * injectable UA for tests). No behavior change.
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
