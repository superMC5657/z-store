import { describe, expect, it } from 'vitest';
import type { AppSummary } from '../../types';
import { buildCustomDraftItemFromSummary, buildCustomDraftItemFromTrendRepo, draftForgeGateError } from './catalog';

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

describe('草稿 forge 门（后端 DraftLenient 同口径）', () => {
  it('GitHub 摘要放行（gate 返回 null）', () => {
    expect(draftForgeGateError(summaryWithIcon(''))).toBeNull();
  });

  it('非 GitHub forge 摘要拒绝（builder 会剥前缀记成 GitHub 应用）', () => {
    const app = { ...summaryWithIcon(''), id: 'codeberg:acme/atlas', forge: 'codeberg' };
    expect(draftForgeGateError(app)).toContain('codeberg');
    expect(() => buildCustomDraftItemFromSummary(app as AppSummary)).toThrow(/codeberg/);
  });

  it('未知前缀 id 按 canonical 解析拒绝（单出口）', () => {
    const app = { ...summaryWithIcon(''), id: 'xyz:acme/atlas' };
    expect(draftForgeGateError(app)).toContain('无法识别的应用标识');
    expect(() => buildCustomDraftItemFromSummary(app as AppSummary)).toThrow(/无法识别/);
  });

  it('已知 forge 前缀 id 按形态拒绝（后端 `:` 闸同口径）', () => {
    expect(draftForgeGateError({ ...summaryWithIcon(''), id: 'gh:acme/atlas' })).toContain(
      'forge 形态 id 暂不收录',
    );
  });
});
