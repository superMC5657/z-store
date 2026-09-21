import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { CategoriesView } from './CategoriesView';
import { InstalledView } from './InstalledView';
import { FavoritesView } from './FavoritesView';
import { UpdatesView } from './UpdatesView';
import { RulesManagerModal } from '../components/RulesManagerModal';
import { AppSummary, InstalledApp, UpdateRule } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

const MOCK_APP: AppSummary = {
  id: 'test/demo-app',
  name: 'Demo App',
  owner: 'test',
  repo: 'demo-app',
  icon: '',
  icon_bg: '#333333',
  description: 'A test demo app',
  stars: 1200,
  forks: 300,
  license: 'MIT',
  latest_version: '1.2.0',
  category: 'system',
  category_name: '系统实用',
  is_verified: true,
  forge: 'github',
  forge_host: 'github.com',
  homepage: null,
  platforms: ['windows'],
};

const MOCK_INSTALLED: InstalledApp = {
  app_id: 'test/demo-app',
  app_name: 'Demo App',
  version: '1.2.0',
  installed_at: 1700000000,
  install_path: 'C:\\Apps\\demo',
  install_method: 'direct_zip',
  asset_name: 'demo.zip',
  asset_sha256: 'abc123',
};

const MOCK_RULE: UpdateRule = {
  app_id: 'test/demo-app',
  skipped_version: '1.3.0',
  is_frozen: true,
  is_hidden: false,
  updated_at: 1700000000,
};

describe('Content Views Internationalization (zh-CN <-> en-US)', () => {
  describe('CategoriesView i18n', () => {
    it('switches category titles and descriptions between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <CategoriesView
          apps={[MOCK_APP]}
          installedIds={new Set()}
          favoriteIds={new Set()}
          onOpenDetail={() => {}}
          onQuickInstall={() => {}}
          onToggleFavorite={() => {}}
          onResetPlatformFilter={() => {}}
        />,
      );

      expect(screen.getByText('按主题领域浏览')).toBeTruthy();
      expect(screen.getByText('开发工具')).toBeTruthy();
      expect(screen.getByText('IDE, 编辑器, 调试台, 版本控制')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <CategoriesView
          apps={[MOCK_APP]}
          installedIds={new Set()}
          favoriteIds={new Set()}
          onOpenDetail={() => {}}
          onQuickInstall={() => {}}
          onToggleFavorite={() => {}}
          onResetPlatformFilter={() => {}}
        />,
      );

      expect(screen.getByText('Browse by Category')).toBeTruthy();
      expect(screen.getByText('Development')).toBeTruthy();
      expect(screen.getByText('IDEs, editors, terminals, and version control')).toBeTruthy();
    });
  });

  describe('InstalledView i18n', () => {
    it('switches toolbar and empty state between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <InstalledView
          installedApps={[]}
          onLaunch={() => {}}
          onUninstall={() => {}}
          onOpenRules={() => {}}
          onExportAppsJson={() => {}}
          onScanSystemApps={() => {}}
        />,
      );

      expect(screen.getByText(/已安装应用.*\(0\)/)).toBeTruthy();
      expect(screen.getByText('规则')).toBeTruthy();
      expect(screen.getByText('导出清单')).toBeTruthy();
      expect(screen.getByText('扫描本地应用')).toBeTruthy();
      expect(screen.getByText('暂无已安装应用')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <InstalledView
          installedApps={[]}
          onLaunch={() => {}}
          onUninstall={() => {}}
          onOpenRules={() => {}}
          onExportAppsJson={() => {}}
          onScanSystemApps={() => {}}
        />,
      );

      expect(screen.getByText(/Installed Apps.*\(0\)/)).toBeTruthy();
      expect(screen.getByText('Rules')).toBeTruthy();
      expect(screen.getByText('Export List')).toBeTruthy();
      expect(screen.getByText('Scan Local Apps')).toBeTruthy();
      expect(screen.getByText('No Installed Apps')).toBeTruthy();
    });

    it('switches installed item action buttons between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <InstalledView
          installedApps={[MOCK_INSTALLED]}
          onLaunch={() => {}}
          onUninstall={() => {}}
        />,
      );

      expect(screen.getByText('启动')).toBeTruthy();
      expect(screen.getByText('卸载')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <InstalledView
          installedApps={[MOCK_INSTALLED]}
          onLaunch={() => {}}
          onUninstall={() => {}}
        />,
      );

      expect(screen.getByText('Launch')).toBeTruthy();
      expect(screen.getByText('Uninstall')).toBeTruthy();
    });
  });

  describe('FavoritesView i18n', () => {
    it('switches tabs, placeholders, and empty states between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <FavoritesView
          apps={[]}
          favoriteIds={new Set()}
          installedIds={new Set()}
          onOpenDetail={() => {}}
          onQuickInstall={() => {}}
          onToggleFavorite={() => {}}
        />,
      );

      expect(screen.getByText('本地收藏 (0)')).toBeTruthy();
      expect(screen.getByText('关注更新 (0)')).toBeTruthy();
      expect(screen.getByText('GitHub Star 同步')).toBeTruthy();
      expect(screen.getByPlaceholderText('搜索名称 / 别名 / owner/repo...')).toBeTruthy();
      expect(screen.getByText('收藏夹还是空的')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <FavoritesView
          apps={[]}
          favoriteIds={new Set()}
          installedIds={new Set()}
          onOpenDetail={() => {}}
          onQuickInstall={() => {}}
          onToggleFavorite={() => {}}
        />,
      );

      expect(screen.getByText('Favorites (0)')).toBeTruthy();
      expect(screen.getByText('Watched (0)')).toBeTruthy();
      expect(screen.getByText('GitHub Star Sync')).toBeTruthy();
      expect(screen.getByPlaceholderText('Search name / alias / owner/repo...')).toBeTruthy();
      expect(screen.getByText('Favorites list is empty')).toBeTruthy();
    });
  });

  describe('RulesManagerModal i18n', () => {
    it('switches modal title, tabs, and action buttons between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <RulesManagerModal
          isOpen={true}
          onClose={() => {}}
          updateRules={[MOCK_RULE]}
          installedApps={[MOCK_INSTALLED]}
          onRemoveRule={async () => {}}
          onClearRuleSkip={async () => {}}
          onToggleRuleFrozen={async () => {}}
          onToggleRuleHidden={async () => {}}
        />,
      );

      expect(screen.getByText('版本策略与屏蔽规则管理 (1)')).toBeTruthy();
      expect(screen.getByText('新建规则')).toBeTruthy();
      expect(screen.getByText(/全部.*\(1\)/)).toBeTruthy();
      expect(screen.getByText('跳过 1.3.0')).toBeTruthy();
      expect(screen.getByText('已锁定版本')).toBeTruthy();
      expect(screen.getByText('恢复提醒')).toBeTruthy();
      expect(screen.getByText('解除版本锁定')).toBeTruthy();
      expect(screen.getByText('完成')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <RulesManagerModal
          isOpen={true}
          onClose={() => {}}
          updateRules={[MOCK_RULE]}
          installedApps={[MOCK_INSTALLED]}
          onRemoveRule={async () => {}}
          onClearRuleSkip={async () => {}}
          onToggleRuleFrozen={async () => {}}
          onToggleRuleHidden={async () => {}}
        />,
      );

      expect(screen.getByText('Version Policies & Ignore Rules (1)')).toBeTruthy();
      expect(screen.getByText('New Rule')).toBeTruthy();
      expect(screen.getByText(/All.*\(1\)/)).toBeTruthy();
      expect(screen.getByText('Skip 1.3.0')).toBeTruthy();
      expect(screen.getByText('Version Pinned')).toBeTruthy();
      expect(screen.getByText('Restore Reminder')).toBeTruthy();
      expect(screen.getByText('Unpin Version')).toBeTruthy();
      expect(screen.getByText('Done')).toBeTruthy();
    });
  });

  describe('UpdatesView i18n', () => {
    it('switches updates header and empty state between Chinese and English', async () => {
      await i18n.changeLanguage('zh-CN');
      const { unmount } = render(
        <UpdatesView
          updates={[]}
          isChecking={false}
          onCheckUpdates={async () => {}}
          onApplyUpdate={async () => {}}
          onBatchUpdateAll={async () => {}}
        />,
      );

      expect(screen.getByText(/应用更新.*\(0\)/)).toBeTruthy();
      expect(screen.getByText('检查更新')).toBeTruthy();
      expect(screen.getByText('所有应用均已是最新版本')).toBeTruthy();
      unmount();

      await i18n.changeLanguage('en-US');
      render(
        <UpdatesView
          updates={[]}
          isChecking={false}
          onCheckUpdates={async () => {}}
          onApplyUpdate={async () => {}}
          onBatchUpdateAll={async () => {}}
        />,
      );

      expect(screen.getByText(/App Updates.*\(0\)/)).toBeTruthy();
      expect(screen.getByText('Check Updates')).toBeTruthy();
      expect(screen.getByText('All Applications Are Up to Date')).toBeTruthy();
    });
  });
});
