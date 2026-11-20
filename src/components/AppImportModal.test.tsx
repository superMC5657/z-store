/** 测试系统应用导入确认弹窗的置信度默认勾选与提交载荷构造。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppMatchResult, ImportAppRequest } from '../types';
import i18n from '../i18n';

const hooks = vi.hoisted(() => ({
  scan: vi.fn<() => Promise<AppMatchResult[]>>(),
  importApps: vi.fn<(apps: ImportAppRequest[]) => Promise<number>>(),
}));

vi.mock('../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'scanAndMatchLocalApps') return () => hooks.scan();
        if (prop === 'importMatchedApps') return (apps: ImportAppRequest[]) => hooks.importApps(apps);
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

import { AppImportModal } from './AppImportModal';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function match(
  id: string,
  name: string,
  localName: string,
  confidence: number,
  tier: AppMatchResult['confidence_tier'],
  reasons: string[],
  extra: Partial<AppMatchResult['scanned']> = {},
): AppMatchResult {
  const [owner, repo] = id.split('/');
  return {
    scanned: {
      display_name: localName,
      display_version: '1.0.1',
      install_location: `C:\\Program Files\\${name}`,
      uninstall_string: `"C:\\Program Files\\${name}\\uninstall.exe"`,
      installed_at: 1_700_000_000,
      ...extra,
    },
    catalog_id: id,
    name,
    owner,
    repo,
    icon: '📦',
    icon_bg: '',
    description: '',
    local_version: '1.0.1',
    catalog_version: '1.2.0',
    confidence,
    confidence_tier: tier,
    resolved_executable_path: `C:\\Program Files\\${name}\\${repo}.exe`,
    match_reasons: reasons,
  };
}

const RESULTS: AppMatchResult[] = [
  match('microsoft/vscode', 'VS Code', 'Microsoft Visual Studio Code (User)', 1, 'high', [
    'exact_name',
    'executable',
    'publisher',
    'version',
  ], { publisher: 'Microsoft Corporation' }),
  match('obsproject/obs-studio', 'OBS Studio', 'OBS Studio', 0.92, 'high', ['exact_name', 'executable']),
  match('desktop/desktop', 'GitHub Desktop', 'GitHub Desktop', 0.62, 'medium', ['exact_name', 'unknown_reason']),
  match('siyuan-note/siyuan', 'SiYuan', '思源笔记', 0.48, 'low', ['executable']),
];

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: 'span' }).closest('.fluent-list-row');
  if (!row) throw new Error(`row for ${name} not found`);
  return row as HTMLElement;
}

function checkboxOf(name: string): HTMLInputElement {
  return rowOf(name).querySelector('input[type="checkbox"]') as HTMLInputElement;
}

async function renderModal() {
  hooks.scan.mockResolvedValue(RESULTS);
  const onImportSuccess = vi.fn();
  const onClose = vi.fn();
  render(<AppImportModal isOpen onClose={onClose} onImportSuccess={onImportSuccess} />);
  await waitFor(() => expect(screen.getByText('VS Code', { selector: 'span' })).toBeTruthy());
  return { onImportSuccess, onClose };
}

describe('AppImportModal', () => {
  it('pre-checks only high-confidence matches and lets the user toggle the rest', async () => {
    await renderModal();
    expect(checkboxOf('VS Code').checked).toBe(true);
    expect(checkboxOf('OBS Studio').checked).toBe(true);
    expect(checkboxOf('GitHub Desktop').checked).toBe(false);
    expect(checkboxOf('SiYuan').checked).toBe(false);

    fireEvent.click(rowOf('GitHub Desktop'));
    expect(checkboxOf('GitHub Desktop').checked).toBe(true);
  });

  it('shows the locally detected name only when it differs from the catalog name', async () => {
    await renderModal();
    const vscodeDetected = i18n.t('import_modal.detected_name', {
      name: 'Microsoft Visual Studio Code (User)',
    });
    expect(rowOf('VS Code').textContent).toContain(vscodeDetected);
    expect(rowOf('VS Code').textContent).toContain(
      i18n.t('import_modal.detected_publisher', { publisher: 'Microsoft Corporation' }),
    );
    const obsDetected = i18n.t('import_modal.detected_name', { name: 'OBS Studio' });
    expect(rowOf('OBS Studio').textContent).not.toContain(obsDetected);
  });

  it('renders known match reasons, caps them, and warns on low confidence', async () => {
    await renderModal();
    const vscodeReasons = [...rowOf('VS Code').querySelectorAll('[data-reason]')].map(
      (el) => el.getAttribute('data-reason'),
    );
    expect(vscodeReasons).toEqual(['exact_name', 'executable', 'publisher']);
    expect(rowOf('VS Code').textContent).toContain(i18n.t('import_modal.reasons.executable'));

    const desktopReasons = [...rowOf('GitHub Desktop').querySelectorAll('[data-reason]')].map(
      (el) => el.getAttribute('data-reason'),
    );
    expect(desktopReasons).toEqual(['exact_name']);

    const hint = i18n.t('import_modal.low_confidence_hint');
    expect(rowOf('SiYuan').textContent).toContain(hint);
    expect(rowOf('SiYuan').querySelector('[data-tier="low"]')).toBeTruthy();
    expect(rowOf('GitHub Desktop').querySelector('[data-tier="medium"]')).toBeTruthy();
    expect(rowOf('GitHub Desktop').textContent).not.toContain(hint);
  });

  it('imports the selected matches as ImportAppRequest payloads', async () => {
    hooks.importApps.mockResolvedValue(3);
    const { onImportSuccess } = await renderModal();
    fireEvent.click(rowOf('SiYuan'));
    fireEvent.click(screen.getByText(i18n.t('import_modal.import_btn')));

    await waitFor(() => expect(hooks.importApps).toHaveBeenCalledTimes(1));
    const payload = hooks.importApps.mock.calls[0][0];
    expect(payload.map((p) => p.app_id)).toEqual([
      'microsoft/vscode',
      'obsproject/obs-studio',
      'siyuan-note/siyuan',
    ]);
    expect(payload[2]).toEqual({
      app_id: 'siyuan-note/siyuan',
      app_name: 'SiYuan',
      version: '1.0.1',
      install_path: 'C:\\Program Files\\SiYuan\\siyuan.exe',
      uninstall_command: '"C:\\Program Files\\SiYuan\\uninstall.exe"',
      installed_at: 1_700_000_000,
    });
    await waitFor(() => expect(onImportSuccess).toHaveBeenCalledWith(3));
  });
});
