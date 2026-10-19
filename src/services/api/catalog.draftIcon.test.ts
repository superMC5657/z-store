import { describe, expect, it } from 'vitest';
import type { AppSummary } from '../../types';
import { buildCustomDraftItemFromSummary, buildCustomDraftItemFromTrendRepo } from './catalog';

function summaryWithIcon(icon: unknown): AppSummary {
  return {
    id: 'acme/atlas',
    name: 'Atlas',
    owner: 'acme',
    repo: 'atlas',
    icon: icon as string,
    icon_bg: '',
    description: 'demo',
    stars: 1,
    forks: 2,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'dev',
    category_name: '开发工具',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: [],
  };
}

describe('移入收录预填图标只允许远程路径', () => {
  it('base64 置空（后续详情 icon 链回填）', () => {
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA')).icon).toBe(
      '',
    );
  });

  it('http 保留', () => {
    expect(
      buildCustomDraftItemFromSummary(summaryWithIcon('http://example.com/icon.png')).icon,
    ).toBe('http://example.com/icon.png');
  });

  it('https 保留（含首尾空格归一）', () => {
    expect(
      buildCustomDraftItemFromSummary(summaryWithIcon('  https://example.com/icon.png  ')).icon,
    ).toBe('https://example.com/icon.png');
  });

  it('空/相对路径一律置空', () => {
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('   ')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('/icons/atlas.png')).icon).toBe('');
    expect(buildCustomDraftItemFromSummary(summaryWithIcon('icons/atlas.png')).icon).toBe('');
  });

  it('trend 草稿 icon 恒空（仅远程允许）', () => {
    const draft = buildCustomDraftItemFromTrendRepo({
      owner: 'acme',
      repo: 'atlas',
      name: 'Atlas',
    });
    expect(draft.icon).toBe('');
  });
});

describe('iconRemote remote truth (restoreOrFetchIconCycle().remote_url)', () => {
  it('remote http prioritized over M2 data: display state', () => {
    const draft = buildCustomDraftItemFromSummary(
      summaryWithIcon('data:image/png;base64,AAA'),
      'https://example.com/remote.png',
    );
    expect(draft.icon).toBe('https://example.com/remote.png');
  });

  it('remote wins when both are http', () => {
    const draft = buildCustomDraftItemFromSummary(
      summaryWithIcon('http://example.com/stale.png'),
      'https://example.com/remote.png',
    );
    expect(draft.icon).toBe('https://example.com/remote.png');
  });

  it('remote data: falls back to app.icon http truth', () => {
    const draft = buildCustomDraftItemFromSummary(
      summaryWithIcon('https://example.com/app.png'),
      'data:image/png;base64,AAA',
    );
    expect(draft.icon).toBe('https://example.com/app.png');
  });

  it('failed/empty remote with data: app.icon stays empty (no fabrication)', () => {
    expect(
      buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA'), undefined).icon,
    ).toBe('');
    expect(
      buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA'), '').icon,
    ).toBe('');
    expect(
      buildCustomDraftItemFromSummary(summaryWithIcon('data:image/png;base64,AAA'), null).icon,
    ).toBe('');
  });
});
