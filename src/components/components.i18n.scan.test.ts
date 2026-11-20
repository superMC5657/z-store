/** AST 静态扫描已迁移组件，防止硬编码 CJK 文案回流。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import zhCN from '../locales/zh-CN.json';
import enUS from '../locales/en-US.json';

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const MIGRATED_FILES = [
  'AffinityPrivacyRow.tsx',
  'AppCard.tsx',
  'AppIcon.tsx',
  'AppImportModal.tsx',
  'BrandLogo.tsx',
  'ClientUpdateRow.tsx',
  'DataBackupRow.tsx',
  'DeveloperProfileModal.tsx',
  'EmptyState.tsx',
  'ErrorBoundary.tsx',
  'FlyoutMenu.tsx',
  'InlineConfirmButton.tsx',
  'OAuthAccountCard.tsx',
  'ResizeHandles.tsx',
  'RulesManagerModal.tsx',
  'SegmentedControl.tsx',
  'Sidebar.tsx',
  'TitleBar.tsx',
  'Toast.tsx',
  'VerifiedBadge.tsx',
  'AppIconFrame.tsx',
  'AppDetailModal/Header.tsx',
  'AppDetailModal/AssetList.tsx',
  'AppDetailModal/IconLevelBadge.tsx',
  'AppDetailModal/index.tsx',
  'AppDetailModal/InstallActions.tsx',
  'AppDetailModal/ReadmeSection.tsx',
  'AppDetailModal/useDetailReadme.ts',
  'AppDetailModal/useDetailStarVerify.ts',
  '../views/pending/PendingDraftForm.tsx',
  '../views/pending/PendingListColumn.tsx',
  '../views/pending/PendingPreviewLane.tsx',
  '../views/pending/PendingRichCard.tsx',
  '../views/manage/ManageHeader.tsx',
  '../views/manage/ManageFilterBar.tsx',
  '../views/manage/ManageMenuItem.tsx',
  '../views/InstalledView/InstalledItemActions.tsx',
  '../views/InstalledView.tsx',
  '../views/FavoritesView/WatchReleasesPanel.tsx',
  '../views/InstalledView/CheckProgressBanner.tsx',
  '../views/InstalledView/ChangelogDrawer.tsx',
  '../views/SettingsView/sections/DataManagementSection.tsx',
  '../app/InstallConfirmDialog.tsx',
  '../views/LaunchpadView.tsx',
  '../views/LaunchpadView/LaunchpadCard.tsx',
  '../views/LaunchpadView/LaunchpadDiscussionModal.tsx',
  '../views/LaunchpadView/DiscussionComposer.tsx',
  '../views/LaunchpadView/DiscussionMarkdown.tsx',
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
