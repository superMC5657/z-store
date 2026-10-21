import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import {
  PENDING_EMPTY_DRAFT,
  type CustomDraftEntry,
} from './pending/draftModel';
import { PendingView } from './PendingView';
import { PREFILL_URL_LENGTH_LIMIT } from './pending/submitPrefillFlow';
import {
  buildCustomDraftItemFromSummary,
  buildCustomDraftItemFromTrendRepo,
} from '../services/api/catalog';
import { tauriApi } from '../services/api';
import type { AppSummary } from '../types';
import type { LicenseAllowlistResult } from '../services/api/catalog';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window.navigator as unknown as Record<string, unknown>)['clipboard'];
  await i18n.changeLanguage('zh-CN');
});

/** 剪贴板桩（同 PendingView.test.tsx：直接覆写 navigator.clipboard.writeText）。 */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeSpy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: writeSpy },
    configurable: true,
  });
  return writeSpy;
}

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

const BATCH_URL = 'https://github.com/superMC5657/z-store-catalog/issues/new?title=batch';

// ADR-0018：许可名单唯一源头为后端；组件测试经 onGetLicenseAllowlist 注入快照桩。
const TEST_GATE: LicenseAllowlistResult = {
  enabled: true,
  allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
};

function gateProvider(): Promise<LicenseAllowlistResult> {
  return Promise.resolve(TEST_GATE);
}

describe('PendingView one-click Issue submit (Lane D)', () => {
  it('single card submit opens prefill URL without auto-marking (stays collected for manual confirm)', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 已收录未提交归 collected 分组：先切 tab 再选中
    fireEvent.click(screen.getByText('本地收录'));
    // 选中草稿进入编辑态
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(onGetPrUrl).toHaveBeenCalledWith('o/a'));
    // 生产经 tauriApi.openUrl 打开（不再走被劫持的 window.open），可 await/检查失败
    expect(openSpy).toHaveBeenCalledWith(BATCH_URL);
    // 打开预填页不自动 mark：submitted 态只靠手动贴链接确认
    expect(onMarkSubmitted).not.toHaveBeenCalled();
    // 取消则停留 collected：提交入口与手动标记行仍在，可重新提交
    await waitFor(() => expect((screen.getByTestId('pending-submit-pr') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    expect(screen.getByText('标记已提交')).toBeTruthy();
  });

  it('manual mark after opening prefill moves to submitted (user pastes Issue URL to confirm)', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(onMarkSubmitted).not.toHaveBeenCalled();
    // 手动贴上 Issue 链接再确认，方进入已提交
    const urlInput = screen.getByPlaceholderText('https://github.com/…/pull/…') as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://github.com/o/r/pull/42' } });
    fireEvent.click(screen.getByText('标记已提交'));
    await waitFor(() => expect(onMarkSubmitted).toHaveBeenCalledWith('o/a', 'https://github.com/o/r/pull/42'));
  });

  it('没有后端 provider（预览模式）时提示不可提交，且不打开任何链接', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onNotify = vi.fn();

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringContaining('预览模式仅演示，提交 Issue 请在桌面版完成'),
        'warning',
      ),
    );
    expect(openSpy).not.toHaveBeenCalled();
    // 停留 collected：提交入口与手动标记行仍在
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    expect(screen.getByText('标记已提交')).toBeTruthy();
  });

  it('renders the submitted Issue link as a back-jump anchor', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        showBatchBar={false}
        onGetLicenseAllowlist={gateProvider}
        initialEntries={[
          draftEntry({ id: 'o/b', status: 'submitted', pr_url: 'https://github.com/x/y/pull/1' }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    const link = screen.getByText('https://github.com/x/y/pull/1').closest('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});

describe('PendingView batch submit via list multi-select + list toolbar button (no separate bar)', () => {
  it('merges selected drafts into one prefill URL without auto-marking (stays collected)', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), draftEntry({ id: 'o/b', status: 'collected' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 默认草稿分组列表底部工具行批量隐藏，切到本地收录才展出（空选禁用，无独立批量栏；按钮不在页头区）。
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
    fireEvent.click(screen.getByText('本地收录'));
    const batchBtn = screen.getByTestId('pending-batch-submit') as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);
    expect(container.querySelector('.pending-header [data-testid="pending-batch-submit"]')).toBeNull();
    expect(container.querySelector('.pending-list-toolbar [data-testid="pending-batch-submit"]')).toBeTruthy();
    // 工具行位于列表底部：.pending-list 最后一个子节点，排在所有列表项之后
    expect(container.querySelector('.pending-list')?.lastElementChild?.getAttribute('data-testid')).toBe('pending-batch-toolbar');

    // 列表多选勾选两条（checkbox aria-label=id，点击不触发详情选中）
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    expect(boxA).toBeTruthy();
    expect(boxB).toBeTruthy();
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    await waitFor(() => expect((screen.getByTestId('pending-batch-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(onGetBatchPrUrl).toHaveBeenCalledWith(['o/a', 'o/b']));
    expect(openSpy).toHaveBeenCalledWith(BATCH_URL);
    // 打开预填页不自动 mark：各条目靠手动贴链接确认，停留 collected 可重新提交
    expect(onMarkSubmitted).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending-batch-submit')).toBeTruthy();
  });

  it('hides batch entry and multi-select when showBatchBar is false', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]} onGetLicenseAllowlist={gateProvider} />);
    fireEvent.click(screen.getByText('本地收录'));
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
    expect(container.querySelector('.pending-list input[type="checkbox"]')).toBeNull();
  });

  it('switches one-click Issue copy between Chinese and English (collected only)', async () => {
    await i18n.changeLanguage('en-US');
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('Local Library'));
    fireEvent.click(screen.getByText('o/a'));
    expect(screen.getByText('Submit Issue')).toBeTruthy();
  });

  it('draft has no submit Issue button (must collect locally first)', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a' })]} onGetLicenseAllowlist={gateProvider} />);
    fireEvent.click(screen.getByText('o/a'));
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    const collectBtn = screen.getByTestId('pending-collect-local');
    expect(collectBtn).toBeTruthy();
    // 收录主按钮右置并复用主样式（白底主按钮）
    expect(collectBtn.className).toContain('btn-primary');
    expect((collectBtn as HTMLElement).style.marginLeft).toBe('auto');
  });
});

describe('PendingView revert collected to draft (secondary + double-confirm)', () => {
  it('collected shows revert secondary + submit primary (submit stays rightmost)', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    const revertBtn = screen.getByTestId('pending-revert-to-draft');
    const submitBtn = screen.getByTestId('pending-submit-pr');
    expect(revertBtn).toBeTruthy();
    expect(submitBtn).toBeTruthy();
    expect(revertBtn.className).toContain('btn-secondary');
    expect(submitBtn.className).toContain('btn-primary');
    // 退回次级右置占位，提交主按钮紧随其后（同为右对齐组）
    expect((revertBtn as HTMLElement).style.marginLeft).toBe('auto');
    expect(screen.getByText('退回草稿')).toBeTruthy();
  });

  it('revert needs double-confirm and stays in collected locally with toast', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    const revertBtn = screen.getByTestId('pending-revert-to-draft');
    // 首点仅置确认态，不翻态
    fireEvent.click(revertBtn);
    expect(screen.getByText('再次点击确认退回')).toBeTruthy();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeTruthy();
    // 次点执行：本地翻 draft + toast，停留本地收录不跳 Tab
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/a'), 'info'),
    );
    // 停留本地收录：选中清空回空态，列表不再含该行
    await waitFor(() => expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull());
    expect(screen.queryByText('o/a')).toBeNull();
    expect(screen.getByText('选择或新建一份草稿')).toBeTruthy();
    // 切回草稿才可见该行
    fireEvent.click(screen.getByText('草稿'));
    expect(screen.getAllByText('o/a').length).toBeGreaterThanOrEqual(1);
  });

  it('revert with multiple collected rows falls to next row and stays in collected', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[
          draftEntry({ id: 'o/a', status: 'collected' }),
          draftEntry({ id: 'o/b', status: 'collected' }),
        ]}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/a'), 'info'),
    );
    // 停留本地收录且选中落到下一条同组行：o/b 富卡仍在，o/a 已退出列表
    await waitFor(() => expect(screen.getByTestId('pending-submit-pr')).toBeTruthy());
    expect(screen.queryByText('o/a')).toBeNull();
    expect(screen.queryByText('选择或新建一份草稿')).toBeNull();
    // 切回草稿可见被退回的行
    fireEvent.click(screen.getByText('草稿'));
    expect(screen.getAllByText('o/a').length).toBeGreaterThanOrEqual(1);
  });

  it('revert delegates to onRevertToDraft when wired and stays in collected', async () => {
    await i18n.changeLanguage('zh-CN');
    const onRevertToDraft = vi.fn().mockResolvedValue(undefined);
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        onRevertToDraft={onRevertToDraft}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    fireEvent.click(screen.getByTestId('pending-revert-to-draft'));
    await waitFor(() => expect(onRevertToDraft).toHaveBeenCalledWith('o/a'));
    // 受控退回同样不跳 Tab：停留本地收录（选中清空由父级刷新后生效，此处不断言列表，守住不自动切草稿）
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
    expect(screen.getByText('选择或新建一份草稿')).toBeTruthy();
  });

  it('archived stays readonly with no collect/submit/revert', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'arch/one', archived: true })]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('已归档'));
    fireEvent.click(screen.getByText('arch/one'));
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
  });
});

describe('Lane C move-in placeholder license (draft-lenient, submit-strict)', () => {
  function summaryWithLicense(license: string): AppSummary {
    return {
      id: 'o/a',
      name: 'Demo',
      owner: 'o',
      repo: 'a',
      icon: '',
      icon_bg: '',
      description: 'demo',
      stars: 0,
      forks: 0,
      license,
      latest_version: 'v0.1.0',
      category: 'dev',
      category_name: 'dev',
      is_verified: false,
      forge: 'github',
      forge_host: 'github.com',
      homepage: null,
      platforms: [],
    };
  }

  it('move-in builders keep an honest OpenSource placeholder instead of faking MIT', () => {
    expect(buildCustomDraftItemFromSummary(summaryWithLicense('')).license).toBe('OpenSource');
    expect(buildCustomDraftItemFromSummary(summaryWithLicense('OpenSource')).license).toBe(
      'OpenSource',
    );
    expect(buildCustomDraftItemFromSummary(summaryWithLicense('MIT')).license).toBe('MIT');
    expect(
      buildCustomDraftItemFromTrendRepo({ owner: 'o', repo: 'a' }).license,
    ).toBe('OpenSource');
  });

  it('move-in builders heuristically prefill empty arrays/objects (editable, truth-preserving)', () => {
    const draft = buildCustomDraftItemFromSummary(summaryWithLicense('MIT'));
    // 空数组/对象不再留空：有推断即预填（可编辑，提交前人工校对）。
    expect(draft.aliases.length).toBeGreaterThan(0);
    expect(draft.aliases).toContain('o/a');
    expect(draft.install_dirs).toEqual(['a']);
    expect(draft.search_subdirs).toEqual(['bin']);
    expect(draft.publishers).toEqual(['O']);
    expect(draft.platforms.length).toBeGreaterThan(0);
    expect(Object.keys(draft.identifiers).length).toBeGreaterThan(0);
    expect(draft.identifiers.windows?.join(' ')).toContain('a.exe');
    // 源 category 非空原样保留（dev 不强制改写）。
    expect(draft.category).toBe('dev');

    const trend = buildCustomDraftItemFromTrendRepo({ owner: 'o', repo: 'RustDesk' });
    expect(trend.install_dirs).toEqual(['RustDesk', 'rustdesk']);
    expect(trend.search_subdirs).toEqual(['bin']);
    expect(trend.publishers).toEqual(['O']);
    expect(trend.aliases).toContain('o/rustdesk');
    expect(trend.platforms).toEqual(['windows', 'macos', 'linux']);
    expect(trend.identifiers.windows).toContain('RustDesk.exe');
    expect(trend.identifiers.linux).toContain('rustdesk');
  });

  it('platforms source non-empty wins; category empty falls back to keyword guess + name sync', () => {
    const withPlatforms = buildCustomDraftItemFromSummary({
      ...summaryWithLicense('MIT'),
      owner: 'acme',
      repo: 'AtlasPlayer',
      name: 'AtlasPlayer',
      description: 'Music and video stream player',
      category: '',
      category_name: '',
      platforms: ['windows'],
    });
    // 有真值绝不覆盖：源 platforms 非空即用。
    expect(withPlatforms.platforms).toEqual(['windows']);
    expect(Object.keys(withPlatforms.identifiers)).toEqual(['windows']);
    // 源 category 为空才猜：播放器关键词 → media + 中文名同步。
    expect(withPlatforms.category).toBe('media');
    expect(withPlatforms.category_name).toBe('影音视听');

    const keepExternal = buildCustomDraftItemFromSummary({
      ...summaryWithLicense('MIT'),
      category: 'external',
      category_name: 'external',
      platforms: [],
    });
    expect(keepExternal.category).toBe('external');
    expect(keepExternal.platforms.length).toBeGreaterThan(0);
  });

  it('single submit stays clickable on placeholder license, shows inline and locates first error', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    const placeholder = draftEntry({ id: 'o/a', status: 'collected' });
    placeholder.item.license = 'OpenSource';
    render(
      <PendingView
        initialEntries={[placeholder]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    // 富卡分支：只展 AppCard 黄标，无参数表单输入
    expect(document.querySelector('.app-card .verified-badge-local')).toBeTruthy();
    expect(screen.queryByDisplayValue('OpenSource')).toBeNull();
    expect(screen.queryByPlaceholderText('rustdesk')).toBeNull();
    const submitBtn = screen.getByTestId('pending-submit-pr') as HTMLButtonElement;
    // 缺项仍可点击，title 复用 license_fix_hint（不新增文案）
    await waitFor(() => expect(submitBtn.disabled).toBe(false));
    expect(submitBtn.title).toContain('SPDX');
    // 点击不调后端：置内联 + 定位首错行，不 toast 缺失类提示
    fireEvent.click(submitBtn);
    await waitFor(() => expect(screen.getByTestId('pending-error-license')).toBeTruthy());
    expect(screen.getByText('仅收录 OSI 认证开源协议')).toBeTruthy();
    expect(onGetPrUrl).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onMarkSubmitted).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('SPDX'),
      'warning',
    );
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('尚未通过'),
      expect.anything(),
    );
  });

  it('batch submit stays clickable and lists invalid ids inline without toast', async () => {
    await i18n.changeLanguage('zh-CN');
    const bad = draftEntry({ id: 'o/b', status: 'collected' });
    bad.item.license = 'OpenSource';
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), bad]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 列表多选 + 列表底部工具行批量：先切到本地收录分组再勾选（按钮在列表底部工具行，不在页头）。
    fireEvent.click(screen.getByText('本地收录'));
    expect(container.querySelector('.pending-header [data-testid="pending-batch-submit"]')).toBeNull();
    expect(container.querySelector('.pending-list-toolbar [data-testid="pending-batch-submit"]')).toBeTruthy();
    // 工具行位于列表底部：.pending-list 最后一个子节点，排在所有列表项之后
    expect(container.querySelector('.pending-list')?.lastElementChild?.getAttribute('data-testid')).toBe('pending-batch-toolbar');
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    const batchBtn = screen.getByTestId('pending-batch-submit') as HTMLButtonElement;
    // 缺项仍可点击，title 复用 license_fix_hint
    await waitFor(() => expect(batchBtn.disabled).toBe(false));
    expect(batchBtn.title).toContain('o/b');
    fireEvent.click(batchBtn);
    // 行内列出 ids（复用 batch_blocked 文案），不 toast
    await waitFor(() => expect(screen.getByTestId('pending-batch-blocked')).toBeTruthy());
    expect(screen.getByTestId('pending-batch-blocked').textContent).toContain('o/b');
    expect(onGetBatchPrUrl).not.toHaveBeenCalled();
    expect(onMarkSubmitted).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('o/b'),
      'warning',
    );
  });
});

describe('ADR-0018 backend-sourced license allowlist (fail-safe without a baked-in list)', () => {
  it('submit prompts retry and aborts when the allowlist cannot load', async () => {
    await i18n.changeLanguage('zh-CN');
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onNotify={onNotify}
      />,
    );
    // 故意不传 onGetLicenseAllowlist：非 Tauri 单测环境默认拉取失败，
    // 提交必须提示重试且不开页不标记，绝不回退写死名单。
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringContaining('名单加载失败'),
        'warning',
      ),
    );
    expect(onGetPrUrl).not.toHaveBeenCalled();
    expect(onMarkSubmitted).not.toHaveBeenCalled();
  });

  it('draft save stays lenient without an allowlist (load failure still saves)', async () => {
    await i18n.changeLanguage('zh-CN');
    const onNotify = vi.fn();

    render(
      <PendingView
        showBatchBar={false}
        initialEntries={[draftEntry({ id: 'o/a' })]}
        onNotify={onNotify}
      />,
    );
    // 故意不传 onGetLicenseAllowlist：暂存档不查名单，身份对齐即放行。
    // 页头不再设新建入口：空态提示是唯一新建入口。
    fireEvent.click(screen.getByText('新建草稿'));
    const coordInputs = screen.getAllByPlaceholderText('rustdesk');
    fireEvent.change(coordInputs[0]!, { target: { value: 'n' } });
    fireEvent.change(coordInputs[1]!, { target: { value: 'ew' } });
    fireEvent.click(screen.getByText('保存草稿'));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringContaining('n/ew'),
        'success',
      ),
    );
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('名单加载失败'),
      expect.anything(),
    );
  });
});

describe('PendingView top tabs sync batch entry and submitted with activeGroup', () => {
  it('list toolbar batch only shows in collected, hides in draft/submitted/archived (no separate bar)', async () => {
    await i18n.changeLanguage('zh-CN');
    const entries = [
      draftEntry({ id: 'o/draft' }),
      draftEntry({ id: 'o/col', status: 'collected' }),
      draftEntry({ id: 'o/sub', status: 'submitted', pr_url: 'https://github.com/x/y/pull/9' }),
      draftEntry({ id: 'o/arch', archived: true }),
    ];
    const { container } = render(<PendingView initialEntries={entries} onGetLicenseAllowlist={gateProvider} />);
    // 页头无计数徽标、无新建入口：页头仅标题 + 描述，计数由 Tab 自带
    expect(container.querySelector('.pending-header')?.textContent).not.toContain('新建草稿');
    expect(container.querySelector('.pending-header .nav-badge')).toBeNull();
    expect(container.querySelectorAll('.segmented-count')).toHaveLength(3);
    // 默认草稿分组：列表工具行批量隐藏，无独立批量栏，无多选
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
    expect(container.querySelector('.pending-list input[type="checkbox"]')).toBeNull();
    // 切到本地收录：列表底部工具行批量展出（空选禁用，不在页头区）+ 列表多选
    fireEvent.click(screen.getByText('本地收录'));
    const batchBtn = screen.getByTestId('pending-batch-submit') as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);
    expect(container.querySelector('.pending-header [data-testid="pending-batch-submit"]')).toBeNull();
    expect(container.querySelector('.pending-list-toolbar [data-testid="pending-batch-submit"]')).toBeTruthy();
    // 工具行位于列表底部：.pending-list 最后一个子节点，排在所有列表项之后
    expect(container.querySelector('.pending-list')?.lastElementChild?.getAttribute('data-testid')).toBe('pending-batch-toolbar');
    expect(container.querySelector('.pending-list input[type="checkbox"][aria-label="o/col"]')).toBeTruthy();
    expect(container.querySelector('.pending-list input[type="checkbox"][aria-label="o/sub"]')).toBeNull();
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
    // 切到本地收录 · 已提交：工具行批量隐藏，无多选，无独立栏
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(container.querySelector('.pending-list input[type="checkbox"]')).toBeNull();
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
    // 切到已归档：工具行批量隐藏，无多选
    fireEvent.click(screen.getByText('已归档'));
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(container.querySelector('.pending-list input[type="checkbox"]')).toBeNull();
    // 切回草稿：仍隐藏
    fireEvent.click(screen.getByText('草稿'));
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
  });

  it('cross-tab switches reset detail selection to empty state (no stale form/rich)', async () => {
    await i18n.changeLanguage('zh-CN');
    const entries = [
      draftEntry({ id: 'o/draft' }),
      draftEntry({ id: 'o/col', status: 'collected' }),
    ];
    render(
      <PendingView
        showBatchBar={false}
        initialEntries={entries}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 草稿分组选中草稿：展表单 + 收录主按钮
    fireEvent.click(screen.getByText('o/draft'));
    expect(screen.getByTestId('pending-collect-local')).toBeTruthy();
    // 切到本地收录：选中重置，右侧回空态，不展错配表单
    fireEvent.click(screen.getByText('本地收录'));
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.getByText('选择或新建一份草稿')).toBeTruthy();
    // 选中已收录行：展富卡提交主按钮
    fireEvent.click(screen.getByText('o/col'));
    expect(screen.getByTestId('pending-submit-pr')).toBeTruthy();
    // 切回草稿：富卡按钮清空，回到空态
    fireEvent.click(screen.getByText('草稿'));
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.getByText('选择或新建一份草稿')).toBeTruthy();
  });

  it('submitted shows rich Issue link without duplicate submit or manual mark', async () => {
    await i18n.changeLanguage('zh-CN');
    const { container } = render(
      <PendingView
        initialEntries={[
          draftEntry({ id: 'o/sub', status: 'submitted', pr_url: 'https://github.com/x/y/pull/9' }),
        ]}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 草稿分组下列表工具行批量隐藏（draft 不可选）
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByTestId('pending-segment-submitted'));
    // 已提交分段无批量：工具行隐藏、列表不可多选
    expect(screen.queryByTestId('pending-batch-submit')).toBeNull();
    expect(screen.queryByTestId('pending-batch-toolbar')).toBeNull();
    expect(container.querySelector('.pending-list input[type="checkbox"]')).toBeNull();
    fireEvent.click(screen.getByText('o/sub'));
    // 已提交仅展 Issue 链接（列表与详情各一次，同文案双节点），无重复提交/退回/收录
    expect(screen.getAllByText('https://github.com/x/y/pull/9').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('pending-submit-pr')).toBeNull();
    expect(screen.queryByTestId('pending-revert-to-draft')).toBeNull();
    expect(screen.queryByTestId('pending-collect-local')).toBeNull();
    expect(screen.queryByText('标记已提交')).toBeNull();
    // 已提交允许删除（二次确认复用删除形态）
    expect(screen.getByTestId('pending-delete')).toBeTruthy();
  });
});

describe('PendingView prefill open via tauriApi (hijack/open-fail/long-url)', () => {
  it('single submit goes through tauriApi.openUrl, never the hijacked window.open', async () => {
    await i18n.changeLanguage('zh-CN');
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(BATCH_URL));
    // 经 tauriApi.openUrl 打开，未调用 window.open
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('backend pr-url gate error surfaces and aborts without silent local fallback or open', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockRejectedValue(new Error('gate rejected: license_osi'));

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(onGetPrUrl).toHaveBeenCalledWith('o/a'));
    // 后端门禁错直接透出，不静默回退本地 URL、不开页
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('gate rejected'), 'error'),
    );
    expect(openSpy).not.toHaveBeenCalled();
    // 未取到 URL 不谎报“已复制正在打开”
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('正在打开预填页'),
      'success',
    );
  });

  it('single open failure copies the prefill URL and toasts the copied hint', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockRejectedValue(new Error('shell open denied'));
    // 真失败：原生兜底同样被拦截返回 null，保留失败感知
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeSpy = stubClipboard();
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(BATCH_URL));
    // 兜底同样失败（window.open 返回 null）才判真失败
    await waitFor(() => expect(windowOpenSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer'));
    // 失败降级：复制预填链接并明确提示已复制可手动打开
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith(BATCH_URL));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringContaining('已复制链接，请手动打开'),
        'error',
      ),
    );
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.stringMatching(/预填页打开失败：shell open denied$/),
      'error',
    );
  });

  it('single fallback opens via native window.open when direct openUrl fails', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockRejectedValue(new Error('Not in Tauri environment'));
    const windowOpenSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({} as unknown as Window);
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(BATCH_URL));
    // 直调失败走原生兜底并成功：window.open 被调用且返回非 null，不抛错
    await waitFor(() =>
      expect(windowOpenSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer'),
    );
    // 兜底成功不报 open_failed
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('预填页打开失败'), 'error');
  });

  it('batch fallback opens via native window.open and reports batch_submitted', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockRejectedValue(new Error('shell open denied'));
    const windowOpenSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({} as unknown as Window);
    const onNotify = vi.fn();
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), draftEntry({ id: 'o/b', status: 'collected' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    await waitFor(() => expect((screen.getByTestId('pending-batch-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(BATCH_URL));
    await waitFor(() =>
      expect(windowOpenSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer'),
    );
    // 兜底成功报 batch_submitted，不报 open_failed
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已批量打开 Issue 预填页'), 'success'),
    );
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('预填页打开失败'), 'error');
  });

  it('batch open failure never reports batch_submitted and keeps selection for retry', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockRejectedValue(new Error('shell open denied'));
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const onNotify = vi.fn();
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), draftEntry({ id: 'o/b', status: 'collected' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    await waitFor(() => expect((screen.getByTestId('pending-batch-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(BATCH_URL));
    await waitFor(() =>
      expect(windowOpenSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer'),
    );
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('预填页打开失败'), 'error'),
    );
    // 打开失败不谎报 batch_submitted
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('已批量打开 Issue 预填页'), 'success');
  });

  it('single over-long prefill URL warns to split batches but still opens', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(PREFILL_URL_LENGTH_LIMIT).toBe(8000);
    const longUrl = `https://example.com/new?body=${'x'.repeat(PREFILL_URL_LENGTH_LIMIT + 100)}`;
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(longUrl);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(longUrl));
    // 超长提示分批（复用 url_too_long 文案）
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('过长'), 'warning'),
    );
  });

  it('batch over-long prefill URL warns to split batches but still opens', async () => {
    await i18n.changeLanguage('zh-CN');
    const longUrl = `https://example.com/new?body=${'y'.repeat(PREFILL_URL_LENGTH_LIMIT + 10)}`;
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(longUrl);

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), draftEntry({ id: 'o/b', status: 'collected' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    await waitFor(() => expect((screen.getByTestId('pending-batch-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(longUrl));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('过长'), 'warning'),
    );
    // 超长仍尝试打开并报 batch_submitted（仅打开失败才不报）
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已批量打开 Issue 预填页'), 'success'),
    );
  });

  it('single over-limit copies the backend payload verbatim and still opens the prefill URL', async () => {
    await i18n.changeLanguage('zh-CN');
    const longUrl = `https://example.com/new?body=${'x'.repeat(PREFILL_URL_LENGTH_LIMIT + 100)}`;
    const payload = '{"id":"o/a","name":"Atlas"}';
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const writeSpy = stubClipboard();
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(longUrl);
    const onGetPrPayload = vi.fn().mockResolvedValue(payload);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onGetPrPayload={onGetPrPayload}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    // 载荷由后端命令产出：回调按 id 取，剪贴板收到的就是原样字符串（前端不改写）
    await waitFor(() => expect(onGetPrPayload).toHaveBeenCalledWith('o/a'));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith(payload));
    expect(writeSpy).not.toHaveBeenCalledWith(longUrl);
    // 复制载荷后仍尝试打开预填页
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(longUrl));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已复制提交载荷'), 'success'),
    );
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('建议分批提交'), 'warning');
  });

  it('batch over-limit copies the backend batch payload and still opens the prefill URL', async () => {
    await i18n.changeLanguage('zh-CN');
    const longUrl = `https://example.com/new?body=${'y'.repeat(PREFILL_URL_LENGTH_LIMIT + 10)}`;
    const payload = '[{"id":"o/a"},{"id":"o/b"}]';
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const writeSpy = stubClipboard();
    const onNotify = vi.fn();
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(longUrl);
    const onGetBatchPrPayload = vi.fn().mockResolvedValue(payload);

    const { container } = render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' }), draftEntry({ id: 'o/b', status: 'collected' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onGetBatchPrPayload={onGetBatchPrPayload}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    const boxA = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/a"]') as HTMLInputElement;
    const boxB = container.querySelector('.pending-list input[type="checkbox"][aria-label="o/b"]') as HTMLInputElement;
    fireEvent.click(boxA);
    fireEvent.click(boxB);
    await waitFor(() => expect((screen.getByTestId('pending-batch-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(onGetBatchPrPayload).toHaveBeenCalledWith(['o/a', 'o/b']));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith(payload));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(longUrl));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已复制提交载荷'), 'success'),
    );
    // 复制载荷即当作本次提交流程继续：打开成功仍报批量已打开
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已批量打开 Issue 预填页'), 'success'),
    );
  });

  it('over-limit without a payload provider falls back to copying the prefill URL', async () => {
    await i18n.changeLanguage('zh-CN');
    const longUrl = `https://example.com/new?body=${'z'.repeat(PREFILL_URL_LENGTH_LIMIT + 50)}`;
    const openSpy = vi.spyOn(tauriApi, 'openUrl').mockResolvedValue(undefined);
    const writeSpy = stubClipboard();
    const onNotify = vi.fn();
    const onGetPrUrl = vi.fn().mockResolvedValue(longUrl);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a', status: 'collected' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('本地收录'));
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 Issue'));

    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith(longUrl));
    // 保留原有超长告警，另加“已复制链接”提示
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('建议分批提交'), 'warning'),
    );
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('已复制 Issue 预填链接'), 'info'),
    );
    expect(onNotify).not.toHaveBeenCalledWith(expect.stringContaining('已复制提交载荷'), 'success');
    // 仍尝试打开
    expect(openSpy).toHaveBeenCalledWith(longUrl);
  });
});
