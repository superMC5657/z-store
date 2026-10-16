import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import {
  PENDING_EMPTY_DRAFT,
  PendingView,
  type CustomDraftEntry,
} from './PendingView';
import {
  buildBatchPrPayloadJson,
  buildCustomDraftItemFromSummary,
  buildCustomDraftItemFromTrendRepo,
  buildLocalBatchPrUrl,
  buildLocalSinglePrUrl,
  buildSinglePrPayloadJson,
  CATALOG_PR_ISSUES_URL,
  copyTextToClipboard,
} from '../services/api/catalog';
import type { AppSummary } from '../types';
import type { LicenseAllowlistResult } from '../services/api/catalog';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

const BATCH_URL = 'https://github.com/superMC5657/z-store-catalog/issues/new?title=batch';

// ADR-0018：许可名单唯一源头为后端；组件测试经 onGetLicenseAllowlist 注入快照桩。
const TEST_GATE: LicenseAllowlistResult = {
  enabled: true,
  allowed: ['MIT', 'ISC', 'Apache-2.0', 'GPL-3.0', 'MPL-2.0', 'Unlicense'],
};

function gateProvider(): Promise<LicenseAllowlistResult> {
  return Promise.resolve(TEST_GATE);
}

describe('Lane D PR payload pure helpers (no IPC)', () => {
  it('builds single payload JSON from the entry item', () => {
    const entry = draftEntry({ id: 'o/a' });
    const json = buildSinglePrPayloadJson(entry.item);
    expect(json).toContain('"o/a"');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('builds batch payload JSON array from multiple items', () => {
    const json = buildBatchPrPayloadJson([draftEntry({ id: 'o/a' }).item, draftEntry({ id: 'o/b' }).item]);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('local single prefill URL targets the catalog repo with JSON codeblock + check note', () => {
    const entry = draftEntry({ id: 'o/a' });
    const url = buildLocalSinglePrUrl(entry);
    expect(url.startsWith(CATALOG_PR_ISSUES_URL)).toBe(true);
    expect(url).toContain(encodeURIComponent('o/a'));
    expect(url).toContain('payload_json');
    expect(url).toContain('validate_custom_item');
  });

  it('local batch prefill URL merges ids into one prefilled page', () => {
    const url = buildLocalBatchPrUrl([draftEntry({ id: 'o/a' }), draftEntry({ id: 'o/b' })]);
    expect(url.startsWith(CATALOG_PR_ISSUES_URL)).toBe(true);
    expect(url).toContain(encodeURIComponent('o/a'));
    expect(url).toContain(encodeURIComponent('o/b'));
    expect(url).toContain('payload_json');
  });

  it('copyTextToClipboard resolves a boolean and never throws', async () => {
    await expect(copyTextToClipboard('{"id":"o/a"}')).resolves.toEqual(expect.any(Boolean));
  });
});

describe('PendingView one-click PR submit (Lane D)', () => {
  it('single card submit copies JSON, opens prefill URL and marks submitted', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.fn().mockReturnValue(null);
    vi.spyOn(window, 'open').mockImplementation(openSpy);
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: writeSpy },
      configurable: true,
    });
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    // 选中草稿进入编辑态
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 PR'));

    await waitFor(() => expect(onGetPrUrl).toHaveBeenCalledWith('o/a'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(onMarkSubmitted).toHaveBeenCalledWith('o/a', BATCH_URL));
  });

  it('falls back to the local prefill URL when no backend provider is wired', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.fn().mockReturnValue(null);
    vi.spyOn(window, 'open').mockImplementation(openSpy);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' })]}
        showBatchBar={false}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 PR'));

    await waitFor(() => expect(onMarkSubmitted).toHaveBeenCalledTimes(1));
    const url = onMarkSubmitted.mock.calls[0]?.[1] as string;
    expect(url.startsWith(CATALOG_PR_ISSUES_URL)).toBe(true);
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });

  it('renders the submitted PR link as a back-jump anchor', async () => {
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
    fireEvent.click(screen.getByText('待提交'));
    const link = screen.getByText('https://github.com/x/y/pull/1').closest('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});

describe('PendingView batch submit bar (phase 2, default on but hideable)', () => {
  it('merges selected drafts into one prefill URL and marks each submitted', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.fn().mockReturnValue(null);
    vi.spyOn(window, 'open').mockImplementation(openSpy);
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' }), draftEntry({ id: 'o/b' })]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    expect(screen.getByTestId('pending-batch-bar')).toBeTruthy();

    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() => expect(onGetBatchPrUrl).toHaveBeenCalledWith(['o/a', 'o/b']));
    expect(openSpy).toHaveBeenCalledWith(BATCH_URL, '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(onMarkSubmitted).toHaveBeenCalledTimes(2));
    expect(onMarkSubmitted).toHaveBeenCalledWith('o/a', BATCH_URL);
    expect(onMarkSubmitted).toHaveBeenCalledWith('o/b', BATCH_URL);
  });

  it('hides the batch bar when showBatchBar is false', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a' })]} onGetLicenseAllowlist={gateProvider} />);
    expect(screen.queryByTestId('pending-batch-bar')).toBeNull();
  });

  it('switches one-click PR copy between Chinese and English', async () => {
    await i18n.changeLanguage('en-US');
    render(<PendingView showBatchBar={false} initialEntries={[draftEntry({ id: 'o/a' })]} onGetLicenseAllowlist={gateProvider} />);
    fireEvent.click(screen.getByText('o/a'));
    expect(screen.getByText('Submit PR')).toBeTruthy();
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

  it('single submit is blocked on placeholder license and toast points at the license field', async () => {
    await i18n.changeLanguage('zh-CN');
    const openSpy = vi.fn().mockReturnValue(null);
    vi.spyOn(window, 'open').mockImplementation(openSpy);
    const onGetPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    const placeholder = draftEntry({ id: 'o/a' });
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
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 PR'));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringContaining('SPDX'),
        'warning',
      ),
    );
    expect(onGetPrUrl).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onMarkSubmitted).not.toHaveBeenCalled();
  });

  it('batch submit is blocked naming the invalid drafts', async () => {
    await i18n.changeLanguage('zh-CN');
    const bad = draftEntry({ id: 'o/b' });
    bad.item.license = 'OpenSource';
    const onGetBatchPrUrl = vi.fn().mockResolvedValue(BATCH_URL);
    const onMarkSubmitted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    render(
      <PendingView
        initialEntries={[draftEntry({ id: 'o/a' }), bad]}
        onGetBatchPrUrl={onGetBatchPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onNotify={onNotify}
        onGetLicenseAllowlist={gateProvider}
      />,
    );
    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByTestId('pending-batch-submit'));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('o/b'), 'warning'),
    );
    expect(onGetBatchPrUrl).not.toHaveBeenCalled();
    expect(onMarkSubmitted).not.toHaveBeenCalled();
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
        initialEntries={[draftEntry({ id: 'o/a' })]}
        showBatchBar={false}
        onGetPrUrl={onGetPrUrl}
        onMarkSubmitted={onMarkSubmitted}
        onNotify={onNotify}
      />,
    );
    // 故意不传 onGetLicenseAllowlist：非 Tauri 单测环境默认拉取失败，
    // 提交必须提示重试且不开页不标记，绝不回退写死名单。
    fireEvent.click(screen.getByText('o/a'));
    fireEvent.click(screen.getByText('提交 PR'));

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
    // 页眉新建按钮与右侧空选提示各有一处“新建草稿”，点页眉首个。
    fireEvent.click(screen.getAllByText('新建草稿')[0]!);
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
