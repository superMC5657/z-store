/** 按钮尺寸阶梯、语义变体与实心品牌图标缩比对齐测试。 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../i18n';

vi.mock('../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'fetchStarredStatus') return async () => false;
        if (prop === 'openUrl') return async () => undefined;
        if (prop === 'restoreOrFetchIconCycle') return async () => null;
        if (prop === 'getDeveloperProfile') {
          return async () => ({
            login: 'acme',
            name: 'Acme Dev',
            avatar_url: 'https://example.com/avatar.png',
            html_url: 'https://github.com/acme',
            bio: 'Developer',
            public_repos: 2,
            followers: 10,
            company: null,
            location: null,
            blog: null,
            repos_truncated: false,
            repos: [
              {
                id: 'acme/tool',
                name: 'tool',
                description: 'Cataloged tool',
                stars: 100,
                forks: 10,
                language: 'Rust',
                html_url: 'https://github.com/acme/tool',
                in_catalog: true,
              },
              {
                id: 'acme/extra',
                name: 'extra',
                description: 'Uncataloged tool',
                stars: 50,
                forks: 5,
                language: 'TypeScript',
                html_url: 'https://github.com/acme/extra',
                in_catalog: false,
              },
            ],
          });
        }
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

import { AppCard } from '../components/AppCard';
import { InlineConfirmButton } from '../components/InlineConfirmButton';
import { PlatformIcon, ForgeIcon } from '../components/icons/PlatformIcons';
import { InstalledView } from '../views/InstalledView';
import { WatchReleasesPanel } from '../views/FavoritesView/WatchReleasesPanel';
import { RulesManagerModal } from '../components/RulesManagerModal';
import { DeveloperProfileModal } from '../components/DeveloperProfileModal';
import { AppDetailModal } from '../components/AppDetailModal';
import type { AppDetailViewModel, AppSummary, InstalledApp, UpdateItem } from '../types';

const here = path.dirname(fileURLToPath(import.meta.url));
const buttonsCss = fs.readFileSync(path.resolve(here, './components-buttons.css'), 'utf8');
const segmentedCss = fs.readFileSync(path.resolve(here, './components-segmented.css'), 'utf8');
const modalCss = fs.readFileSync(path.resolve(here, './components-modal.css'), 'utf8');
const titlebarCss = fs.readFileSync(path.resolve(here, './layout-titlebar.css'), 'utf8');

afterEach(() => {
  cleanup();
});

const SAMPLE_APP: AppSummary = {
  id: 'acme/tool',
  name: 'Acme Tool',
  owner: 'acme',
  repo: 'tool',
  icon: '',
  icon_bg: '#334155',
  description: 'A sample app',
  stars: 1200,
  forks: 50,
  license: 'MIT',
  latest_version: 'v1.0.0',
  category: 'external',
  category_name: 'external',
  is_verified: false,
  forge: 'github',
  forge_host: 'github.com',
  homepage: null,
  platforms: ['windows'],
  is_cataloged: false,
};

describe('CSS button scale & inverted optical parity', () => {
  it('defines strict 30 / 28 / 26px height tiers and square icon-only rules', () => {
    expect(buttonsCss).toMatch(/\.btn-fluent\s*\{[^}]*height:\s*30px;[^}]*min-height:\s*30px;[^}]*max-height:\s*30px;/s);
    expect(buttonsCss).toMatch(/\.btn-fluent\.btn-compact\s*\{[^}]*height:\s*28px;[^}]*min-height:\s*28px;[^}]*max-height:\s*28px;/s);
    expect(buttonsCss).toMatch(/\.btn-fluent\.btn-sm\s*\{[^}]*height:\s*26px;[^}]*min-height:\s*26px;[^}]*max-height:\s*26px;/s);
    expect(buttonsCss).toContain('.btn-fluent.btn-icon-only');
    expect(buttonsCss).toContain('.btn-fluent.btn-compact.btn-icon-only');
    expect(buttonsCss).toContain('.btn-fluent.btn-sm.btn-icon-only');
  });

  it('defines btn-danger, btn-danger-solid, and btn-warning variants', () => {
    expect(buttonsCss).toContain('.btn-danger {');
    expect(buttonsCss).toContain('.btn-danger-solid {');
    expect(buttonsCss).toContain('.btn-warning {');
  });

  it('keeps btn-primary free of height overrides and applies padding-box', () => {
    const primaryBlock = buttonsCss.match(/\.btn-primary\s*\{[^}]*\}/)?.[0] ?? '';
    expect(primaryBlock).not.toContain('height:');
    expect(primaryBlock).not.toContain('padding:');
    expect(primaryBlock).toContain('background-clip: padding-box');
    expect(buttonsCss).not.toContain('scale(0.92)');
  });

  it('defines 34px default and 30px compact tier for SegmentedControl', () => {
    expect(segmentedCss).toContain('.segmented-group.segmented-compact');
    expect(segmentedCss).toMatch(/\.segmented-group\.segmented-compact\s*\{[^}]*height:\s*30px;/s);
    expect(segmentedCss).toMatch(/\.segmented-group\.segmented-compact\s+\.segmented-item\s*\{[^}]*height:\s*26px;/s);
  });

  it('preserves focus-visible outlines on titlebar win-btn and modal header buttons', () => {
    expect(titlebarCss).toContain('.win-btn:focus-visible');
    expect(modalCss).toContain('.modal-header-btn:focus-visible');
  });

  it('defines monochrome .modal-meta-link states in components-modal.css', () => {
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = modalCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
      expect(m, `${selector} must be defined`).toBeTruthy();
      return m![1];
    };
    expect(rule('.modal-meta-link')).toContain('var(--text-secondary)');
    const hover = rule('.modal-meta-link:hover');
    expect(hover).toContain('var(--text-primary)');
    expect(hover).toContain('var(--bg-acrylic-hover)');
    expect(rule('.modal-meta-link:focus-visible')).toContain('var(--border-highlight)');
    const metaBlocks = modalCss.match(/\.modal-meta-link[^{]*\{[^}]*\}/g) ?? [];
    expect(metaBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of metaBlocks) expect(block).not.toContain('--brand-primary');
  });

  it('does not override .btn-icon-only padding in modal install-action-buttons', () => {
    expect(modalCss).not.toMatch(/\.install-action-buttons\s+\.btn-fluent\s*\{/);
    expect(modalCss).toMatch(/\.modal-header-btn\.modal-close-btn\s*\{[^}]*position:\s*relative;/s);
  });
});

describe('Solid platform & forge icon optical scaling', () => {
  it('applies optical scaling class and SVG transform to solid brand glyphs', () => {
    const { container } = render(
      <div>
        <PlatformIcon platform="windows" size={16} />
        <PlatformIcon platform="macos" size={16} />
        <PlatformIcon platform="linux" size={16} />
        <ForgeIcon forge="github" size={14} />
        <ForgeIcon forge="gitlab" size={14} />
        <ForgeIcon forge="codeberg" size={14} />
      </div>,
    );
    const solidSvgs = container.querySelectorAll('svg.icon-solid-optical');
    expect(solidSvgs.length).toBe(5);
    solidSvgs.forEach((svg) => {
      const g = svg.querySelector('g[transform]');
      expect(g?.getAttribute('transform')).toContain('scale(0.86)');
    });
  });
});

describe('Component sibling button parity', () => {
  it('AppCard footer action buttons align on 28px tier with no inline padding/height overrides', () => {
    const { getByTestId, container } = render(
      <AppCard
        app={SAMPLE_APP}
        isInstalled={false}
        isManaged={false}
        platformLoading={false}
        onOpenDetail={() => {}}
        onQuickInstall={() => {}}
        onMoveInApp={() => {}}
        showLoadDetail={true}
        onLoadDetail={() => {}}
      />,
    );
    const moveIn = getByTestId('move-in-acme/tool');
    const loadDetail = getByTestId('load-detail-acme/tool');
    const installBtn = container.querySelector('.btn-install') as HTMLElement;
    expect(moveIn.className).toContain('btn-compact');
    expect(loadDetail.className).toContain('btn-compact');
    expect(installBtn).toBeTruthy();
    expect(moveIn.style.padding).toBe('');
    expect(moveIn.style.height).toBe('');
    expect(loadDetail.style.padding).toBe('');
    expect(loadDetail.style.height).toBe('');
  });

  it('InlineConfirmButton supports typed size prop and propagates to cancel button', () => {
    const { container, getByText } = render(
      <InlineConfirmButton
        variant="danger"
        confirmVariant="danger"
        confirmText="确认"
        cancelTitle="取消"
        size="compact"
        onConfirm={() => {}}
      >
        卸载
      </InlineConfirmButton>,
    );
    const initialBtn = getByText('卸载').closest('button') as HTMLElement;
    expect(initialBtn.className).toContain('btn-compact');
    fireEvent.click(initialBtn);
    const cancelBtn = container.querySelector('button.btn-icon-only') as HTMLElement;
    expect(cancelBtn.className).toContain('btn-compact');
  });

  it('InlineConfirmButton renders btn-danger and matching size modifier on cancel icon button', () => {
    const { container, getByText } = render(
      <InlineConfirmButton
        variant="danger"
        confirmVariant="danger"
        confirmText="确认"
        cancelTitle="取消"
        className="btn-compact"
        onConfirm={() => {}}
      >
        卸载
      </InlineConfirmButton>,
    );
    const initialBtn = getByText('卸载').closest('button') as HTMLElement;
    expect(initialBtn.className).toContain('btn-danger');
    expect(initialBtn.className).toContain('btn-compact');

    fireEvent.click(initialBtn);
    const confirmBtn = getByText('确认').closest('button') as HTMLElement;
    const cancelBtn = container.querySelector('button.btn-icon-only') as HTMLElement;
    expect(confirmBtn.className).toContain('btn-danger-solid');
    expect(confirmBtn.className).toContain('btn-compact');
    expect(cancelBtn.className).toContain('btn-compact');
    expect(cancelBtn.style.width).toBe('');
    expect(cancelBtn.style.height).toBe('');
  });

  it('InstalledView updatable row & watch panel buttons align on 28px tier alongside manage-btn-action', () => {
    const installed: InstalledApp[] = [
      {
        app_id: 'acme/tool',
        app_name: 'Acme Tool',
        version: '1.0.0',
        installed_at: 1700000000,
        install_method: 'msi',
        install_path: 'C:\\Acme',
        asset_name: 'acme.msi',
        asset_sha256: 'abc',
      },
    ];
    const updates: UpdateItem[] = [
      {
        app_id: 'acme/tool',
        app_name: 'Acme Tool',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        changelog: 'fix',
      },
    ];
    const { container } = render(
      <>
        <InstalledView
          installedApps={installed}
          updates={updates}
          apps={[SAMPLE_APP]}
          onApplyUpdate={async () => {}}
          onLaunch={() => {}}
          onUninstall={() => {}}
        />
        <WatchReleasesPanel
          notifications={[{ app_id: 'acme/tool', app_name: 'Acme Tool', version: '1.1.0' }]}
          apps={[SAMPLE_APP]}
          onOpenDetail={() => {}}
          onDismiss={() => {}}
        />
      </>,
    );
    // 关注「知道了」为 btn-compact；更新 / 查看为 28px 的 manage-btn-action；
    // 更新日志开关与更多菜单为 28px 的 manage-btn-icon
    const rowCompactBtns = container.querySelectorAll('.manage-row-actions button.btn-compact');
    expect(rowCompactBtns.length).toBe(1);
    expect(container.querySelectorAll('.manage-row-actions button.manage-btn-action').length).toBe(2);
    expect(container.querySelectorAll('.manage-row-actions button.manage-btn-icon').length).toBe(2);
  });

  it('InstalledView sort button uses btn-compact (28px) matching search box', () => {
    const installed: InstalledApp[] = [
      {
        app_id: 'acme/tool',
        app_name: 'Acme Tool',
        version: '1.0.0',
        installed_at: 1700000000,
        install_method: 'msi',
        install_path: 'C:\\Acme',
        asset_name: 'acme.msi',
        asset_sha256: 'abc',
      },
    ];
    const { container } = render(
      <InstalledView installedApps={installed} onLaunch={() => {}} onUninstall={() => {}} />,
    );
    const sortBtn = container.querySelector('.manage-controls-right button');
    expect(sortBtn?.className).toContain('btn-compact');
  });

  it('RulesManagerModal header add button uses btn-compact matching 28px close button', () => {
    const { container } = render(
      <RulesManagerModal
        isOpen={true}
        onClose={() => {}}
        updateRules={[]}
        onClearRuleSkip={async () => {}}
        onToggleRuleFrozen={async () => {}}
        onToggleRuleHidden={async () => {}}
      />,
    );
    const headerBtns = container.querySelectorAll('.modal-header button');
    expect(headerBtns.length).toBe(2);
    expect(headerBtns[0].className).toContain('btn-compact');
    expect(headerBtns[1].className).toContain('modal-header-btn');
    expect(headerBtns[1].className).toContain('modal-close-btn');
  });

  it('DeveloperProfileModal repo row buttons unify on 28px btn-compact without inline sizing overrides', async () => {
    const { container } = render(
      <DeveloperProfileModal
        developer="acme"
        isOpen={true}
        onClose={() => {}}
        onOpenAppDetail={() => {}}
        onInstallApp={async () => {}}
        installedIds={new Set()}
        managedIds={new Set()}
      />,
    );
    await waitFor(() => {
      const compactControls = container.querySelectorAll('.modal-body .btn-fluent.btn-compact');
      expect(compactControls.length).toBe(4);
    });
    container.querySelectorAll('.modal-body .btn-fluent.btn-compact').forEach((el) => {
      const htmlEl = el as HTMLElement;
      expect(htmlEl.style.padding).toBe('');
      expect(htmlEl.style.height).toBe('');
    });
  });

  it('AppDetailModal aligns header buttons, InstallActions inline confirm, and AssetList row buttons', async () => {
    const detailApp: AppDetailViewModel = {
      ...SAMPLE_APP,
      changelog: 'Initial release',
      readme_markdown: '# Acme Tool',
      releases: [
        {
          name: 'acme-setup.msi',
          size_bytes: 1024,
          download_url: 'https://example.com/acme.msi',
          sha256: 'deadbeef12345678',
          os: 'windows',
          arch: 'x64',
          kind: 'msi',
        },
        {
          name: 'acme-portable.zip',
          size_bytes: 2048,
          download_url: 'https://example.com/acme.zip',
          sha256: 'cafebabe12345678',
          os: 'windows',
          arch: 'x64',
          kind: 'zip',
        },
      ],
      isLoading: false,
    };

    const { container } = render(
      <AppDetailModal
        app={detailApp}
        isInstalled={true}
        isManaged={true}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onUninstall={async () => {}}
        onLaunch={() => {}}
        onToggleFavorite={() => {}}
        onToggleWatch={() => {}}
      />,
    );

    const headerActionBtns = container.querySelectorAll('.modal-actions-header button.modal-header-btn');
    expect(headerActionBtns.length).toBeGreaterThanOrEqual(3);
    const closeBtn = container.querySelector('.modal-actions-header button.modal-close-btn') as HTMLElement;
    expect(closeBtn.style.position).toBe('');

    const installBtns = container.querySelectorAll('.install-action-buttons button.btn-fluent');
    expect(installBtns.length).toBeGreaterThanOrEqual(2);
    // 展开全部资产列表并验证资产行双按钮同为 28px btn-compact
    fireEvent.click(installBtns[0]);
    const assetBtns = container.querySelectorAll('.detail-asset-btn.btn-fluent.btn-compact');
    expect(assetBtns.length).toBe(4);

    const uninstallBtn = container.querySelector('.install-action-buttons button.btn-danger') as HTMLElement;
    expect(uninstallBtn).toBeTruthy();
    fireEvent.click(uninstallBtn);
    const cancelBtn = container.querySelector('.install-action-buttons button.btn-icon-only') as HTMLElement;
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn.style.width).toBe('');
    expect(cancelBtn.style.padding).toBe('');
  });

  it('AppDetailModal repo meta links and developer button carry no inline brand color', () => {
    const { container } = render(
      <AppDetailModal
        app={{
          ...SAMPLE_APP,
          homepage: 'https://acme.example.com',
          changelog: '',
          readme_markdown: '',
          releases: [],
          isLoading: false,
        }}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
        onOpenDeveloperProfile={() => {}}
      />,
    );
    const repoBar = container.querySelector('.modal-app-repo') as HTMLElement;
    expect(repoBar).toBeTruthy();
    expect(repoBar.getAttribute('style')).toBeNull();
    const links = repoBar.querySelectorAll('a');
    // 仓库 + 问题反馈；官方主页在标签栏
    expect(links.length).toBe(2);
    for (const a of links) {
      expect(a.classList.contains('modal-meta-link')).toBe(true);
      expect(a.getAttribute('style') ?? '').not.toContain('--brand-primary');
    }
    const homepageTag = container.querySelector('.modal-tags .modal-homepage-tag') as HTMLElement;
    expect(homepageTag).toBeTruthy();
    expect(homepageTag.getAttribute('style') ?? '').not.toContain('--brand-primary');
    const devBtn = repoBar.querySelector('button') as HTMLElement;
    expect(devBtn).toBeTruthy();
    expect(devBtn.getAttribute('style') ?? '').not.toContain('--brand-primary');
  });
});
