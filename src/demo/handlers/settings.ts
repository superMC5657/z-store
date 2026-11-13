import type {
  ImportUserDataCounts,
  ProxyTestResult,
} from '../../types';
import { demoTrendsTextForUrl } from '../fixtures';
import { getDemoSettingsSaved, LS, lsSet } from '../demoState';
import { argStr, type InvokeArgs } from './common';

export function handleGetSettings(displayDefaults: {
  ui_scale: string;
  font_size: string;
  theme?: string;
  language?: string;
}): Record<string, string> {
  const result: Record<string, string> = {
    ui_scale: displayDefaults.ui_scale,
    font_size: displayDefaults.font_size,
  };
  if (displayDefaults.theme) {
    result.theme = displayDefaults.theme;
  }
  if (displayDefaults.language) {
    result.language = displayDefaults.language;
  }
  return result;
}

export function handleSaveSetting(a: InvokeArgs): boolean {
  const key = argStr(a, 'key');
  const value = a['value'];
  if (key && typeof value !== 'undefined') {
    const saved = getDemoSettingsSaved();
    saved[key] = String(value);
    lsSet(LS.settings, saved);
  }
  return true;
}

export function handleSwitchMirror(): boolean {
  return true;
}

export function handleTestProxy(): ProxyTestResult {
  return { success: true, latency_ms: 80, message: 'demo' };
}

export function handleFetchTrendsText(a: InvokeArgs): string {
  return demoTrendsTextForUrl(argStr(a, 'url'));
}

export function handleOpenUrl(a: InvokeArgs): null {
  const url = argStr(a, 'url').trim();
  try {
    const native = (window as unknown as { __ZSTORE_DEMO_NATIVE_OPEN__?: typeof window.open })
      .__ZSTORE_DEMO_NATIVE_OPEN__;
    if (url && /^https?:\/\//i.test(url) && typeof native === 'function') {
      native.call(window, url, '_blank', 'noopener,noreferrer');
    }
  } catch {
    // 沙箱环境中执行空操作
  }
  return null;
}

export function handleRegisterDeepLinkScheme(): boolean {
  return true;
}

export function handleGetCliDeepLink(): null {
  return null;
}

export function handleHandleDeepLink(): never {
  throw new Error('demo: deep links are disabled in the live demo');
}

export function handleImportUserData(): ImportUserDataCounts {
  return {
    favorites_added: 0,
    watched_added: 0,
    settings_applied: false,
  };
}

const DEMO_EXPORT_DIR = 'C:\\Users\\Demo\\AppData\\Local\\com.zstore.app\\logs';

export function handleExportBackupFile(a: InvokeArgs): string | null {
  const fileName = argStr(a, 'fileName') || 'export.json';
  return `${DEMO_EXPORT_DIR}\\${fileName}`;
}

export function handleZlogGetDir(): string {
  return DEMO_EXPORT_DIR;
}

export function handleZlogExportBundle(): string | null {
  return `${DEMO_EXPORT_DIR}\\zstore-logs-demo.zip`;
}
