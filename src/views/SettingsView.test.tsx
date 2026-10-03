/**
 * P3-3 信任阻尼 — 自定义应用收录源需经过二次破坏性确认。
 *
 * - 保存非默认（自定义）catalog_source_url 时，首先进入确认步骤（高危“确认切换” + 警告），
 *   此时尚未持久化；确认后方才持久化该自定义 URL。
 * - 保存为空值（= 官方默认源流）立即生效。
 * - 取消确认会直接丢弃改动而不予持久化。
 * - 重新保存当前已生效的相同自定义 URL 立即应用（无改动）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';

vi.mock('../services/api', () => {
  // B3-G12：View 统一经 tauriApi 调用；此处 mock 同时提供历史别名 api。
  const tauriApi = {
    syncCatalog: async () => ({ updated: false, count: 0, message: 'ok' }),
    selectFolder: async () => null,
    testProxy: async () => ({ success: true, latency_ms: 10, message: 'ok' }),
  };
  return { api: tauriApi, tauriApi };
});
vi.mock('../components/ClientUpdateRow', () => ({ ClientUpdateRow: () => null }));
vi.mock('../components/OAuthAccountCard', () => ({ OAuthAccountCard: () => null }));
vi.mock('../components/DataBackupRow', () => ({ DataBackupRow: () => null }));

import { SettingsView } from './SettingsView';
import type { AppSettings } from '../types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

function baseSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    theme: 'dark',
    language: 'zh-CN',
    ui_scale: '100',
    font_size: '14',
    portable_dir: '%LOCALAPPDATA%\Programs\z-store-apps',
    download_dir: '~/Downloads',
    active_mirror: 'direct',
    launch_on_startup: false,
    update_frequency: 'startup',
    detail_cache_ttl_minutes: 30,
    catalog_source_url: '',
    watch_notify_frequency: 'daily',
    ...overrides,
  };
}

interface SavedCall {
  key: keyof AppSettings;
  value: unknown;
}

function renderSettings(settings: AppSettings) {
  const calls: SavedCall[] = [];
  const onUpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    calls.push({ key, value });
  };
  render(
    <SettingsView
      onSelectMirror={async () => undefined}
      theme="dark"
      onSetTheme={() => undefined}
      onExportAppsJson={() => undefined}
      settings={settings}
      onUpdateSetting={onUpdateSetting}
      installedCount={0}
      updateRulesCount={0}
      onOpenRules={() => undefined}
    />,
  );
  return { calls };
}

function expandCustomSource() {
  fireEvent.click(screen.getByText('自定义源'));
  return screen.getByPlaceholderText('https://.../catalog.json');
}

describe('SettingsView custom catalog source confirm', () => {
  it('custom URL arms a destructive confirm first and persists only on confirm', () => {
    const { calls } = renderSettings(baseSettings());
    const input = expandCustomSource();
    fireEvent.change(input, { target: { value: 'https://evil.example.com/catalog.json' } });
    fireEvent.click(screen.getByText('保存源'));

    expect(calls).toHaveLength(0);
    expect(screen.getByText('确认切换')).toBeTruthy();
    expect(screen.getByText(/自定义源将替换官方可信收录目录/)).toBeTruthy();

    fireEvent.click(screen.getByText('确认切换'));
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('catalog_source_url');
    expect(calls[0].value).toBe('https://evil.example.com/catalog.json');
  });

  it('empty input (official default flow) saves immediately with no confirm', () => {
    const { calls } = renderSettings(baseSettings());
    expandCustomSource();
    fireEvent.click(screen.getByText('保存源'));

    expect(calls).toHaveLength(1);
    expect(calls[0].value).toBe('');
    expect(screen.queryByText('确认切换')).toBeNull();
  });

  it('cancelling the confirm discards without persisting', () => {
    const { calls } = renderSettings(baseSettings());
    const input = expandCustomSource();
    fireEvent.change(input, { target: { value: 'https://evil.example.com/catalog.json' } });
    fireEvent.click(screen.getByText('保存源'));
    expect(screen.getByText('确认切换')).toBeTruthy();

    fireEvent.click(screen.getByText('取消'));
    expect(calls).toHaveLength(0);
    expect(screen.queryByText('确认切换')).toBeNull();
  });

  it('re-saving the already-active custom URL applies immediately (no change)', () => {
    const custom = 'https://mirror.example.com/catalog.json';
    const { calls } = renderSettings(baseSettings({ catalog_source_url: custom }));
    expandCustomSource();
    fireEvent.click(screen.getByText('保存源'));

    expect(calls).toHaveLength(1);
    expect(calls[0].value).toBe(custom);
    expect(screen.queryByText('确认切换')).toBeNull();
  });

  it('allows switching interface language between zh-CN and en-US', () => {
    const { calls } = renderSettings(baseSettings({ language: 'zh-CN' }));
    const enBtn = screen.getByText('English');
    fireEvent.click(enBtn);

    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('language');
    expect(calls[0].value).toBe('en-US');
  });

  it('renders settings rows in English when en-US is active', async () => {
    await i18n.changeLanguage('en-US');
    renderSettings(baseSettings({ language: 'en-US', active_mirror: 'https://gh-proxy.com' }));

    // 外观设置行
    expect(screen.getByText('Theme Mode')).toBeTruthy();

    // 网络与代理设置行
    expect(screen.getByText('GitHub Download Proxy')).toBeTruthy();

    // 数据备份设置行
    expect(screen.getByText('Export Managed Apps')).toBeTruthy();
    expect(screen.getByText('Export List')).toBeTruthy();

    // 更新与通知设置行
    expect(screen.getByText('Auto Check Updates')).toBeTruthy();
    expect(screen.getByText('Version Pin & Ignore Rules')).toBeTruthy();
  });
});
