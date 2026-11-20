import type {
  DeepLinkAction,
  ImportUserDataCounts,
  ProxyTestResult,
} from '../../types';
import { demoTrendsTextForUrl } from '../fixtures';
import { getDemoSettingsSaved, LS, lsSet } from '../demoState';
import { canonicalAppId } from '../../services/normalizeId';
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

function decodeDemoPayload(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return raw.includes('\0') ? null : raw;
  }
}

function sanitizeDemoCollectionText(raw: string, maxChars: number): string {
  let stripped = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isCtrl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isCtrl) stripped += ch;
  }
  const collapsed = stripped.trim().replace(/\s+/g, ' ');
  return Array.from(collapsed).slice(0, maxChars).join('');
}

function parseDemoCollectionDeepLink(rawUrl: string): DeepLinkAction | null {
  const s = rawUrl.trim();
  if (!s || s.length > 2048 || s.includes('\0')) return null;
  if (!s.slice(0, 9).toLowerCase().startsWith('zstore://')) return null;
  const afterScheme = s.slice(9).replace(/^\/+/, '');
  const qIdx = afterScheme.indexOf('?');
  const pathPart = (qIdx >= 0 ? afterScheme.slice(0, qIdx) : afterScheme).replace(/\/+$/, '');
  const queryPart = qIdx >= 0 ? afterScheme.slice(qIdx + 1) : '';
  const lowerPath = pathPart.toLowerCase();
  let pathIds = '';
  if (lowerPath === 'collection') {
    pathIds = '';
  } else if (lowerPath.startsWith('collection/')) {
    pathIds = pathPart.slice('collection/'.length);
  } else {
    return null;
  }

  let title = '';
  let note: string | null = null;
  const idSegments: string[] = [];
  if (pathIds.trim()) idSegments.push(pathIds.trim());

  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) {
        if (decodeDemoPayload(pair) === null) return null;
        continue;
      }
      const k = decodeDemoPayload(pair.slice(0, eq));
      if (k === null) return null;
      const rawV = pair.slice(eq + 1);
      if (k === 'ids') {
        idSegments.push(rawV);
      } else if (k === 'title') {
        const decoded = decodeDemoPayload(rawV.replace(/\+/g, ' '));
        if (decoded === null) return null;
        title = sanitizeDemoCollectionText(decoded, 60);
      } else if (k === 'note') {
        const decoded = decodeDemoPayload(rawV.replace(/\+/g, ' '));
        if (decoded === null) return null;
        const cleaned = sanitizeDemoCollectionText(decoded, 140);
        note = cleaned ? cleaned : null;
      } else if (decodeDemoPayload(rawV) === null) {
        return null;
      }
    }
  }

  const seen = new Set<string>();
  const appIds: string[] = [];
  for (const seg of idSegments) {
    const decoded = decodeDemoPayload(seg);
    if (decoded === null) return null;
    for (const piece of decoded.split(',')) {
      const canon = canonicalAppId(piece);
      if (canon && !seen.has(canon)) {
        seen.add(canon);
        appIds.push(canon);
        if (appIds.length >= 30) break;
      }
    }
    if (appIds.length >= 30) break;
  }
  if (appIds.length === 0) return null;
  return {
    action: 'collection',
    payload: {
      title,
      note,
      app_ids: appIds,
    },
  };
}

export function handleHandleDeepLink(a?: InvokeArgs): DeepLinkAction {
  const url = a ? argStr(a, 'url') : '';
  const collection = parseDemoCollectionDeepLink(url);
  if (collection) return collection;
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
