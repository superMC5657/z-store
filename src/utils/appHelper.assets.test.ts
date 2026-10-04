/**
 * 资产过滤与安装/下载分流契约测试（对应详情弹窗抽屉需求）。
 */
import { describe, expect, it } from 'vitest';
import { isInstallableAssetKind, isProductAssetName, sortAssetsByRelevance } from './appHelper';

describe('isProductAssetName', () => {
  it.each([
    'rustdesk-1.4.9-x86_64.msi',
    'rustdesk-1.4.9-x86_64.exe',
    'rustdesk-1.4.9-x86_64.zip',
    'rustdesk-1.4.9-x86_64.deb',
    'rustdesk-1.4.9-x86_64.rpm',
    'rustdesk-1.4.9-x86_64.dmg',
    'rustdesk-1.4.9-aarch64.AppImage',
    'rustdesk-1.4.9-unsigned.tar.gz',
    'pi-darwin-arm64.tar.gz',
    'app-2.0.7z',
    'app-2.0.apk',
  ])('保留真实产物 %s', (name) => {
    expect(isProductAssetName(name)).toBe(true);
  });

  it.each([
    'rustdesk-1.4.9-x86_64.msi.sig',
    'app-2.0.exe.asc',
    'app-2.0.zip.pem',
    'latest.json',
    'release-meta.json',
    'app-2.0.yml',
    'app-2.0.yaml',
    'app-2.0.exe.blockmap',
    'app-2.0.zsync',
    'SHA256SUMS',
    'checksums.txt',
    'app-2.0.sha256',
    'app-2.0.tar.gz.sha512',
    'app-2.0.md5',
    'README.md',
    'app-2.0.SIG',
    'app-2.0.JSON',
  ])('过滤非产物 %s', (name) => {
    expect(isProductAssetName(name)).toBe(false);
  });

  it('空名与非字符串视为非产物', () => {
    expect(isProductAssetName('')).toBe(false);
    expect(isProductAssetName(null as unknown as string)).toBe(false);
  });
});

describe('isInstallableAssetKind', () => {
  it('windows: msi / setup_exe 可装（原生不看 assetOs），其余下载', () => {
    expect(isInstallableAssetKind('msi', 'windows')).toBe(true);
    expect(isInstallableAssetKind('setup_exe', 'windows')).toBe(true);
    for (const k of ['deb', 'rpm', 'dmg', 'apk', 'appimage', 'installer', 'other', '']) {
      expect(isInstallableAssetKind(k, 'windows')).toBe(false);
    }
  });

  it('macos: dmg / pkg 可装', () => {
    expect(isInstallableAssetKind('dmg', 'macos')).toBe(true);
    expect(isInstallableAssetKind('pkg', 'macos')).toBe(true);
    expect(isInstallableAssetKind('msi', 'macos')).toBe(false);
    expect(isInstallableAssetKind('deb', 'macos')).toBe(false);
  });

  it('linux: deb / rpm / appimage 可装', () => {
    expect(isInstallableAssetKind('deb', 'linux')).toBe(true);
    expect(isInstallableAssetKind('rpm', 'linux')).toBe(true);
    expect(isInstallableAssetKind('appimage', 'linux')).toBe(true);
    expect(isInstallableAssetKind('msi', 'linux')).toBe(false);
    expect(isInstallableAssetKind('dmg', 'linux')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isInstallableAssetKind('MSI', 'Windows')).toBe(true);
    expect(isInstallableAssetKind('Portable_Zip', 'Windows', 'WINDOWS')).toBe(true);
    expect(isInstallableAssetKind('Portable_Tarball', 'Linux', 'LINUX')).toBe(true);
  });

  it('portable_zip：仅本平台可装（os 一致或 all，大小写不敏感），跨平台仅下载', () => {
    // 本平台 / 通用 => 可装
    expect(isInstallableAssetKind('portable_zip', 'windows', 'windows')).toBe(true);
    expect(isInstallableAssetKind('portable_zip', 'macos', 'macos')).toBe(true);
    expect(isInstallableAssetKind('portable_zip', 'linux', 'linux')).toBe(true);
    expect(isInstallableAssetKind('portable_zip', 'linux', 'all')).toBe(true);
    expect(isInstallableAssetKind('portable_zip', 'windows', 'ALL')).toBe(true);
    expect(isInstallableAssetKind('Portable_Zip', 'windows', 'Windows')).toBe(true);
    // 跨平台 => 不可装（只下载）
    expect(isInstallableAssetKind('portable_zip', 'linux', 'windows')).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'linux', 'macos')).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'windows', 'linux')).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'macos', 'windows')).toBe(false);
  });

  it('portable_tarball：本平台可装（os 一致或 all），跨平台仅下载', () => {
    for (const k of ['portable_tarball', 'Portable_Tarball']) {
      // os 匹配 => 可装
      expect(isInstallableAssetKind(k, 'linux', 'linux')).toBe(true);
      expect(isInstallableAssetKind(k, 'macos', 'macos')).toBe(true);
      expect(isInstallableAssetKind(k, 'windows', 'windows')).toBe(true);
      // 通用 all => 可装
      expect(isInstallableAssetKind(k, 'linux', 'all')).toBe(true);
      // os 不匹配 => 不可装（只下载）
      expect(isInstallableAssetKind(k, 'linux', 'windows')).toBe(false);
      expect(isInstallableAssetKind(k, 'linux', 'macos')).toBe(false);
      expect(isInstallableAssetKind(k, 'windows', 'linux')).toBe(false);
      expect(isInstallableAssetKind(k, 'macos', 'windows')).toBe(false);
    }
  });

  it('assetOs 缺失 => 不可装（fail-closed，与后端 select_best_asset 一致，只下载）', () => {
    expect(isInstallableAssetKind('portable_zip', 'windows')).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'linux', undefined)).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'linux', null as unknown as string)).toBe(false);
    expect(isInstallableAssetKind('portable_zip', 'linux', '')).toBe(false);
    expect(isInstallableAssetKind('portable_tarball', 'linux')).toBe(false);
    expect(isInstallableAssetKind('portable_tarball', 'linux', undefined)).toBe(false);
    expect(isInstallableAssetKind('portable_tarball', 'linux', null as unknown as string)).toBe(false);
    expect(isInstallableAssetKind('portable_tarball', 'linux', '')).toBe(false);
  });

  it('tar 裸名无 os 场景：未解析出 os 的 tar.gz 只下载不安装', () => {
    // 裸名 tar.gz（无系统标识 => assetOs 缺失）即使宿主一致也不可装
    const bareTarballOs: string | undefined = undefined;
    expect(isInstallableAssetKind('portable_tarball', 'linux', bareTarballOs)).toBe(false);
    expect(isInstallableAssetKind('portable_tarball', 'windows', bareTarballOs)).toBe(false);
    const bareZipOs: string | undefined = undefined;
    expect(isInstallableAssetKind('portable_zip', 'windows', bareZipOs)).toBe(false);
  });
});

describe('sortAssetsByRelevance', () => {
  const assets = [
    { name: 'app-1.0-x86_64.dmg', os: 'macos', arch: 'x86_64', kind: 'dmg' },
    { name: 'app-1.0-x86_64.deb', os: 'linux', arch: 'x86_64', kind: 'deb' },
    { name: 'app-1.0-x86_64.exe', os: 'windows', arch: 'x86_64', kind: 'setup_exe' },
    { name: 'app-1.0-x86_64.msi', os: 'windows', arch: 'x86_64', kind: 'msi' },
    { name: 'app-1.0-aarch64.msi', os: 'windows', arch: 'aarch64', kind: 'msi' },
    { name: 'app-1.0-x86_64.zip', os: 'windows', arch: 'x86_64', kind: 'portable_zip' },
    { name: 'app-1.0-arm64.apk', os: 'android', arch: 'aarch64', kind: 'apk' },
  ];

  it('windows x86_64：同系统同架构优先，msi > exe > zip，同系统异架构靠后，异系统沉底', () => {
    const names = sortAssetsByRelevance(assets, 'windows', 'x86_64').map((a) => a.name);
    expect(names.slice(0, 3)).toEqual([
      'app-1.0-x86_64.msi',
      'app-1.0-x86_64.exe',
      'app-1.0-x86_64.zip',
    ]);
    // 同系统异架构（aarch64 msi）排在异系统之前
    const winArmIdx = names.indexOf('app-1.0-aarch64.msi');
    expect(winArmIdx).toBeLessThan(names.indexOf('app-1.0-x86_64.deb'));
    expect(winArmIdx).toBeLessThan(names.indexOf('app-1.0-x86_64.dmg'));
    expect(names[names.length - 1]).toBe('app-1.0-arm64.apk');
  });

  it('linux x86_64：deb 优先于 dmg/msi', () => {
    const names = sortAssetsByRelevance(assets, 'linux', 'x86_64').map((a) => a.name);
    expect(names[0]).toBe('app-1.0-x86_64.deb');
  });

  it('tar 便携包垫底：有原生包永远选原生，只有 tar 时才选中', () => {
    const mixed = [
      { name: 'app-1.0-x86_64.tar.gz', os: 'linux', arch: 'x86_64', kind: 'portable_tarball' },
      { name: 'app-1.0-x86_64.deb', os: 'linux', arch: 'x86_64', kind: 'deb' },
      { name: 'app-1.0-x86_64.zip', os: 'linux', arch: 'x86_64', kind: 'portable_zip' },
    ];
    const names = sortAssetsByRelevance(mixed, 'linux', 'x86_64').map((a) => a.name);
    expect(names).toEqual([
      'app-1.0-x86_64.deb',
      'app-1.0-x86_64.zip',
      'app-1.0-x86_64.tar.gz',
    ]);
  });

  it('不修改入参数组，分数相同时按文件名稳定排序', () => {
    const pair = [
      { name: 'b.msi', os: 'windows', arch: 'x86_64', kind: 'msi' },
      { name: 'a.msi', os: 'windows', arch: 'x86_64', kind: 'msi' },
    ];
    const sorted = sortAssetsByRelevance(pair, 'windows', 'x86_64');
    expect(sorted.map((a) => a.name)).toEqual(['a.msi', 'b.msi']);
    expect(pair[0].name).toBe('b.msi');
  });
});
