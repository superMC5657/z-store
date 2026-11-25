import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '../../i18n';
import type { LaunchpadPreflightResult, OAuthUser } from '../../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const api = vi.hoisted(() => ({
  preflightLaunchpadSubmission: vi.fn(),
  openUrl: vi.fn(async (_url: string) => undefined),
}));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) =>
        prop in api ? api[prop as keyof typeof api] : (target as Record<string | symbol, unknown>)[prop],
    }),
  };
});

import { LaunchpadSubmitModal } from './LaunchpadSubmitModal';

const PASS_RESULT: LaunchpadPreflightResult = {
  ok: true,
  canonical_id: 'acme/hyper-term',
  forge: 'github',
  forge_host: 'github.com',
  owner: 'acme',
  repo: 'hyper-term',
  repo_name: 'HyperTerm',
  description: 'GPU terminal',
  homepage: 'https://hyper.example.dev',
  license: 'MIT',
  latest_version: 'v1.2.0',
  platforms: ['windows', 'linux'],
  installable_asset_count: 2,
  has_checksum_manifest: true,
  resolved_icon_url: 'https://cdn.simpleicons.org/hyper',
  stars: 420,
  forks: 30,
  maker_avatar_url: 'https://github.com/acme.png',
  already_in_launchpad: false,
  already_in_catalog: false,
  checks: [
    { key: 'coord', status: 'pass', detail: '仓库可达：acme/hyper-term' },
    { key: 'duplicate', status: 'pass', detail: '未在开源广场或精选目录发现重复条目' },
    { key: 'license', status: 'pass', detail: 'OSI 开源协议校验通过：MIT' },
    { key: 'release', status: 'pass', detail: 'v1.2.0 含 2 个可安装资产' },
    { key: 'icon', status: 'pass', detail: '已自动探测到仓库图标' },
  ],
};

const FAIL_RESULT: LaunchpadPreflightResult = {
  ...PASS_RESULT,
  ok: false,
  license: 'NOASSERTION',
  checks: [
    { key: 'coord', status: 'pass', detail: '仓库可达：acme/hyper-term' },
    { key: 'license', status: 'fail', detail: '未检测到明确的 OSI SPDX 协议（NOASSERTION）' },
  ],
};

const USER: OAuthUser = {
  login: 'acme',
  has_list_scope: true,
  is_expired: false,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => cleanup());

describe('LaunchpadSubmitModal', () => {
  it('runs preflight, updates live LaunchpadCard preview, and opens pre-filled issue URL when passed', async () => {
    api.preflightLaunchpadSubmission.mockResolvedValueOnce(PASS_RESULT);
    const onClose = vi.fn();

    render(
      <LaunchpadSubmitModal
        submitIssueUrl="https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml"
        oauthUser={USER}
        onClose={onClose}
      />,
    );

    const submitBtn = screen.getByTestId('launchpad-submit-confirm') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Quick-fill current login prefix
    fireEvent.click(screen.getByTestId('launchpad-wizard-fill-login'));
    const repoInput = screen.getByLabelText(/开源仓库地址/) as HTMLInputElement;
    expect(repoInput.value).toBe('@acme/');

    fireEvent.change(repoInput, { target: { value: 'acme/hyper-term' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-preflight-run'));
    });

    await waitFor(() => expect(screen.getByTestId('launchpad-preflight-checks')).toBeTruthy());
    expect(api.preflightLaunchpadSubmission).toHaveBeenCalledWith('acme/hyper-term', undefined);
    expect(screen.getByText('OSI 开源协议校验通过：MIT')).toBeTruthy();

    // App name auto-filled from preflight repo_name
    const appNameInput = screen.getByLabelText(/应用名称/) as HTMLInputElement;
    expect(appNameInput.value).toBe('HyperTerm');

    // Fill maker_note and switch tier to spotlight-7d -> live LaunchpadCard shows Spotlight tag
    const noteInput = screen.getByLabelText(/一句话自荐语/);
    fireEvent.change(noteInput, { target: { value: '重写了 WebGPU 渲染管线。' } });
    fireEvent.change(screen.getByLabelText(/上架档位/), { target: { value: 'spotlight-7d' } });

    // Dropdowns share the app-wide select styles so native option lists follow the theme
    for (const select of [screen.getByLabelText(/功能分类/), screen.getByLabelText(/上架档位/)]) {
      expect(select.tagName).toBe('SELECT');
      expect(select.className).toContain('select-fluent');
    }

    const preview = screen.getByTestId('launchpad-wizard-preview');
    expect(within(preview).getByText('HyperTerm')).toBeTruthy();
    expect(within(preview).getByText('重写了 WebGPU 渲染管线。')).toBeTruthy();
    expect(within(preview).getByText('置顶推荐')).toBeTruthy();

    expect(submitBtn.disabled).toBe(false);

    fireEvent.click(submitBtn);
    expect(api.openUrl).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(api.openUrl.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('template')).toBe('submit-launchpad.yml');
    expect(openedUrl.searchParams.get('repo_url')).toBe('https://github.com/acme/hyper-term');
    expect(openedUrl.searchParams.get('app_name')).toBe('HyperTerm');
    expect(openedUrl.searchParams.get('maker_note')).toBe('重写了 WebGPU 渲染管线。');
    expect(openedUrl.searchParams.get('launch_tier')).toMatch(/^spotlight-7d\b/);
    expect(openedUrl.searchParams.get('custom_icon_url')).toBe('https://cdn.simpleicons.org/hyper');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps submit button disabled when preflight fails or maker_note contains newlines', async () => {
    api.preflightLaunchpadSubmission
      .mockResolvedValueOnce(FAIL_RESULT)
      .mockResolvedValueOnce(PASS_RESULT);

    render(<LaunchpadSubmitModal onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/开源仓库地址/), { target: { value: 'acme/hyper-term' } });
    fireEvent.change(screen.getByLabelText(/应用名称/), { target: { value: 'HyperTerm' } });
    fireEvent.change(screen.getByLabelText(/一句话自荐语/), { target: { value: '有效自荐语' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-preflight-run'));
    });

    await waitFor(() =>
      expect(screen.getByText('未检测到明确的 OSI SPDX 协议（NOASSERTION）')).toBeTruthy(),
    );
    const submitBtn = screen.getByTestId('launchpad-submit-confirm') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(api.openUrl).not.toHaveBeenCalled();

    // Pass preflight, then enter multiline note -> blocked by validation
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-preflight-run'));
    });
    await waitFor(() => expect(submitBtn.disabled).toBe(false));

    fireEvent.change(screen.getByLabelText(/一句话自荐语/), {
      target: { value: '第一行\n第二行' },
    });
    expect(screen.getByText('自荐语必须为单行，不能包含换行符')).toBeTruthy();
    expect(submitBtn.disabled).toBe(true);
  });

  it('uses preflight resolved_icon_url when custom_icon_url fails D8 check and falls back', async () => {
    api.preflightLaunchpadSubmission.mockResolvedValueOnce({
      ...PASS_RESULT,
      resolved_icon_url: 'https://cdn.simpleicons.org/hyper',
      checks: [
        ...PASS_RESULT.checks.filter((c) => c.key !== 'icon'),
        { key: 'icon', status: 'warn', detail: '自定义图标直链不可用或非有效图片，已回落自动探测图标' },
      ],
    });
    const onClose = vi.fn();
    render(
      <LaunchpadSubmitModal
        submitIssueUrl="https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml"
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText(/开源仓库地址/), { target: { value: 'acme/hyper-term' } });
    fireEvent.change(screen.getByLabelText(/自定义图标/), {
      target: { value: 'https://example.com/broken.png' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('launchpad-preflight-run'));
    });

    await waitFor(() => expect(screen.getByTestId('launchpad-preflight-checks')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/一句话自荐语/), { target: { value: '有效自荐语' } });

    const submitBtn = screen.getByTestId('launchpad-submit-confirm') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    fireEvent.click(submitBtn);

    expect(api.openUrl).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(api.openUrl.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('custom_icon_url')).toBe('https://cdn.simpleicons.org/hyper');
    expect(openedUrl.searchParams.has('homepage')).toBe(false);
  });

  it('预检在途期间用户输入的应用名不会被异步回包 repo_name 覆盖（F-39a）', async () => {
    let resolvePreflight!: (v: LaunchpadPreflightResult) => void;
    api.preflightLaunchpadSubmission.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePreflight = resolve; }),
    );
    render(<LaunchpadSubmitModal onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/开源仓库地址/), { target: { value: 'acme/hyper' } });
    fireEvent.click(screen.getByTestId('launchpad-preflight-run'));

    // 预检进行中，用户手动输入自定义应用名
    const nameInput = screen.getByLabelText(/应用名称/) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'My Custom Name' } });

    await act(async () => {
      resolvePreflight({ ...PASS_RESULT, repo_name: 'hyper-from-github' });
      await Promise.resolve();
    });

    expect(nameInput.value).toBe('My Custom Name');
  });
});
