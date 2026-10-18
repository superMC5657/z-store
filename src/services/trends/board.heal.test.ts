/**
 * 富卡治愈镜像合并回归（`applyRichcardHealToMirror`）：
 * - 占位简介即使误带 dirty 也不覆盖实值；
 * - 镜像键缺席时经行 id 别名仍可命中；
 * - 预 enrich 行创建时剥图标通道与占位简介。
 */
import { describe, expect, it } from 'vitest';
import { applyRichcardHealToMirror } from './board';
import type { DetailRichcardHealPayload } from './enrich';
import { makeEnrichedApp } from '../../views/test-utils/trendFixture';

const REAL_DESC = 'A fast in-browser Markdown reserve editor';
const REAL_DESC_EN = 'A fast in-browser Markdown editor';
const PLACEHOLDER_DESC = 'GitHub 社区开源项目';
const PLACEHOLDER_DESC_EN = 'No description available';
const FALLBACK_BG = 'linear-gradient(135deg, #475569, #334155)';

function healPayload(overrides: Partial<DetailRichcardHealPayload>): DetailRichcardHealPayload {
  return {
    keys: ['acme/atlas'],
    summary: makeEnrichedApp({ id: 'acme/atlas' }),
    dirtyFields: [],
    ...overrides,
  };
}

describe('applyRichcardHealToMirror 占位守卫', () => {
  it('占位简介误带 dirty 不覆盖实值，其余 dirty 仍覆盖', () => {
    const prev = {
      'acme/atlas': makeEnrichedApp({
        id: 'acme/atlas',
        description: REAL_DESC,
        description_en: REAL_DESC_EN,
        stars: 100,
      }),
    };
    const next = applyRichcardHealToMirror(
      prev,
      healPayload({
        summary: makeEnrichedApp({
          id: 'acme/atlas',
          description: PLACEHOLDER_DESC,
          description_en: PLACEHOLDER_DESC_EN,
          stars: 200,
        }),
        dirtyFields: ['description', 'description_en', 'stars'],
      }),
      new Set(['acme/atlas']),
    );
    expect(next).not.toBe(prev);
    expect(next['acme/atlas']?.description).toBe(REAL_DESC);
    expect(next['acme/atlas']?.description_en).toBe(REAL_DESC_EN);
    expect(next['acme/atlas']?.stars).toBe(200);
  });

  it('真实简介 dirty 正常覆盖', () => {
    const prev = {
      'acme/atlas': makeEnrichedApp({ id: 'acme/atlas', description: REAL_DESC }),
    };
    const next = applyRichcardHealToMirror(
      prev,
      healPayload({
        summary: makeEnrichedApp({ id: 'acme/atlas', description: 'A brand new real description' }),
        dirtyFields: ['description'],
      }),
      new Set(['acme/atlas']),
    );
    expect(next['acme/atlas']?.description).toBe('A brand new real description');
  });
});

describe('applyRichcardHealToMirror 别名命中', () => {
  it('镜像键缺席时经行 id 别名命中并补丁', () => {
    const prev = {
      'legacy-key': makeEnrichedApp({ id: 'acme/atlas', stars: 100 }),
    };
    const next = applyRichcardHealToMirror(
      prev,
      healPayload({
        summary: makeEnrichedApp({ id: 'acme/atlas', stars: 300 }),
        dirtyFields: ['stars'],
      }),
      new Set(['acme/atlas']),
    );
    expect(next['legacy-key']?.stars).toBe(300);
  });

  it('镜像与别名均未命中时返回原引用', () => {
    const prev = {
      'other/app': makeEnrichedApp({ id: 'other/app', stars: 100 }),
    };
    const payload = healPayload({
      summary: makeEnrichedApp({ id: 'acme/atlas', stars: 300 }),
      dirtyFields: ['stars'],
    });
    expect(applyRichcardHealToMirror(prev, payload, new Set(['other/app']))).toBe(prev);
  });
});

describe('applyRichcardHealToMirror 预 enrich 行合成', () => {
  it('合成行剥图标通道与占位简介，平台取详情实值', () => {
    const next = applyRichcardHealToMirror(
      {},
      healPayload({
        keys: ['Acme/Atlas'],
        summary: makeEnrichedApp({
          id: 'acme/atlas',
          name: 'atlas',
          icon: 'https://cdn.example/icon.png',
          icon_bg: 'linear-gradient(red, blue)',
          description: PLACEHOLDER_DESC,
          description_en: PLACEHOLDER_DESC_EN,
          stars: 42,
          platforms: ['macos'],
        }),
        dirtyFields: ['stars'],
        platforms: ['windows', 'macos'],
      }),
      new Set(['acme/atlas']),
    );
    const row = next['acme/atlas'];
    expect(row).toBeDefined();
    expect(row?.name).toBe('atlas');
    expect(row?.stars).toBe(42);
    expect(row?.icon).toBe('');
    expect(row?.icon_bg).toBe(FALLBACK_BG);
    expect(row?.description).toBe('');
    expect(row?.description_en).toBe('');
    expect(row?.platforms).toEqual(['windows', 'macos']);
  });
});
