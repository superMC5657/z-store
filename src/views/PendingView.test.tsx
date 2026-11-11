import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '../i18n';
import {
  PENDING_EMPTY_DRAFT,
  PENDING_OFFICIAL_CATEGORIES,
  canonicalDraftId,
  isOsiApprovedLicense,
  normalizeLicense,
  pendingDraftToAppSummary,
  resolvePendingDraftDescription,
  validatePendingDraft,
  type CustomDraftEntry,
} from './pending/draftModel';
import { PendingView } from './PendingView';
import type { LicenseAllowlistResult } from '../services/api/catalog';
import {
  PENDING_SECTION_PREFS_STORAGE_KEY,
  PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY,
  getPendingSectionPrefs,
} from '../lib/pendingPrefs';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

function draftEntry(partial: Partial<CustomDraftEntry> & { id: string }): CustomDraftEntry {
  return {
    item: {
      ...PENDING_EMPTY_DRAFT,
      id: partial.id,
      name: 'Demo',
      owner: 'o',
      repo: partial.id.split('/')[1] ?? 'r',
      description: 'demo',
      category: 'dev',
      homepage: 'https://example.com',
      license: 'MIT',
    },
    status: 'draft',
    pr_url: null,
    archived: false,
    ...partial,
  };
}

describe('PendingView validation (backend validate_custom_item UI mirror)', () => {
  // ADR-0018：名单唯一源头为后端；单测以快照形态显式传入，不依赖硬编码。
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'GPL-3.0+', 'MPL-2.0', 'Unlicense'],
  };

  it('accepts a canonical draft in submit mode with the backend allowlist', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'MIT' };
    expect(validatePendingDraft(item, 'submit', gate)).toEqual({});
  });

  it('category whitelist parity with backend (submit rejects unknown, allows official 10)', () => {
    const base = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', homepage: 'https://example.com', license: 'MIT' };

    // draft 档放行任意分类
    expect(validatePendingDraft({ ...base, category: 'arbitrary_custom' }, 'draft').category).toBeUndefined();

    // submit 档拒绝非官方分类
    expect(validatePendingDraft({ ...base, category: 'arbitrary_custom' }, 'submit', gate).category).toBe('category_invalid');
    expect(validatePendingDraft({ ...base, category: '' }, 'submit', gate).category).toBe('category_required');

    // 10 个官方分类在 submit 档均通过
    for (const cat of PENDING_OFFICIAL_CATEGORIES) {
      expect(validatePendingDraft({ ...base, category: cat }, 'submit', gate).category).toBeUndefined();
    }
  });

  it('draft mode only checks identity (backend DraftLenient mirror)', () => {
    // 占位 license / 空 homepage / 不完整字段暂存放行，身份不错即过。
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: '', owner: 'o', repo: 'r', description: '', category: '', homepage: '', license: 'OpenSource' };
    expect(validatePendingDraft(item, 'draft')).toEqual({});
    // 身份错误两档同拦。
    const badId = { ...item, id: 'o/other' };
    expect(validatePendingDraft(badId, 'draft').id).toBe('id_mismatch');
    expect(validatePendingDraft(badId, 'submit', gate).id).toBe('id_mismatch');
  });

  it('rejects mismatched id (must equal lower owner/repo)', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/other', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'MIT' };
    expect(validatePendingDraft(item, 'submit', gate).id).toBe('id_mismatch');
  });

  it('rejects non-http homepage', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'example.com/no-scheme', license: 'MIT' };
    expect(validatePendingDraft(item, 'submit', gate).homepage).toBe('homepage_scheme');
  });

  it('rejects non-allowlist license in submit mode (D1)', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'CC-BY-4.0' };
    expect(validatePendingDraft(item, 'submit', gate).license).toBe('license_osi');
    expect(isOsiApprovedLicense('MIT', gate)).toBe(true);
    expect(isOsiApprovedLicense('mit', gate)).toBe(true);
    expect(isOsiApprovedLicense('gpl-3.0+', gate)).toBe(true);
    expect(isOsiApprovedLicense('CC-BY-4.0', gate)).toBe(false);
  });

  it('submit mode normalizes both sides before comparing', () => {
    expect(normalizeLicense('gpl-3.0+')).toBe('GPL-3.0-OR-LATER');
    expect(isOsiApprovedLicense('apache 2.0', gate)).toBe(true);
  });

  it('submit mode without a gate fails closed (never falls back to a baked-in list)', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'MIT' };
    expect(validatePendingDraft(item, 'submit').license).toBe('license_gate_unavailable');
    expect(validatePendingDraft(item, 'submit', null).license).toBe('license_gate_unavailable');
    expect(isOsiApprovedLicense('MIT', null)).toBe(false);
    expect(isOsiApprovedLicense('MIT', undefined)).toBe(false);
  });

  it('disabled gate permits any non-empty license (backend mirror)', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'OpenSource' };
    expect(validatePendingDraft(item, 'submit', { enabled: false, allowed: [] }).license).toBeUndefined();
    const empty = { ...item, license: '  ' };
    expect(validatePendingDraft(empty, 'submit', { enabled: false, allowed: [] }).license).toBe('license_required');
  });

  it('canonicalDraftId lowercases owner/repo', () => {
    expect(canonicalDraftId('O', 'R')).toBe('o/r');
  });
});

describe('PendingView grouping and empty states', () => {
  it('renders empty state with create action when no drafts', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView />);
    expect(screen.getByText('暂无待收录草稿')).toBeTruthy();
    // 新建入口置于空态提示，页头不包含新建入口
    expect(container.querySelector('.pending-header')?.textContent).not.toContain('新建草稿');
    expect(screen.getByText('新建草稿')).toBeTruthy();
  });

  it('groups drafts into 3 tabs and shows pr_url in the library pending-merge segment', async () => {
    await i18n.changeLanguage('zh-CN');
    const entries = [
      draftEntry({ id: 'o/a' }),
      draftEntry({ id: 'o/col', status: 'collected' }),
      draftEntry({ id: 'o/lc', status: 'local_collected' }),
      draftEntry({ id: 'o/b', status: 'submitted', pr_url: 'https://github.com/x/y/pull/1' }),
      draftEntry({ id: 'o/c', archived: true }),
    ];
    const { container } = render(<PendingView initialEntries={entries} />);
    // 三态分组：草稿 / 本地收录 / 已归档；Issue 进度降为本地收录内部分段
    expect(container.querySelector('.pending-header .nav-badge')).toBeNull();
    expect(screen.getByText('草稿')).toBeTruthy();
    expect(screen.getByText('本地收录')).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();
    expect(screen.queryByText('已提交')).toBeNull();
    // Tab 计数按分区：1 草稿 + 3 本地收录（collected/local_collected/submitted）+ 1 归档
    const counts = Array.from(container.querySelectorAll('.segmented-count')).map((el) => el.textContent ?? '');
    expect(counts).toEqual(['(1)', '(3)', '(1)']);
    // tab 顺序：草稿 → 本地收录 → 已归档；分段不占顶层 Tab
    const tabs = Array.from(container.querySelectorAll('.segmented-item')).map((el) =>
      el.textContent ?? '',
    );
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toContain('草稿 (1)');
    expect(tabs[1]).toContain('本地收录 (3)');
    expect(tabs[2]).toContain('已归档 (1)');
    // 默认草稿分组仅见 o/a
    const listText = () => container.querySelector('.pending-list')?.textContent ?? '';
    expect(listText()).toContain('o/a');
    expect(listText()).not.toContain('o/col');
    // 本地收录默认「待提交」：仅 collected 系同列
    fireEvent.click(screen.getByText('本地收录'));
    expect(listText()).toContain('o/col');
    expect(listText()).toContain('o/lc');
    expect(listText()).not.toContain('o/b');
    expect(listText()).not.toContain('o/a');
    expect(screen.queryByTestId('pending-segment-all')).toBeNull();
    expect(screen.getByTestId('pending-segment-to_submit')).toBeTruthy();
    expect(screen.getByTestId('pending-segment-submitted')).toBeTruthy();
    expect(screen.getByTestId('pending-segment-to_submit').textContent).toBe('待提交 (2)');
    expect(screen.getByTestId('pending-segment-submitted').textContent).toBe('已提交 (1)');
    // 选中已收录行：编辑头显已收录徽标，收录按钮隐藏（仅 draft 显示）
    fireEvent.click(screen.getByText('o/col'));
    expect(screen.getAllByText('本地收录').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    // 已提交分段仅见 submitted，Issue 链接可见
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    expect(listText()).toContain('o/b');
    expect(listText()).not.toContain('o/col');
    expect(listText()).not.toContain('o/lc');
    expect(screen.getByText('https://github.com/x/y/pull/1')).toBeTruthy();
    // 待提交分段仅见 collected 系
    fireEvent.click(screen.getByTestId('pending-segment-to_submit'));
    expect(listText()).toContain('o/col');
    expect(listText()).toContain('o/lc');
    expect(listText()).not.toContain('o/b');
    // 切换到已归档分组（分段控件不展）
    fireEvent.click(screen.getByText('已归档'));
    expect(listText()).toContain('o/c');
    expect(screen.queryByTestId('pending-segment-to_submit')).toBeNull();
    expect(screen.queryByTestId('pending-segment-submitted')).toBeNull();
  });

  it('switches title between Chinese and English', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(<PendingView />);
    expect(screen.getByText('待收录')).toBeTruthy();
    unmount();
    await i18n.changeLanguage('en-US');
    render(<PendingView />);
    expect(screen.getByText('Pending')).toBeTruthy();
  });
});

describe('Sidebar pending nav (discovery group + badge slot)', () => {  it('renders pending item and marks it active', async () => {
    const { Sidebar } = await import('../components/Sidebar');
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <Sidebar
        currentView="pending"
        onSelectView={() => {}}
        installedCount={0}
        onOpenAccount={() => {}}
        pendingCount={2}
      />,
    );
    expect(screen.getByText('待收录')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    const active = container.querySelector('.nav-item.active');
    expect(active?.textContent).toContain('待收录');
  });
});

describe('PendingView 表单窄宽布局回归（只锁布局，不碰字段/校验/提交）', () => {
  it('左右分栏走 CSS 类（无内联双列），中小宽度由样式表堆叠', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView initialEntries={[draftEntry({ id: 'o/a' })]} />);
    const layout = container.querySelector('.pending-layout') as HTMLElement | null;
    expect(layout).toBeTruthy();
    // 分栏列定义在样式表，行内不留 grid-template-columns。
    expect(layout?.style.gridTemplateColumns).toBe('');
    // 子栏可收缩（min-width:0 经样式表 .pending-layout > * 落定）。
    const css = readPendingCss();
    expect(css).toContain('.pending-layout > *');
    expect(css).toContain('min-width: 0');
    expect(css).toContain('@media');
    expect(css).toContain('overflow-x: hidden');
  });

  it('无多列网格残留：行容器拆除，每字段独占一整行', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView initialEntries={[draftEntry({ id: 'o/a' })]} />);
    fireEvent.click(screen.getByText('o/a'));
    const card = container.querySelector('.pending-editor-card') as HTMLElement | null;
    expect(card).toBeTruthy();
    // 行分组容器彻底拆除（DOM 与样式表均无残留）。
    expect(card?.querySelectorAll('.pending-form-row')).toHaveLength(0);
    const css = readPendingCss();
    expect(css).not.toContain('pending-form-row');
    expect(css).not.toContain('auto-fit');
    expect(css).not.toContain('1fr 1fr');
    // 每字段 label 均为卡片直属子项 → 纵向堆叠、各占一整行。
    const allLabels = card?.querySelectorAll('label') ?? [];
    const directLabels = card?.querySelectorAll(':scope > label') ?? [];
    expect(allLabels.length).toBeGreaterThan(0);
    expect(directLabels.length).toBe(allLabels.length);
    // 字段 label 无横向行内布局（grid 多列 / flex-row 一律不得出现）。
    for (const el of Array.from(allLabels)) {
      const st = (el as HTMLElement).style;
      expect(st.display).not.toBe('grid');
      expect(st.flexDirection).not.toBe('row');
      expect(st.gridTemplateColumns).toBe('');
    }
    // 控件满宽与主题兼容规则仍在（label 在上、输入框在下占满宽，背景/边框/文字走 token）。
    expect(css).toContain('.pending-view .input-fluent');
    expect(css).toContain('width: 100%');
    expect(css).toContain('background: var(--bg-input)');
    expect(css).toContain('border: 1px solid var(--border-color)');
    expect(css).toContain('color: var(--text-primary)');
    expect(css).toContain('.pending-view .select-fluent');
    expect(css).toContain('var(--bg-acrylic-card');
  });

  it('renders category as a styled select-fluent dropdown with 10 official categories and auto-fills category_name', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView initialEntries={[draftEntry({ id: 'o/a' })]} />);
    fireEvent.click(screen.getByText('o/a'));

    const select = screen.getByTestId('pending-select-category') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toContain('select-fluent');

    // 校验选项严格限定在 10 个官方分类
    const options = Array.from(select.querySelectorAll('option')).filter((o) => !o.disabled);
    expect(options.map((o) => o.value)).toEqual([
      'system',
      'network',
      'media',
      'security',
      'dev',
      'graphics',
      'office',
      'reading',
      'ops',
      'games',
    ]);

    // 选择某个分类，自动联动填充 category_name
    fireEvent.change(select, { target: { value: 'system' } });
    expect(select.value).toBe('system');
    // 明确断言：category_name 被真实自动填充为本地化文本（系统实用）
    const categoryNameInput = screen.getByPlaceholderText('例如：开发工具') as HTMLInputElement;
    expect(categoryNameInput.value).toBe('系统实用');
  });

  it('components-pending.css and tokens.css provide theme-adapted styles for select-fluent', () => {
    const css = readPendingCss();
    expect(css).toContain('.pending-view .select-fluent');
    expect(css).toContain('.pending-view .select-fluent option');
    expect(css).toContain('var(--bg-acrylic-card)');
    expect(css).toContain('var(--bg-input)');
  });

  it('长 id 标题省略 + title 悬浮看全', async () => {
    await i18n.changeLanguage('zh-CN');
    const longId = 'verylongownername/verylongreponame-0123456789abcdef';
    const { container } = render(<PendingView initialEntries={[draftEntry({ id: longId })]} />);
    fireEvent.click(screen.getByText(longId));
    const title = container.querySelector('.pending-editor-title') as HTMLElement | null;
    expect(title).toBeTruthy();
    expect(title?.getAttribute('title')).toBe(longId);
    // 省略样式走样式表类（jsdom 下 CSS 不参与计算，只锁类名 + 规则文本）。
    expect(title?.classList.contains('pending-editor-title')).toBe(true);
    const css = readPendingCss();
    expect(css).toContain('.pending-editor-title');
    expect(css).toContain('text-overflow: ellipsis');
  });
});

describe('PendingView 草稿字段可改性与锁定规则（Oracle 定稿落实）', () => {
  it('编辑已有草稿不展示只读仓库坐标区，标题保留 id，直入基本信息编辑', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <PendingView
        initialEntries={[
          {
            id: 'owner1/repo1',
            status: 'draft',
            pr_url: null,
            archived: false,
            item: {
              ...PENDING_EMPTY_DRAFT,
              id: 'owner1/repo1',
              name: 'Demo',
              owner: 'owner1',
              repo: 'repo1',
              description: 'demo',
              category: 'dev',
              homepage: 'https://example.com',
              license: 'MIT',
            },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByText('owner1/repo1'));

    // 编辑态仅在顶部标题展示坐标，表单直接从基本信息开始
    expect(screen.queryByDisplayValue('owner1')).toBeNull();
    expect(screen.queryByDisplayValue('repo1')).toBeNull();
    expect(screen.queryByTestId('pending-copy-id')).toBeNull();
    expect(screen.queryByTestId('pending-duplicate')).toBeNull();
    expect(screen.queryByTestId('pending-toggle-coords')).toBeNull();
    expect(screen.queryByText('仓库与标识')).toBeNull();

    // 卡片顶部标题保留完整 owner/repo，基本信息可直接编辑
    expect(container.querySelector('.pending-editor-title')?.textContent).toBe('owner1/repo1');
    expect(screen.getByDisplayValue('Demo')).toBeTruthy();
  });

  it('archived 行点击“复制为新草稿”切到新建态（owner/repo 可改，原条目保留）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();

    render(
      <PendingView
        initialEntries={[
          {
            id: 'owner1/repo1',
            status: 'draft',
            pr_url: null,
            archived: true,
            item: {
              ...PENDING_EMPTY_DRAFT,
              id: 'owner1/repo1',
              name: 'Demo',
              owner: 'owner1',
              repo: 'repo1',
              description: 'demo',
              category: 'dev',
              homepage: 'https://example.com',
              license: 'MIT',
            },
          },
        ]}
        onNotify={onNotify}
      />,
    );
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('owner1/repo1'));

    const dupBtn = screen.getByTestId('pending-duplicate');
    expect(dupBtn).toBeTruthy();
    fireEvent.click(dupBtn);

    // 切到新建态：owner 与 repo 输入框可编辑，不暴露应用标识 id 输入框
    const ownerInput = screen.getByDisplayValue('owner1') as HTMLInputElement;
    const repoInput = screen.getByDisplayValue('repo1') as HTMLInputElement;
    expect(ownerInput.readOnly).toBe(false);
    expect(repoInput.readOnly).toBe(false);
    expect(screen.queryByTestId('pending-id-input')).toBeNull();

    // 修改仓库坐标并保存新草稿（id 自动按小写 owner/repo 生成）
    fireEvent.change(ownerInput, { target: { value: 'Owner2' } });
    fireEvent.change(repoInput, { target: { value: 'Repo2' } });
    fireEvent.click(screen.getByText('保存草稿'));

    // 确认生成了新条目 owner2/repo2
    expect(screen.getAllByText('owner2/repo2').length).toBeGreaterThanOrEqual(1);
  });

  it('archived 行富卡只读、无表单，仅留“复制为新草稿”可用', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'arch/one', archived: true })]}
      />,
    );
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('arch/one'));

    // 后链路一律富卡：无新建式表单页，不展保存/输入
    expect(screen.queryByText('保存草稿')).toBeNull();
    expect(screen.queryByDisplayValue('Demo')).toBeNull();
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    // 富卡复用黄标 + 已归档徽标
    expect(document.querySelector('.app-card .verified-badge-local')).toBeTruthy();
    expect(screen.getByText('已转正归档')).toBeTruthy();
    // 无收录/提交/退回
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
    // 仍提供“复制为新草稿”
    const dupBtn = screen.getByTestId('pending-duplicate');
    expect(dupBtn).toBeTruthy();
  });

  it('新建态展示 owner/repo 坐标输入，编辑态自动收起坐标区且标题保留 id', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'owner1/repo1' })]}
      />,
    );
    fireEvent.click(screen.getByText('owner1/repo1'));

    // 编辑态不渲染坐标节，编辑器标题保留 owner1/repo1
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    expect(container.querySelector('.pending-editor-title')?.textContent).toBe('owner1/repo1');

    // 重新切到新建态：切 Tab 回草稿经右侧空态进入新建，此时展示 owner/repo 两个输入框
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('草稿'));
    fireEvent.click(screen.getByText('新建草稿'));
    expect(screen.getAllByPlaceholderText('rustdesk')).toHaveLength(2);
    expect(screen.queryByTestId('pending-id-input')).toBeNull();
  });
});

describe('PendingView 回归（自动派生 canonical id + duplicate 警告 + 旧 key 迁移）', () => {
  it('新建态输入大写 owner/repo 自动按小写 owner/repo 派生 id 并保存', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView />);
    fireEvent.click(screen.getByText('新建草稿'));
    const [ownerInput, repoInput] = screen.getAllByPlaceholderText('rustdesk') as HTMLInputElement[];
    fireEvent.change(ownerInput, { target: { value: 'OwnerA' } });
    fireEvent.change(repoInput, { target: { value: 'RepoB' } });
    expect(screen.queryByTestId('pending-id-input')).toBeNull();
    fireEvent.click(screen.getByText('保存草稿'));
    expect(screen.getAllByText('ownera/repob').length).toBeGreaterThanOrEqual(1);
  });

  it('新建草稿保存已存在 id 时出 warning 且不建第二条', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        onNotify={onNotify}
      />,
    );
    fireEvent.click(screen.getByText('新建草稿'));
    const [ownerInput, repoInput] = screen.getAllByPlaceholderText('rustdesk') as HTMLInputElement[];
    fireEvent.change(ownerInput, { target: { value: 'o' } });
    fireEvent.change(repoInput, { target: { value: 'a' } });
    fireEvent.click(screen.getByText('保存草稿'));
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/a'), 'warning');
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('草稿已保存'), 'success');
  });

  it('旧 storage key 兼容迁移读（sectionPrefs）', async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.removeItem(PENDING_SECTION_PREFS_STORAGE_KEY);
    window.localStorage.removeItem(PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY);
    window.localStorage.setItem(
      PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY,
      JSON.stringify({ optional: false, runtime: true }),
    );
    // sectionPrefs 兼容迁移：optional 别名字段吸收为 supplemental，并写标准 key
    expect(getPendingSectionPrefs()).toEqual({ supplemental: false, runtime: true });
    expect(window.localStorage.getItem(PENDING_SECTION_PREFS_STORAGE_KEY)).toContain('supplemental');
    window.localStorage.removeItem(PENDING_SECTION_PREFS_STORAGE_KEY);
    window.localStorage.removeItem(PENDING_SECTION_PREFS_STORAGE_KEY_LEGACY);
  });
});

describe('PendingView 逐框内联校验（submit 档即时标错，不 toast）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  it('清空必填即内联且收录仍可点击（title 复用 fix_errors，点击定位首错）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const onCollectLocal = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        onNotify={onNotify}
        onCollectLocal={onCollectLocal}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    const collectBtn = screen.getByTestId('pending-collect-local') as HTMLButtonElement;
    // 有效态可用
    await waitFor(() => expect(collectBtn.disabled).toBe(false));
    const nameInput = screen.getByDisplayValue('Demo') as HTMLInputElement;
    // onChange 即时校验：清空即标错（不新增文案，复用 pending.errors.*）
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(screen.getByTestId('pending-error-name')).toBeTruthy();
    expect(screen.getByText('应用名称不可为空')).toBeTruthy();
    // 缺项仍可点击，title 复用 fix_errors
    await waitFor(() => expect(collectBtn.disabled).toBe(false));
    expect(collectBtn.title).toContain('表单尚有未通过');
    // 点击不调后端：置内联 + 定位首错，不 toast
    fireEvent.click(collectBtn);
    await waitFor(() => expect(screen.getByTestId('pending-error-name')).toBeTruthy());
    expect(onCollectLocal).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('表单尚有未通过'),
      'warning',
    );
    // 失焦同样内联
    fireEvent.blur(nameInput);
    expect(screen.getByText('应用名称不可为空')).toBeTruthy();
  });

  it('collected 富卡化：只展 AppCard 黄标无参数表单，提交仍可点（title 复用 license_fix_hint）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue('https://example.com/pr');
    const placeholder = draftEntry({ id: 'o/a', status: 'collected' });
    placeholder.item.license = 'OpenSource';
    render(
      <PendingView
        initialEntries={[placeholder]}
        onNotify={onNotify}
        onGetPrUrl={onGetPrUrl}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    // 富卡分支：复用 AppCard（黄标 local），不展示 owner/repo 参数表单
    expect(document.querySelector('.app-card .verified-badge-local')).toBeTruthy();
    expect(screen.queryByDisplayValue('MIT')).toBeNull();
    expect(screen.queryByDisplayValue('OpenSource')).toBeNull();
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    expect(screen.queryByTestId('pending-copy-id')).toBeNull();
    const submitBtn = screen.getByTestId('pending-submit-pr') as HTMLButtonElement;
    await waitFor(() => expect(submitBtn.disabled).toBe(false));
    // 占位协议即内联 osi（富卡内联与表单同 testid 口径）
    await waitFor(() => expect(screen.getByTestId('pending-error-license')).toBeTruthy());
    expect(screen.getByText('仅收录 OSI 认证开源协议')).toBeTruthy();
    // 缺项仍可点击，title 复用 license_fix_hint
    expect(submitBtn.title).toContain('SPDX');
    fireEvent.click(submitBtn);
    await waitFor(() => expect(screen.getByTestId('pending-error-license')).toBeTruthy());
    expect(onGetPrUrl).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('SPDX'),
      'warning',
    );
    // 退回后停留本地收录：选中清空回空态，不跳 Tab；切回草稿才见表单可改协议（富卡锁定，改项走退回链路）
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    await waitFor(() => expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull());
    expect(screen.getByText('选择或新建草稿')).toBeTruthy();
    fireEvent.click(screen.getByText('草稿'));
    fireEvent.click(screen.getByText('o/a'));
    await waitFor(() => expect(screen.getByDisplayValue('OpenSource')).toBeTruthy());
  });

  it('gate 未就绪时 license 暂不标错（快照口径，不每键 IPC）', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView initialEntries={[draftEntry({ id: 'o/a' })]} />,
    );
    fireEvent.click(screen.getByText('o/a'));
    // 故意不传 onGetLicenseAllowlist：非 Tauri 单测默认拉取失败，快照为空按 disabled 口径
    const licenseInput = screen.getByDisplayValue('MIT') as HTMLInputElement;
    fireEvent.change(licenseInput, { target: { value: 'OpenSource' } });
    fireEvent.blur(licenseInput);
    // 未就绪不标 osi/gate_unavailable（仍保留 required 由空值覆盖，见 disabled gate 单测）
    expect(screen.queryByText('仅收录 OSI 认证开源协议')).toBeNull();
    expect(screen.queryByText('协议名单尚未加载，请稍后重试')).toBeNull();
  });
});

describe('PendingView 顶层三态切 Tab 联动（右侧详情/批量栏/操作按钮随 activeGroup 切换）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  function fourStateEntries(): CustomDraftEntry[] {
    return [
      draftEntry({ id: 'o/draft' }),
      draftEntry({ id: 'o/col', status: 'collected' }),
      draftEntry({ id: 'o/sub', status: 'submitted', pr_url: 'https://github.com/x/y/pull/9' }),
      draftEntry({ id: 'o/arch', archived: true }),
    ];
  }

  it('draft=表单+收录主按钮（页头无新建入口、无计数徽标）', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView initialEntries={fourStateEntries()} onGetLicenseAllowlist={gateProvider} />);
    // 页头无新建入口、无计数徽标
    expect(container.querySelector('.pending-header')?.textContent).not.toContain('新建草稿');
    expect(container.querySelector('.pending-header .nav-badge')).toBeNull();
    // Tab 自带草稿/收录计数保留
    expect(container.querySelector('.segmented-group')?.textContent).toContain('草稿');
    expect(container.querySelectorAll('.segmented-count')).toHaveLength(3);
    fireEvent.click(screen.getByText('o/draft'));
    // 表单态：保存草稿 + 收录主按钮，无提交 Issue，无富卡黄标
    expect(screen.getByText('保存草稿')).toBeTruthy();
    expect(screen.getByTestId('pending-collect-local')).toBeTruthy();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
    expect(document.querySelector('.pending-editor .verified-badge-local')).toBeNull();
  });

  it('collected=富卡+提交主/退回次', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView initialEntries={fourStateEntries()} onGetLicenseAllowlist={gateProvider} />);
    fireEvent.click(screen.getByText('本地收录'));
    // 点左侧列表项进详情
    const listItem = container.querySelector('.pending-list .pending-list-item') as HTMLElement;
    expect(listItem?.textContent).toContain('o/col');
    fireEvent.click(listItem);
    // 富卡分支：无参数表单 owner/repo 输入，展提交主 + 退回次
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    expect(document.querySelector('.pending-editor .verified-badge-local')).toBeTruthy();
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    expect(screen.getByTestId('pending-revert-to-draft')).toBeTruthy();
    // 富卡态无收录按钮（仅 draft 有）
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
  });

  it('submitted=富卡+PR链接+删除无重复提交', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        initialEntries={fourStateEntries()}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    fireEvent.click(screen.getByText('o/sub'));
    // 列表与详情各展一次 Issue 链接（同文案双节点），断言至少详情区展出
    expect(screen.getAllByText('https://github.com/x/y/pull/9').length).toBeGreaterThanOrEqual(1);
    // 富卡黄标 + 无表单
    expect(document.querySelector('.pending-editor .verified-badge-local')).toBeTruthy();
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    expect(screen.queryByDisplayValue('Demo')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByText('标记已提交')).toBeNull();
    // 已提交允许删除：二次确认复用删除形态（首点确认态，次点执行）
    expect(screen.getByTestId('pending-delete')).toBeTruthy();
    // 未接线撤下回调时不渲染撤下动作（预览/单测安全）
    expect(screen.queryByTestId('pending-withdraw-submitted')).toBeNull();
  });

  it('submitted 删除走二次确认（本地态删后退出选中，列表不再含该行）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const { container } = render(
      <PendingView
        initialEntries={fourStateEntries()}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    fireEvent.click(screen.getByText('o/sub'));
    // 首点仅置确认态，不删行
    fireEvent.click(screen.getByTestId('pending-delete'));
    expect(screen.getByText('再次点击确认删除')).toBeTruthy();
    expect(screen.getAllByText('o/sub').length).toBeGreaterThanOrEqual(1);
    // 次点执行：本地删行 + toast，选中清空回空态
    fireEvent.click(screen.getByTestId('pending-delete'));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/sub'), 'info'),
    );
    expect(container.querySelector('.pending-list')?.textContent ?? '').not.toContain('o/sub');
    expect(screen.queryByText('o/sub')).toBeNull();
    expect(screen.getByText('选择或新建草稿')).toBeTruthy();
  });

  it('submitted 删除受控时委托 onDelete 回调', async () => {
    await i18n.changeLanguage('zh-CN');
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingView
        initialEntries={fourStateEntries()}
        onDelete={onDelete}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    fireEvent.click(screen.getByText('o/sub'));
    fireEvent.click(screen.getByTestId('pending-delete'));
    fireEvent.click(screen.getByTestId('pending-delete'));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('o/sub'));
  });

  it('archived=富卡只读+复制为新草稿，无表单', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView initialEntries={fourStateEntries()} onGetLicenseAllowlist={gateProvider} />);
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('o/arch'));
    // 富卡只读：无表单保存/输入，展黄标 + 已归档徽标 + 复制按钮
    expect(screen.queryByText('保存草稿')).toBeNull();
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    expect(screen.queryByDisplayValue('Demo')).toBeNull();
    expect(document.querySelector('.pending-editor .verified-badge-local')).toBeTruthy();
    expect(screen.getByText('已转正归档')).toBeTruthy();
    expect(screen.getByTestId('pending-duplicate')).toBeTruthy();
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
  });

  it('切 Tab 跨分组选中重置：右侧回空态不展错配控件', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <PendingView
        initialEntries={fourStateEntries()}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 页头无计数徽标、无新建入口
    expect(container.querySelector('.pending-header')?.textContent).not.toContain('新建草稿');
    expect(container.querySelector('.pending-header .nav-badge')).toBeNull();
    fireEvent.click(screen.getByText('o/draft'));
    expect(screen.getByTestId('pending-collect-local')).toBeTruthy();
    // 切到本地收录：旧选中清空，右侧回空态
    fireEvent.click(screen.getByText('本地收录'));
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.getByText('选择或新建草稿')).toBeTruthy();
  });
});

function readPendingCss(): string {
  return readFileSync(join(process.cwd(), 'src', 'styles', 'components-pending.css'), 'utf8');
}

describe('PendingView 3 tabs + 本地收录内部分段（计数分区 / 批量门禁）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  function libraryEntries(): CustomDraftEntry[] {
    return [
      draftEntry({ id: 'o/draft' }),
      draftEntry({ id: 'o/col', status: 'collected' }),
      draftEntry({ id: 'o/lc', status: 'local_collected' }),
      draftEntry({ id: 'o/sub', status: 'submitted', pr_url: 'https://github.com/x/y/pull/9' }),
      draftEntry({ id: 'o/arch', archived: true }),
    ];
  }

  it('tab counts partition every entry (draft + library + archived = total, no double count)', async () => {
    await i18n.changeLanguage('zh-CN');
    const entries = libraryEntries();
    const { container } = render(<PendingView entries={entries} onGetLicenseAllowlist={gateProvider} />);
    const counts = Array.from(container.querySelectorAll('.segmented-count')).map((el) =>
      Number((el.textContent ?? '0').replace(/\D/g, '')),
    );
    expect(counts).toEqual([1, 3, 1]);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(entries.length);
  });

  it('segments filter all / to-submit / pending-merge and reset the detail selection', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <PendingView entries={libraryEntries()} onGetLicenseAllowlist={gateProvider} />,
    );
    const listText = () => container.querySelector('.pending-list')?.textContent ?? '';
    fireEvent.click(screen.getByText('本地收录'));
    // 默认待提交：仅 collected 系
    expect(listText()).toContain('o/col');
    expect(listText()).toContain('o/lc');
    expect(listText()).not.toContain('o/sub');
    // 选中后切已提交分段：选中/表单重置回空态
    fireEvent.click(screen.getByText('o/col'));
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.getByText('选择或新建草稿')).toBeTruthy();
    // 已提交：仅 submitted
    expect(listText()).toContain('o/sub');
    expect(listText()).not.toContain('o/col');
    expect(listText()).not.toContain('o/lc');
    // 切回待提交：选中重置，仅 collected 系
    fireEvent.click(screen.getByText('o/sub'));
    fireEvent.click(screen.getByTestId('pending-segment-to_submit'));
    expect(listText()).toContain('o/col');
    expect(listText()).toContain('o/lc');
    expect(listText()).not.toContain('o/sub');
  });

  it('empty segment shows its own copy instead of the generic group empty state', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView entries={[draftEntry({ id: 'o/col', status: 'collected' })]} />);
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    expect(screen.getByText('暂无已提交应用')).toBeTruthy();
    expect(screen.getByText('已提交等待收录的应用显示在此。')).toBeTruthy();
    expect(screen.queryByText('该分组暂无草稿')).toBeNull();
  });
});

describe('PendingView 标记为未提交（submitted → collected，二次确认）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  function submittedEntry(): CustomDraftEntry {
    return draftEntry({ id: 'o/sub', status: 'submitted', pr_url: 'https://github.com/o/r/pull/7' });
  }

  async function openSubmitted(submitProps: Parameters<typeof PendingView>[0] = {}) {
    const view = render(
      <PendingView
        entries={[submittedEntry()]}
        onGetLicenseAllowlist={gateProvider}
        {...submitProps}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    fireEvent.click(screen.getByText('o/sub'));
    return view;
  }

  it('hides the action when no callback is wired (preview/unit safety)', async () => {
    await i18n.changeLanguage('zh-CN');
    await openSubmitted();
    expect(screen.queryByTestId('pending-withdraw-submitted')).toBeNull();
    // 删除仍在（submitted 行为保持）
    expect(screen.getByTestId('pending-delete')).toBeTruthy();
  });

  it('double-confirms, calls the callback, and returns the row to 待提交 after parent refresh', async () => {
    await i18n.changeLanguage('zh-CN');
    const onWithdrawSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const { rerender } = await openSubmitted({ onWithdrawSubmitted, onNotify });

    const btn = screen.getByTestId('pending-withdraw-submitted');
    fireEvent.click(btn);
    // 首点仅确认态，不调后端
    expect(screen.getByText('再次点击确认')).toBeTruthy();
    expect(onWithdrawSubmitted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pending-withdraw-submitted'));
    await waitFor(() => expect(onWithdrawSubmitted).toHaveBeenCalledWith('o/sub'));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/sub'), 'success'),
    );
    // 受控模式不静默本地翻态：父级刷新前行仍在
    expect(screen.getAllByText('o/sub').length).toBeGreaterThanOrEqual(1);

    // 父级刷新：同 id 回到 collected，已提交分段清空、待提交分段可重新提交
    rerender(
      <PendingView
        entries={[draftEntry({ id: 'o/sub', status: 'collected', pr_url: null })]}
        onWithdrawSubmitted={onWithdrawSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    expect(screen.queryByTestId('pending-withdraw-submitted')).toBeNull();
    expect(screen.getByText('暂无已提交应用')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pending-segment-to_submit'));
    expect(screen.getByText('o/sub')).toBeTruthy();
    fireEvent.click(screen.getByText('o/sub'));
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
  });

  it('disables the action while running and keeps the row when the callback fails', async () => {
    await i18n.changeLanguage('zh-CN');
    let rejectWithdraw: (err: Error) => void = () => {};
    const onWithdrawSubmitted = vi.fn(
      () => new Promise<void>((_resolve, reject) => {
        rejectWithdraw = reject;
      }),
    );
    const onNotify = vi.fn();
    await openSubmitted({ onWithdrawSubmitted, onNotify });
    fireEvent.click(screen.getByTestId('pending-withdraw-submitted'));
    fireEvent.click(screen.getByTestId('pending-withdraw-submitted'));
    await waitFor(() => expect((screen.getByTestId('pending-withdraw-submitted') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('处理中…')).toBeTruthy();
    rejectWithdraw(new Error('withdraw rejected'));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('withdraw rejected'), 'error'),
    );
    // 失败不翻态：行仍在已提交，动作恢复可点
    expect(screen.getAllByText('o/sub').length).toBeGreaterThanOrEqual(1);
    const btn = screen.getByTestId('pending-withdraw-submitted') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByText('标记为未提交')).toBeTruthy();
  });

  it('archived rows keep the read-only card without a withdraw action', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        entries={[draftEntry({ id: 'arch/one', archived: true })]}
        onWithdrawSubmitted={vi.fn().mockResolvedValue(undefined)}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('arch/one'));
    expect(screen.getByText('已转正归档')).toBeTruthy();
    expect(screen.queryByTestId('pending-withdraw-submitted')).toBeNull();
  });
});

describe('PendingView 草稿简介随语言切换（列表/预览/空态复用现有文案）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  function bilingualEntry(partial: Partial<CustomDraftEntry> & { id: string }): CustomDraftEntry {
    return {
      item: {
        ...PENDING_EMPTY_DRAFT,
        id: partial.id,
        name: 'Demo',
        owner: 'o',
        repo: partial.id.split('/')[1] ?? 'r',
        description: '中文简介',
        description_en: 'English desc',
        category: 'dev',
        homepage: 'https://example.com',
        license: 'MIT',
      },
      status: 'draft',
      pr_url: null,
      archived: false,
      ...partial,
    };
  }

  it('resolvePendingDraftDescription 按语言取主文案、空回退另一语言', () => {
    const item = { description: '中文简介', description_en: 'English desc' };
    expect(resolvePendingDraftDescription(item, 'zh-CN')).toBe('中文简介');
    expect(resolvePendingDraftDescription(item, 'en-US')).toBe('English desc');
    expect(resolvePendingDraftDescription({ description: '  中文  ', description_en: '  ' }, 'en-US')).toBe('中文');
    expect(resolvePendingDraftDescription({ description: '  ', description_en: ' English ' }, 'zh-CN')).toBe('English');
    expect(resolvePendingDraftDescription({ description: '  ', description_en: '  ' }, 'zh-CN')).toBe('');
    expect(resolvePendingDraftDescription({ description: '  ', description_en: '  ' }, 'en-US')).toBe('');
  });

  it('草稿列表项随语言切换简介、空回退另一语言', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container, unmount } = render(
      <PendingView initialEntries={[bilingualEntry({ id: 'o/a' })]} />,
    );
    const listTextZh = container.querySelector('.pending-list')?.textContent ?? '';
    expect(listTextZh).toContain('中文简介');
    expect(listTextZh).not.toContain('English desc');
    unmount();

    await i18n.changeLanguage('en-US');
    const { container: containerEn, unmount: unmountEn } = render(
      <PendingView initialEntries={[bilingualEntry({ id: 'o/a' })]} />,
    );
    const listTextEn = containerEn.querySelector('.pending-list')?.textContent ?? '';
    expect(listTextEn).toContain('English desc');
    expect(listTextEn).not.toContain('中文简介');
    unmountEn();

    // 英文缺失回退中文
    await i18n.changeLanguage('en-US');
    const fallback = bilingualEntry({ id: 'o/b' });
    fallback.item.description_en = '   ';
    const { container: containerFb, unmount: unmountFb } = render(
      <PendingView initialEntries={[fallback]} />,
    );
    expect(containerFb.querySelector('.pending-list')?.textContent ?? '').toContain('中文简介');
    unmountFb();

    // 双空复用 trends.no_desc，不新增文案
    await i18n.changeLanguage('zh-CN');
    const empty = bilingualEntry({ id: 'o/c' });
    empty.item.description = '   ';
    empty.item.description_en = '  ';
    const { container: containerEmpty, unmount: unmountEmpty } = render(
      <PendingView initialEntries={[empty]} />,
    );
    expect(containerEmpty.querySelector('.pending-list')?.textContent ?? '').toContain('暂无简介');
    unmountEmpty();

    await i18n.changeLanguage('en-US');
    const { container: containerEmptyEn, unmount: unmountEmptyEn } = render(
      <PendingView initialEntries={[empty]} />,
    );
    expect(containerEmptyEn.querySelector('.pending-list')?.textContent ?? '').toContain('No description');
    unmountEmptyEn();
  });

  it('收录后预览（表单预览 lane）随语言切换、表单两框保留可编辑', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        initialEntries={[bilingualEntry({ id: 'o/a' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    // 中文环境预览展中文
    expect(document.querySelector('.pending-preview-desc')?.textContent).toBe('中文简介');
    // 表单两框保留：中英文输入框均可编辑
    const zhInput = screen.getByDisplayValue('中文简介') as HTMLTextAreaElement;
    const enInput = screen.getByDisplayValue('English desc') as HTMLTextAreaElement;
    expect(zhInput).toBeTruthy();
    expect(enInput).toBeTruthy();
    fireEvent.change(enInput, { target: { value: 'English updated' } });
    expect(screen.getByDisplayValue('English updated')).toBeTruthy();
    cleanup();

    await i18n.changeLanguage('en-US');
    render(
      <PendingView
        initialEntries={[bilingualEntry({ id: 'o/a' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    expect(document.querySelector('.pending-preview-desc')?.textContent).toBe('English desc');
    cleanup();
  });

  it('双空预览空态复用 trends.no_desc（不新增文案）', async () => {
    await i18n.changeLanguage('zh-CN');
    const empty = bilingualEntry({ id: 'o/a' });
    empty.item.description = '';
    empty.item.description_en = '   ';
    render(
      <PendingView
        initialEntries={[empty]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    expect(document.querySelector('.pending-preview-desc')?.textContent).toBe('暂无简介');
    expect(document.querySelector('.pending-preview-desc')?.classList.contains('pending-preview-empty')).toBe(true);
    cleanup();

    await i18n.changeLanguage('en-US');
    render(
      <PendingView
        initialEntries={[empty]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    expect(document.querySelector('.pending-preview-desc')?.textContent).toBe('No description');
    cleanup();
  });

  it('收录后富卡（AppCard）随语言切换简介', async () => {
    await i18n.changeLanguage('zh-CN');
    const { unmount } = render(
      <PendingView
        initialEntries={[bilingualEntry({ id: 'o/a', status: 'collected' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    expect(document.querySelector('.pending-editor .app-desc')?.textContent).toBe('中文简介');
    unmount();

    await i18n.changeLanguage('en-US');
    render(
      <PendingView
        initialEntries={[bilingualEntry({ id: 'o/a', status: 'collected' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('Local Library'));
    fireEvent.click(screen.getByText('o/a'));
    expect(document.querySelector('.pending-editor .app-desc')?.textContent).toBe('English desc');
  });
});

describe('PendingView 富卡 stars/forks 取真值（pendingDraftToAppSummary）', () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
  };
  const gateProvider = () => Promise.resolve(gate);

  it('保留有限 stars/forks 真值，缺失才回退 0', () => {
    const base = { ...PENDING_EMPTY_DRAFT, id: 'o/a', owner: 'o', repo: 'a' };
    expect(pendingDraftToAppSummary({ ...base, stars: 12000, forks: 400 }, 'collected').stars).toBe(12000);
    expect(pendingDraftToAppSummary({ ...base, stars: 12000, forks: 400 }, 'collected').forks).toBe(400);
    // 缺失（新草稿/旧数据无该字段）回退 0
    expect(pendingDraftToAppSummary(base, 'collected').stars).toBe(0);
    expect(pendingDraftToAppSummary(base, 'collected').forks).toBe(0);
  });

  it('非有限值回退 0（不透传 NaN/Infinity）', () => {
    const base = { ...PENDING_EMPTY_DRAFT, id: 'o/a', owner: 'o', repo: 'a' };
    expect(pendingDraftToAppSummary({ ...base, stars: NaN, forks: Infinity }, 'collected').stars).toBe(0);
    expect(pendingDraftToAppSummary({ ...base, stars: NaN, forks: Infinity }, 'collected').forks).toBe(0);
    expect(
      pendingDraftToAppSummary({ ...base, stars: '99' as unknown as number, forks: undefined }, 'collected')
        .stars,
    ).toBe(0);
  });

  it('收录富卡（AppCard）展示真值星数而非恒 0', async () => {
    await i18n.changeLanguage('zh-CN');
    const entry = draftEntry({ id: 'o/a', status: 'collected' });
    entry.item.stars = 12000;
    entry.item.forks = 400;
    render(
      <PendingView
        initialEntries={[entry]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    // AppCard 星标经 formatStars 渲染：12000 → 12.0k，恒 0 回归即为 '0'
    expect(document.querySelector('.pending-editor .app-tag-star')?.textContent).toContain('12.0k');
  });

  it('收录富卡（AppCard）渲染关注与收藏按钮占位，点击安全无副作用（NOOP）', async () => {
    await i18n.changeLanguage('zh-CN');
    const entry = draftEntry({ id: 'o/a', status: 'collected' });
    render(
      <PendingView
        initialEntries={[entry]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));

    const headerButtons = document.querySelectorAll('.pending-editor .app-card-header .btn-fav-card');
    expect(headerButtons.length).toBe(2);
    // 渲染关注与收藏按钮占位以保持与完整富卡间距一致
    const [watchButton, favoriteButton] = Array.from(headerButtons);
    expect(watchButton).toBeDefined();
    expect(favoriteButton).toBeDefined();

    // 纯预览态点击安全无报错、不触发外部状态
    expect(() => {
      fireEvent.click(watchButton);
      fireEvent.click(favoriteButton);
    }).not.toThrow();
  });
});

describe('PendingView 保存类回调失败路径（Issue 05）', () => {
  it('onSave reject 时 toast 报错且停留编辑态可重试', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error('db offline'));
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        onNotify={onNotify}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('保存草稿'));
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error');
    });
    // 停留编辑态：表单未关闭（保存按钮仍在），成功提示不出现
    expect(screen.getByText('保存草稿')).toBeTruthy();
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('草稿已保存'), 'success');
  });

  it('onDelete reject 时 toast 报错并解除二次确认态', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const onDelete = vi.fn().mockRejectedValue(new Error('db offline'));
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        onNotify={onNotify}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    const deleteBtn = screen.getByTitle('删除本地草稿（需二次确认）');
    fireEvent.click(deleteBtn);
    // 首点置确认态，次点执行
    fireEvent.click(screen.getByText('再次点击确认删除'));
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('删除失败'), 'error');
    });
    // 失败后解除确认态：按钮 title 回到首点口径，成功提示不出现
    expect(screen.getByTitle('删除本地草稿（需二次确认）')).toBeTruthy();
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('草稿已删除'), 'info');
  });

  it('onMarkSubmitted reject 时 toast 报错且不切已提交分段', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    const onMarkSubmitted = vi.fn().mockRejectedValue(new Error('db offline'));
    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        onNotify={onNotify}
        onMarkSubmitted={onMarkSubmitted}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.change(screen.getByLabelText('收录申请提交'), {
      target: { value: 'https://github.com/o/a/pull/1' },
    });
    fireEvent.click(screen.getByText('标记已提交'));
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('标记失败'), 'error');
    });
    // 停留原位：标记按钮仍在（未切已提交分段），成功提示不出现
    expect(screen.getByText('标记已提交')).toBeTruthy();
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('已标记为已提交'), 'success');
  });
});

describe("PendingView 国际化（中英语言切换）", () => {
  it("中英文模式下正确渲染待收录页面大标题、Tab、表单分节大标题与按钮", async () => {
    // 1. 中文模式
    await i18n.changeLanguage("zh-CN");
    const { unmount } = render(
      <PendingView
        initialEntries={[draftEntry({ id: "o/a" })]}
      />,
    );
    expect(screen.getByText("待收录")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
    expect(screen.getByText("本地收录")).toBeTruthy();
    expect(screen.getByText("已归档")).toBeTruthy();

    // 空态点击“新建草稿”：展示“仓库与标识”分节
    fireEvent.click(screen.getByText("新建草稿"));
    expect(screen.getByText("仓库与标识")).toBeTruthy();

    // 选中已有草稿：不展示“仓库与标识”，直入“基本信息”
    fireEvent.click(screen.getByText("o/a"));
    expect(screen.queryByText("仓库与标识")).toBeNull();
    expect(screen.getByText("基本信息")).toBeTruthy();
    expect(screen.getByText("补充信息")).toBeTruthy();
    expect(screen.getByText("运行配置")).toBeTruthy();
    expect(screen.getByText("保存草稿")).toBeTruthy();
    unmount();

    // 2. 英文模式
    await i18n.changeLanguage("en-US");
    render(
      <PendingView
        initialEntries={[draftEntry({ id: "o/a" })]}
      />,
    );
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Local Library")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();

    fireEvent.click(screen.getByText("New Draft"));
    expect(screen.getByText("Repository & Identifiers")).toBeTruthy();

    fireEvent.click(screen.getByText("o/a"));
    expect(screen.queryByText("Repository & Identifiers")).toBeNull();
    expect(screen.getByText("Basic Information")).toBeTruthy();
    expect(screen.getByText("Supplemental Information")).toBeTruthy();
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText("Save draft")).toBeTruthy();
  });
});

describe("PendingView 草稿编辑直点收录进本地（自动落盘最新表单与预览栏精简）", () => {
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ["MIT", "ISC", "Apache-2.0", "GPL-3.0", "MPL-2.0", "Unlicense"],
  };
  const gateProvider = () => Promise.resolve(gate);

  it("预览栏仅展示标题、坐标摘要与展开/收起按钮，不含额外状态徽标", async () => {
    await i18n.changeLanguage("zh-CN");
    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: "o/a" })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText("o/a"));
    const previewHeader = container.querySelector(".pending-preview-header");
    expect(previewHeader).toBeTruthy();
    expect(previewHeader?.textContent).not.toContain("自维护草稿");
  });

  it("修改表单参数后直接点击收录进本地：先调用 onSave 持久化最新配置再调用 onCollectLocal", async () => {
    await i18n.changeLanguage("zh-CN");
    const callOrder: string[] = [];
    const onSave = vi.fn(async () => {
      callOrder.push("save");
    });
    const onCollectLocal = vi.fn(async () => {
      callOrder.push("collect");
    });
    const entry = draftEntry({ id: "o/a" });
    entry.item.license = "OpenSource"; // 初始为未通过严格校验的占位协议

    render(
      <PendingView
        initialEntries={[entry]}
        onSave={onSave}
        onCollectLocal={onCollectLocal}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText("o/a"));

    // 用户直接修改名称、简介与协议，不点“保存草稿”，直接点“收录进本地”
    fireEvent.change(screen.getByDisplayValue("Demo"), {
      target: { value: "Impeccable Pro" },
    });
    fireEvent.change(screen.getByDisplayValue("demo"), {
      target: { value: "全新修改后的中文简介" },
    });
    fireEvent.change(screen.getByDisplayValue("OpenSource"), {
      target: { value: "Apache-2.0" },
    });

    fireEvent.click(screen.getByTestId("pending-collect-local"));

    await waitFor(() => expect(onCollectLocal).toHaveBeenCalledWith("o/a"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "o/a",
        name: "Impeccable Pro",
        description: "全新修改后的中文简介",
        license: "Apache-2.0",
      }),
    );
    expect(callOrder).toEqual(["save", "collect"]);
  });

  it("非受控本地态下修改参数后直接点击收录进本地：收录后富卡立即展示最新配置", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <PendingView
        initialEntries={[draftEntry({ id: "o/a" })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText("o/a"));

    fireEvent.change(screen.getByDisplayValue("Demo"), {
      target: { value: "UpdatedName" },
    });
    fireEvent.change(screen.getByDisplayValue("demo"), {
      target: { value: "Updated local description" },
    });

    fireEvent.click(screen.getByTestId("pending-collect-local"));

    // 自动切到本地收录并展示更新后的富卡内容
    await waitFor(() =>
      expect(document.querySelector(".pending-editor .app-name")?.textContent).toBe("UpdatedName"),
    );
    expect(document.querySelector(".pending-editor .app-desc")?.textContent).toBe(
      "Updated local description",
    );
  });
});
