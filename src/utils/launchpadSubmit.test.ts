import { describe, expect, it } from 'vitest';
import {
  buildLaunchpadIssueUrl,
  buildPreviewLaunchpadEntry,
  LAUNCHPAD_CATEGORIES,
  LAUNCHPAD_TIERS,
  resolveIssueRepoUrl,
  validateCustomIconUrl,
  validateMakerNote,
  validateMakerNoteEn,
} from './launchpadSubmit';
import type { LaunchpadPreflightResult } from '../types';

const PASS_PREFLIGHT: LaunchpadPreflightResult = {
  ok: true,
  canonical_id: 'acme/hyper-term',
  forge: 'github',
  forge_host: 'github.com',
  owner: 'acme',
  repo: 'hyper-term',
  repo_name: 'HyperTerm',
  description: 'GPU terminal',
  homepage: 'https://hyper.example.dev',
  license: 'MIT',
  latest_version: 'v1.2.0',
  platforms: ['windows', 'linux'],
  installable_asset_count: 2,
  has_checksum_manifest: true,
  resolved_icon_url: 'https://cdn.simpleicons.org/hyper',
  stars: 420,
  forks: 30,
  maker_avatar_url: 'https://github.com/acme.png',
  already_in_launchpad: false,
  already_in_catalog: false,
  checks: [],
};

describe('launchpadSubmit helpers', () => {
  it('validates maker_note single-line and 140 Unicode char limit', () => {
    expect(validateMakerNote('')).toMatchObject({ ok: false, error: 'empty' });
    expect(validateMakerNote('   ')).toMatchObject({ ok: false, error: 'empty' });
    expect(validateMakerNote('line 1\nline 2')).toMatchObject({
      ok: false,
      hasNewline: true,
      error: 'newline',
    });
    expect(validateMakerNote('a'.repeat(140))).toMatchObject({ ok: true, length: 140, error: null });
    expect(validateMakerNote('中'.repeat(141))).toMatchObject({
      ok: false,
      length: 141,
      error: 'too_long',
    });

    expect(validateMakerNoteEn('')).toMatchObject({ ok: true, error: null });
    expect(validateMakerNoteEn('two\nlines')).toMatchObject({ ok: false, error: 'newline' });
    expect(validateMakerNoteEn('x'.repeat(141))).toMatchObject({ ok: false, error: 'too_long' });
  });

  it('rejects non-https custom icon URLs and resolves repository URL', () => {
    expect(validateCustomIconUrl('')).toMatchObject({ ok: true, clean: '' });
    expect(validateCustomIconUrl('https://example.com/icon.png')).toMatchObject({ ok: true });
    expect(validateCustomIconUrl('http://example.com/icon.png')).toMatchObject({
      ok: false,
      error: 'invalid_https',
    });
    expect(validateCustomIconUrl('data:image/png;base64,AAAA')).toMatchObject({
      ok: false,
      error: 'invalid_https',
    });

    expect(resolveIssueRepoUrl('@acme/hyper-term', PASS_PREFLIGHT)).toBe(
      'https://github.com/acme/hyper-term',
    );
    expect(resolveIssueRepoUrl('acme/hyper-term')).toBe('https://github.com/acme/hyper-term');
  });

  it('aligns categories and tiers and encodes submit-launchpad.yml Issue Form URL', () => {
    expect(LAUNCHPAD_CATEGORIES).toEqual([
      'dev',
      'system',
      'network',
      'media',
      'security',
      'graphics',
      'office',
      'reading',
      'ops',
      'games',
    ]);
    expect(LAUNCHPAD_TIERS).toEqual(['free', 'spotlight-7d', 'spotlight-14d', 'spotlight-30d']);

    const urlStr = buildLaunchpadIssueUrl(
      'https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml&source=zstore',
      {
        repoUrl: 'https://github.com/acme/hyper-term',
        appName: 'HyperTerm',
        category: 'dev',
        makerNote: '轻量 GPU 终端工具，支持跨平台配置。',
        makerNoteEn: 'Lightweight GPU terminal.',
        launchTier: 'spotlight-7d',
        customIconUrl: 'https://example.com/logo.png',
      },
    );
    const parsed = new URL(urlStr);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://github.com/superMC5657/z-store-launchpad/issues/new',
    );
    expect(parsed.searchParams.get('template')).toBe('submit-launchpad.yml');
    expect(parsed.searchParams.get('source')).toBe('zstore');
    expect(parsed.searchParams.get('title')).toBe('[Launchpad] HyperTerm');
    expect(parsed.searchParams.get('repo_url')).toBe('https://github.com/acme/hyper-term');
    expect(parsed.searchParams.get('app_name')).toBe('HyperTerm');
    expect(parsed.searchParams.get('category')).toMatch(/^dev\b/);
    expect(parsed.searchParams.get('maker_note')).toBe('轻量 GPU 终端工具，支持跨平台配置。');
    expect(parsed.searchParams.get('maker_note_en')).toBe('Lightweight GPU terminal.');
    expect(parsed.searchParams.get('launch_tier')).toMatch(/^spotlight-7d\b/);
    expect(parsed.searchParams.get('custom_icon_url')).toBe('https://example.com/logo.png');
    expect(parsed.searchParams.has('homepage')).toBe(false);
  });

  it('builds LaunchpadEntry preview reflecting tier pin state and preflight resolved icon', () => {
    const entry = buildPreviewLaunchpadEntry(
      {
        repoUrl: 'https://github.com/acme/hyper-term',
        appName: 'HyperTerm Pro',
        category: 'dev',
        makerNote: '一句话自荐',
        launchTier: 'spotlight-14d',
        customIconUrl: '',
      },
      PASS_PREFLIGHT,
    );
    expect(entry.summary.id).toBe('acme/hyper-term');
    expect(entry.summary.name).toBe('HyperTerm Pro');
    expect(entry.summary.icon).toBe('https://cdn.simpleicons.org/hyper');
    expect(entry.summary.platforms).toEqual(['windows', 'linux']);
    expect(entry.is_pinned).toBe(true);
    expect(entry.pin_tier).toBe('sponsor');

    // When preflight has completed (including D8 fallback), preview uses preflight.resolved_icon_url
    const fallbackEntry = buildPreviewLaunchpadEntry(
      {
        repoUrl: 'https://github.com/acme/hyper-term',
        appName: 'HyperTerm',
        category: 'dev',
        makerNote: '一句话自荐',
        launchTier: 'free',
        customIconUrl: 'https://example.com/broken.png',
      },
      PASS_PREFLIGHT,
    );
    expect(fallbackEntry.is_pinned).toBe(false);
    expect(fallbackEntry.pin_tier).toBeNull();
    expect(fallbackEntry.summary.icon).toBe('https://cdn.simpleicons.org/hyper');

    // Before preflight completes, a valid https:// customIconUrl is previewed directly
    const unverifiedEntry = buildPreviewLaunchpadEntry(
      {
        repoUrl: 'https://github.com/acme/hyper-term',
        appName: 'HyperTerm',
        category: 'dev',
        makerNote: '一句话自荐',
        launchTier: 'free',
        customIconUrl: 'https://example.com/custom.png',
      },
      null,
    );
    expect(unverifiedEntry.summary.icon).toBe('https://example.com/custom.png');
  });
});
