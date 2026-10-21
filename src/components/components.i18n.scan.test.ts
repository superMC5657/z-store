/**
 * i18n 静态扫描门禁（views.i18n.test.tsx 的 components 扩展面）。
 *
 * 对 MIGRATED_FILES 中的已迁移组件源码断言零 CJK 硬编码：基于 TypeScript AST
 * 检查字符串字面量 / 模板片段 / JSX 文本（注释天然不在 AST 字符串位，不受限）；
 * `t(key, { defaultValue })` 的兜底值豁免——键缺失回退允许中文，与 views 既有口径一致。
 * 新迁移 components 文件后把路径追加进 MIGRATED_FILES 即可纳入防回流扫描。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import zhCN from '../locales/zh-CN.json';
import enUS from '../locales/en-US.json';

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const MIGRATED_FILES = [
  'AppDetailModal/Header.tsx',
  'AppDetailModal/AssetList.tsx',
  'AppDetailModal/IconLevelBadge.tsx',
];

interface Violation {
  line: number;
  kind: 'string' | 'template' | 'jsx-text';
  text: string;
}

function scanFile(relativePath: string): Violation[] {
  const absolute = join(dirname(fileURLToPath(import.meta.url)), relativePath);
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: Violation[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const isDefaultValue = (node: ts.Node): boolean =>
    ts.isPropertyAssignment(node.parent) &&
    node.parent.name.getText(source) === 'defaultValue';

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !isDefaultValue(node) &&
      CJK.test(node.text)
    ) {
      violations.push({ line: lineOf(node), kind: 'string', text: node.text });
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (parts.some((p) => CJK.test(p))) {
        violations.push({ line: lineOf(node), kind: 'template', text: node.getSourceFile().getText().slice(node.getStart(), node.getEnd()) });
      }
    } else if (ts.isJsxText(node) && CJK.test(node.getText(source))) {
      violations.push({ line: lineOf(node), kind: 'jsx-text', text: node.getText(source).trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function flattenLocaleKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([key, value]) =>
    flattenLocaleKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('components i18n static scan (migrated files stay hardcoded-free)', () => {
  it.each(MIGRATED_FILES)('keeps CJK out of user-visible literals: %s', (file) => {
    expect(scanFile(file), `${file} 仍含 CJK 硬编码，请迁入 src/i18n.ts + locales 两侧`).toEqual([]);
  });

  it('keeps zh-CN and en-US locale key sets aligned', () => {
    const zhKeys = flattenLocaleKeys(zhCN);
    const enKeys = flattenLocaleKeys(enUS);
    const zhOnly = zhKeys.filter((k) => !enKeys.includes(k));
    const enOnly = enKeys.filter((k) => !zhKeys.includes(k));
    expect({ zhOnly, enOnly }).toEqual({ zhOnly: [], enOnly: [] });
  });
});
