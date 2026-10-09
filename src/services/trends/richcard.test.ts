/**
 * 富卡简介占位回归：真实简介 + 详情回占位 → enriched 简介保持不变。
 *
 * 占位生产点（Rust，只读）：未收录 external_synth
 * `github/catalog_service.rs` → "GitHub 社区开源项目"、
 * 在线搜索空描述 `github/search.rs` → "开源软件项目"、
 * 单仓直查 `commands/catalog_search.rs` → "跨平台开源项目"。
 * 三处设防（diff 不脏 / merge 不覆盖 / patch 不写）由本文件锁定。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appSummaryFromDetail,
  clearTrendEnrichCache,
  diffRichSummary,
  hydrateTrendEnrichCache,
  isPlaceholderDescription,
  snapshotTrendEnrichCache,
  upsertTrendEnrichRichcard,
} from './enrich';
import { makeEnrichedApp } from '../../views/test-utils/trendFixture';
import type { AppDetail } from '../../types';

const REAL_DESC = 'A fast in-browser Markdown reserve editor';
const PLACEHOLDER = 'GitHub 社区开源项目';

function placeholderDetail(): AppDetail {
  return {
    id: 'acme/atlas',
    name: 'atlas',
    description_en: undefined,
    owner: 'acme',
    repo: 'atlas',
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: PLACEHOLDER,
    stars: 1500,
    forks: 200,
    license: 'MIT',
    latest_version: 'v1.0.0',
    changelog: '',
    is_verified: false,
    readme_markdown: '',
    releases: [],
    category: 'dev',
    category_name: '开发工具',
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

describe('富卡简介占位名单', () => {
  beforeEach(() => clearTrendEnrichCache());
  afterEach(() => clearTrendEnrichCache());

  it('占位文案识别：已知三处 Rust 合成 + 展示兜底', () => {
    expect(isPlaceholderDescription('GitHub 社区开源项目')).toBe(true);
    expect(isPlaceholderDescription('开源软件项目')).toBe(true);
    expect(isPlaceholderDescription('跨平台开源项目')).toBe(true);
    expect(isPlaceholderDescription('暂无简介')).toBe(true);
    expect(isPlaceholderDescription('No description')).toBe(true);
    expect(isPlaceholderDescription(REAL_DESC)).toBe(false);
    expect(isPlaceholderDescription('')).toBe(false);
    expect(isPlaceholderDescription(null)).toBe(false);
    expect(isPlaceholderDescription(undefined)).toBe(false);
  });

  it('diffRichSummary：详情回占位不脏，真实变更仍脏', () => {
    const prev = makeEnrichedApp({ id: 'acme/atlas', description: REAL_DESC });
    const placeholderNext = { ...prev, description: PLACEHOLDER };
    expect(diffRichSummary(prev, placeholderNext)).not.toContain('description');
    const realNext = { ...prev, description: 'A brand new real description' };
    expect(diffRichSummary(prev, realNext)).toContain('description');
  });

  it('appSummaryFromDetail：只剥占位简介，不动其它字段', () => {
    const summary = appSummaryFromDetail(placeholderDetail());
    expect(summary.description).toBe('');
    expect(summary.name).toBe('atlas');
    expect(summary.stars).toBe(1500);
    expect(summary.platforms).toEqual(['windows']);
  });

  it('upsert：真实简介 + 详情回占位 → enriched 简介保持不变且不进盘', () => {
    hydrateTrendEnrichCache({
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', description: REAL_DESC }),
    });
    const healed = upsertTrendEnrichRichcard(placeholderDetail());
    expect(healed).not.toBeNull();
    expect(healed!.dirtyFields).not.toContain('description');
    const snap = snapshotTrendEnrichCache();
    expect(snap['acme/atlas']?.description).toBe(REAL_DESC);
  });
});
