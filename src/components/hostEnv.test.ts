/**
 * hostEnv 特征化测试：在将 AppDetailModal 内联的 currentOs/currentArch memos
 * 移动至 `detectHostOs`/`detectHostArch` 之前，锁定其 `navigator.userAgent` 级联嗅探行为。
 */
import { describe, expect, it } from 'vitest';
import { detectHostArch, detectHostOs } from './hostEnv';

const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LINUX_ARM_UA =
  'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LINUX_X64_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

describe('detectHostOs (AppDetailModal UA cascade)', () => {
  it('maps Windows UA to windows', () => {
    expect(detectHostOs(WIN_UA)).toBe('windows');
  });

  it('maps mac/darwin UA to macos', () => {
    expect(detectHostOs(MAC_UA)).toBe('macos');
    expect(detectHostOs('darwin/23.0 (arm64)')).toBe('macos');
  });

  it('maps linux UA to linux', () => {
    expect(detectHostOs(LINUX_X64_UA)).toBe('linux');
  });

  it('falls back to windows for empty/unknown UA', () => {
    expect(detectHostOs('')).toBe('windows');
    expect(detectHostOs('some-unknown-agent/1.0')).toBe('windows');
  });
});

describe('detectHostArch (AppDetailModal UA cascade)', () => {
  it('maps arm64/aarch64 UA to aarch64', () => {
    expect(detectHostArch(LINUX_ARM_UA)).toBe('aarch64');
    expect(detectHostArch('Mozilla/5.0 (Macintosh; arm64)')).toBe('aarch64');
  });

  it('falls back to x86_64 for desktop/empty UA', () => {
    expect(detectHostArch(WIN_UA)).toBe('x86_64');
    expect(detectHostArch(LINUX_X64_UA)).toBe('x86_64');
    expect(detectHostArch('')).toBe('x86_64');
  });
});
