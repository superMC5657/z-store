import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '../i18n';
import {
  PENDING_EMPTY_DRAFT,
  PENDING_SHOW_COORDS_STORAGE_KEY,
  PendingView,
  canonicalDraftId,
  isOsiApprovedLicense,
  normalizeLicense,
  validatePendingDraft,
  type CustomDraftEntry,
  type LicenseAllowlistResult,
} from './PendingView';

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
  // ADR-0018：名单唯一源头为后端；单测以前端快照形态显式传入，不依赖硬编码。
  const gate: LicenseAllowlistResult = {
    enabled: true,
    allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'GPL-3.0+', 'MPL-2.0', 'Unlicense'],
  };

  it('accepts a canonical draft in submit mode with the backend allowlist', () => {
    const item = { ...PENDING_EMPTY_DRAFT, id: 'o/r', name: 'Demo', owner: 'o', repo: 'r', description: 'd', category: 'dev', homepage: 'https://example.com', license: 'MIT' };
    expect(validatePendingDraft(item, 'submit', gate)).toEqual({});
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
    render(<PendingView />);
    expect(screen.getByText('还没有待收录草稿')).toBeTruthy();
    expect(screen.getAllByText('新建草稿').length).toBeGreaterThan(0);
  });

  it('groups drafts by status and shows pr_url on submitted', async () => {
    await i18n.changeLanguage('zh-CN');
    const entries = [
      draftEntry({ id: 'o/a' }),
      draftEntry({ id: 'o/b', status: 'submitted', pr_url: 'https://github.com/x/y/pull/1' }),
      draftEntry({ id: 'o/c', archived: true }),
    ];
    const { container } = render(<PendingView initialEntries={entries} />);
    // 三态分组齐备
    expect(screen.getByText('草稿')).toBeTruthy();
    expect(screen.getByText('待提交')).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();
    // 默认草稿分组可见 o/a
    expect(container.textContent).toContain('o/a');
    // 切换到待提交分组可见 PR 链接
    fireEvent.click(screen.getByText('待提交'));
    expect(screen.getByText('https://github.com/x/y/pull/1')).toBeTruthy();
    // 切换到已归档分组
    fireEvent.click(screen.getByText('已归档'));
    expect(container.textContent).toContain('o/c');
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
        hasUpdates={false}
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
    const { container } = render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a' })]} />);
    const layout = container.querySelector('.pending-layout') as HTMLElement | null;
    expect(layout).toBeTruthy();
    // 分栏列定义收进样式表，行内不再写死双列。
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
    const { container } = render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a' })]} />);
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
    // 控件满宽规则仍在（label 在上、输入框在下占满宽）。
    expect(css).toContain('.pending-view .input-fluent');
    expect(css).toContain('width: 100%');
  });

  it('长 id 标题省略 + title 悬浮看全', async () => {
    await i18n.changeLanguage('zh-CN');
    const longId = 'verylongownername/verylongreponame-0123456789abcdef';
    const { container } = render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: longId })]} />);
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
  it('编辑态 owner/repo 只读锁定，id 显示为徽标且提供 pending-copy-id', async () => {
    await i18n.changeLanguage('zh-CN');
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: writeSpy },
      configurable: true,
    });
    const onNotify = vi.fn();

    render(
      <PendingView
        showBatchBar={false}
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
        onNotify={onNotify}
      />,
    );
    fireEvent.click(screen.getByText('owner1/repo1'));

    // owner/repo 在编辑态具有 readOnly
    const ownerInput = screen.getByDisplayValue('owner1') as HTMLInputElement;
    const repoInput = screen.getByDisplayValue('repo1') as HTMLInputElement;
    expect(ownerInput.readOnly).toBe(true);
    expect(repoInput.readOnly).toBe(true);

    // id 不再是 input，而是徽标 + 复制按钮
    expect(screen.queryByPlaceholderText('owner/repo')).toBeNull();
    const copyBtn = screen.getByTestId('pending-copy-id');
    expect(copyBtn).toBeTruthy();
    fireEvent.click(copyBtn);
    expect(writeSpy).toHaveBeenCalledWith('owner1/repo1');
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('owner1/repo1'), 'success');
    });
  });

  it('点击“复制为新草稿”切到新建态（owner/repo 可改，原草稿保留）', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();

    render(
      <PendingView
        showBatchBar={false}
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
        onNotify={onNotify}
      />,
    );
    fireEvent.click(screen.getByText('owner1/repo1'));

    const dupBtn = screen.getByTestId('pending-duplicate');
    expect(dupBtn).toBeTruthy();
    fireEvent.click(dupBtn);

    // 切到新建态：owner 与 repo 输入框不再 readOnly
    const ownerInput = screen.getByDisplayValue('owner1') as HTMLInputElement;
    const repoInput = screen.getByDisplayValue('repo1') as HTMLInputElement;
    expect(ownerInput.readOnly).toBe(false);
    expect(repoInput.readOnly).toBe(false);

    // 修改仓库坐标并保存新草稿
    fireEvent.change(ownerInput, { target: { value: 'owner2' } });
    fireEvent.change(repoInput, { target: { value: 'repo2' } });
    fireEvent.click(screen.getByText('保存草稿'));

    // 确认生成了新条目且原条目仍存
    expect(screen.getByText('owner1/repo1')).toBeTruthy();
    expect(screen.getAllByText('owner2/repo2').length).toBeGreaterThanOrEqual(1);
  });

  it('archived 行整表单只读、禁用保存，仅留“复制为新草稿”可用', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'arch/one', archived: true })]}
      />,
    );
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('arch/one'));

    // 保存按钮被禁用
    const saveBtn = screen.getByText('保存草稿') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // 字段均带有 readOnly
    const nameInput = screen.getByDisplayValue('Demo') as HTMLInputElement;
    expect(nameInput.readOnly).toBe(true);

    // 仍提供“复制为新草稿”
    const dupBtn = screen.getByTestId('pending-duplicate');
    expect(dupBtn).toBeTruthy();
  });

  it('仓库与标识区提供显隐开关，隐藏时不渲染该节但标题保留 id，新建态不受影响', async () => {
    await i18n.changeLanguage('zh-CN');
    window.localStorage.removeItem(PENDING_SHOW_COORDS_STORAGE_KEY);

    const { container, unmount } = render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'owner1/repo1' })]}
      />,
    );
    fireEvent.click(screen.getByText('owner1/repo1'));

    // 默认显示：Section D 存在
    expect(screen.getByTestId('pending-copy-id')).toBeTruthy();
    expect(screen.getByTestId('pending-duplicate')).toBeTruthy();
    const toggleBtn = screen.getByTestId('pending-toggle-coords');
    expect(toggleBtn).toBeTruthy();

    // 点击隐藏：Section D 不再渲染，但编辑器标题仍保留 owner1/repo1
    fireEvent.click(toggleBtn);
    expect(window.localStorage.getItem(PENDING_SHOW_COORDS_STORAGE_KEY)).toBe('false');
    expect(screen.queryByTestId('pending-copy-id')).toBeNull();
    expect(screen.queryByTestId('pending-duplicate')).toBeNull();
    expect(container.querySelector('.pending-editor-title')?.textContent).toBe('owner1/repo1');

    // 重新切到新建态：核心仓库录入字段始终可填，不被隐藏
    fireEvent.click(screen.getByText('新建草稿'));
    expect(screen.getAllByPlaceholderText('rustdesk')).toHaveLength(2);

    unmount();
    window.localStorage.removeItem(PENDING_SHOW_COORDS_STORAGE_KEY);
  });
});

function readPendingCss(): string {
  return readFileSync(join(process.cwd(), 'src', 'styles', 'components-pending.css'), 'utf8');
}
