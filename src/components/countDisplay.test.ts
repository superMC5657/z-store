/** 检查 i18n 文案与源码是否符合数量角标显示规范（`docs/count-display.md`）。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../locales/zh-CN.json';
import enUS from '../locales/en-US.json';
import { formatCount } from './CountBadge';

const SRC = join(process.cwd(), 'src');

function flatten(obj: unknown, prefix = ''): Array<[string, string]> {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** 括号里只有一个插值：`({{count}})`、`（{{fav}}）`。非数量插值（如 CPU 架构）列入白名单。 */
const PAREN_INTERPOLATION_IN_COPY = /[(（]\s*\{\{\s*(\w+)\s*\}\}\s*[)）]/g;
const NON_COUNT_INTERPOLATIONS = new Set(['arch']);
/** 匹配紧跟标签的括号计数表达式，跳过带空格或解构的 `({ ... })`。 */
const PAREN_COUNT_IN_JSX = /\(\{(?![\s{])[^{},]*?(\.length|\.size|[cC]ounts?\b[^{},]*)\}\)/;
/** 各视图私有的计数样式；数量一律走 .count-badge */
const BANNED_COUNT_CLASSES = [
  'badge-capsule',
  'nav-badge',
  'manage-count-pill',
  'manage-filter-tab-count',
  'pending-segment-count',
  'pending-section-count',
  'segmented-count',
  'trends-count',
  'category-count-pill',
  'categories-spectrum-total',
];

describe('count display spec', () => {
  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ])('%s copy has no parenthesized counts', (_lang, dict) => {
    const offenders = flatten(dict)
      .filter(([, v]) =>
        [...v.matchAll(PAREN_INTERPOLATION_IN_COPY)].some(([, name]) => !NON_COUNT_INTERPOLATIONS.has(name)),
      )
      .map(([k, v]) => `${k} = ${v}`);
    expect(offenders).toEqual([]);
  });

  it('source has no hand-written parenthesized counts or per-view count classes', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (file.endsWith('.tsx') && PAREN_COUNT_IN_JSX.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
          for (const cls of BANNED_COUNT_CLASSES) {
            if (new RegExp(`(^|[\\s."'\`])${cls}(?![\\w-])`).test(line)) offenders.push(`${rel}:${i + 1} .${cls}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('caps large counts at 999+', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('999+');
  });
});
