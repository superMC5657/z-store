import { describe, expect, it } from 'vitest';
import type { AppSummary } from '../types';
import {
  COLLECTION_MAX_APPS,
  COLLECTION_MAX_DEEPLINK_LEN,
  buildCollectionDeepLink,
  buildCollectionMarkdown,
  escapeMarkdownCell,
} from './collectionShare';

function makeApp(partial: Partial<AppSummary> & Pick<AppSummary, 'id' | 'name'>): AppSummary {
  const [owner, repo] = partial.id.split('/');
  return {
    owner: owner ?? 'owner',
    repo: repo ?? partial.name.toLowerCase(),
    icon: '',
    icon_bg: '#333333',
    description: '默认简介',
    description_en: 'Default description',
    stars: 100,
    forks: 10,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'tools',
    category_name: '效率工具',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows', 'linux'],
    ...partial,
  };
}

describe('collectionShare helpers', () => {
  it('encodes deep link cleanly, deduplicates, omits empty title/note, and caps at 30 apps', () => {
    const ids = [
      'RustDesk/RustDesk',
      'https://github.com/rustdesk/rustdesk',
      'bad-single-segment',
      ...Array.from({ length: 35 }, (_, i) => `Owner${i}/Repo${i}`),
    ];
    const res = buildCollectionDeepLink({
      title: '  Rust \x07  装机清单  ',
      note: '   ',
      appIds: ids,
    });

    expect(res.appIds).toHaveLength(COLLECTION_MAX_APPS);
    expect(res.appIds[0]).toBe('rustdesk/rustdesk');
    expect(res.url.startsWith('zstore://collection?ids=rustdesk/rustdesk,owner0/repo0')).toBe(true);
    expect(res.url).toContain(`title=${encodeURIComponent('Rust 装机清单')}`);
    expect(res.url).not.toContain('note=');
    expect(res.exceedsMaxLen).toBe(false);
  });

  it('detects when deep link exceeds 2048 bytes', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `very-long-organization-${i}/very-long-repository-name-${i}`);
    const res = buildCollectionDeepLink({
      title: '超长合集标题'.repeat(10),
      note: '超长中文备注说明内容'.repeat(20),
      appIds: ids,
    });

    expect(res.length).toBeGreaterThan(COLLECTION_MAX_DEEPLINK_LEN);
    expect(res.exceedsMaxLen).toBe(true);
    expect(res.nearMaxLen).toBe(true);
  });

  it('generates Markdown table and escapes pipe characters cleanly', () => {
    expect(escapeMarkdownCell('A | B\nC')).toBe('A \\| B C');

    const apps: AppSummary[] = [
      makeApp({
        id: 'rustdesk/rustdesk',
        name: 'Rust | Desk',
        description: '远程桌面 | 高效稳定',
        license: 'AGPL-3.0',
        platforms: ['windows', 'macos'],
      }),
    ];
    const deepLink = buildCollectionDeepLink({
      title: '远程办公',
      note: '开箱即用',
      appIds: apps.map((a) => a.id),
    });

    const md = buildCollectionMarkdown({
      title: '远程办公',
      note: '开箱即用',
      apps,
      deepLinkUrl: deepLink.url,
      locale: 'zh-CN',
    });

    expect(md).toContain('# 远程办公');
    expect(md).toContain('> 开箱即用');
    expect(md).toContain('| 应用 | 仓库 | 协议 | 平台 | 简介 |');
    expect(md).toContain('| Rust \\| Desk | [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | AGPL-3.0 | Windows, macOS | 远程桌面 \\| 高效稳定 |');
    expect(md).toContain(`\`${deepLink.url}\``);
  });
});
