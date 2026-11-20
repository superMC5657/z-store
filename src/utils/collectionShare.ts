import type { AppSummary, CollectionModalData } from '../types';
import { canonicalAppId } from '../services/normalizeId';
import { buildAppRepoUrl, getAppDescription } from './appHelper';

export const COLLECTION_MAX_APPS = 30;
export const COLLECTION_DEFAULT_PRESELECT = 15;
export const COLLECTION_MAX_DEEPLINK_LEN = 2048;
export const COLLECTION_WARN_DEEPLINK_LEN = 1900;
export const COLLECTION_TITLE_MAX_CHARS = 60;
export const COLLECTION_NOTE_MAX_CHARS = 140;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

export interface BuildCollectionDeepLinkInput {
  title: string;
  note?: string;
  appIds: readonly string[];
}

export interface BuildCollectionDeepLinkResult {
  url: string;
  length: number;
  exceedsMaxLen: boolean;
  nearMaxLen: boolean;
  appIds: string[];
}

/** 剥除控制字符、折叠空白并按 Unicode 码点截断（与后端深链清洗同口径）。 */
export function sanitizeCollectionText(raw: string, maxChars: number): string {
  const withSpaces = raw.replace(/[\r\n\t]+/g, ' ');
  let stripped = '';
  for (const ch of withSpaces) {
    const code = ch.codePointAt(0) ?? 0;
    const isCtrl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isCtrl) stripped += ch;
  }
  const collapsed = stripped.trim().replace(/\s+/g, ' ');
  return Array.from(collapsed).slice(0, maxChars).join('');
}

/** 归一化、去重并截取最多 30 条规范应用坐标。 */
export function normalizeCollectionAppIds(appIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of appIds) {
    const canon = canonicalAppId(raw);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
    if (out.length >= COLLECTION_MAX_APPS) break;
  }
  return out;
}

/** 构建 `zstore://collection?...` 分享深链并测算 2048 字节协议上限余量。 */
export function buildCollectionDeepLink({
  title,
  note = '',
  appIds,
}: BuildCollectionDeepLinkInput): BuildCollectionDeepLinkResult {
  const cleanIds = normalizeCollectionAppIds(appIds);
  if (cleanIds.length === 0) {
    return {
      url: '',
      length: 0,
      exceedsMaxLen: false,
      nearMaxLen: false,
      appIds: [],
    };
  }

  const encodedIds = cleanIds
    .map((id) => encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':'))
    .join(',');

  const params: string[] = [`ids=${encodedIds}`];
  const cleanTitle = sanitizeCollectionText(title, COLLECTION_TITLE_MAX_CHARS);
  if (cleanTitle) {
    params.push(`title=${encodeURIComponent(cleanTitle)}`);
  }
  const cleanNote = sanitizeCollectionText(note, COLLECTION_NOTE_MAX_CHARS);
  if (cleanNote) {
    params.push(`note=${encodeURIComponent(cleanNote)}`);
  }

  const url = `zstore://collection?${params.join('&')}`;
  const length = utf8ByteLength(url);
  return {
    url,
    length,
    exceedsMaxLen: length > COLLECTION_MAX_DEEPLINK_LEN,
    nearMaxLen: length >= COLLECTION_WARN_DEEPLINK_LEN,
    appIds: cleanIds,
  };
}

function decodeDeepLinkPayload(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('%00')) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return raw.includes('\0') ? null : raw;
  }
}

/** 解析 `zstore://collection?...` 或 `zstore://collection/{ids}`（与后端 `deeplink.rs` 同口径）。 */
export function parseCollectionDeepLink(rawUrl: string): CollectionModalData | null {
  const s = rawUrl.trim();
  if (!s || utf8ByteLength(s) > COLLECTION_MAX_DEEPLINK_LEN || s.includes('\0')) return null;
  if (s.slice(0, 9).toLowerCase() !== 'zstore://') return null;

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
  const rawIdSegments: string[] = [];
  const trimmedPathIds = pathIds.trim();
  if (trimmedPathIds) rawIdSegments.push(trimmedPathIds);

  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) {
        if (decodeDeepLinkPayload(pair) === null) return null;
        continue;
      }
      const k = decodeDeepLinkPayload(pair.slice(0, eq));
      if (k === null) return null;
      const rawV = pair.slice(eq + 1);
      if (k === 'ids') {
        rawIdSegments.push(rawV);
      } else if (k === 'title') {
        const decoded = decodeDeepLinkPayload(rawV.replace(/\+/g, ' '));
        if (decoded === null) return null;
        title = sanitizeCollectionText(decoded, COLLECTION_TITLE_MAX_CHARS);
      } else if (k === 'note') {
        const decoded = decodeDeepLinkPayload(rawV.replace(/\+/g, ' '));
        if (decoded === null) return null;
        const cleaned = sanitizeCollectionText(decoded, COLLECTION_NOTE_MAX_CHARS);
        note = cleaned || null;
      } else if (decodeDeepLinkPayload(rawV) === null) {
        return null;
      }
    }
  }

  const decodedPieces: string[] = [];
  for (const seg of rawIdSegments) {
    const decoded = decodeDeepLinkPayload(seg);
    if (decoded === null) return null;
    decodedPieces.push(...decoded.split(','));
  }
  const appIds = normalizeCollectionAppIds(decodedPieces);
  if (appIds.length === 0) return null;

  return {
    title,
    note,
    app_ids: appIds,
  };
}

/** 转义 Markdown 表格单元格中的 `|` 与换行/控制字符，防止破坏表格列结构。 */
export function escapeMarkdownCell(raw: string): string {
  const clean = sanitizeCollectionText(raw, 500);
  return clean.replace(/\|/g, '\\|');
}

export interface BuildCollectionMarkdownInput {
  title: string;
  note?: string;
  apps: readonly AppSummary[];
  deepLinkUrl: string;
  locale?: string;
  fallbackHeading?: string;
}

/** 生成排版规范的 Markdown 推荐清单（含表格与 `zstore://collection` 一键打开提示）。 */
export function buildCollectionMarkdown({
  title,
  note = '',
  apps,
  deepLinkUrl,
  locale = 'zh-CN',
  fallbackHeading,
}: BuildCollectionMarkdownInput): string {
  const isZh = !locale || locale.startsWith('zh');
  const cleanTitle =
    sanitizeCollectionText(title, COLLECTION_TITLE_MAX_CHARS) ||
    sanitizeCollectionText(fallbackHeading ?? '', COLLECTION_TITLE_MAX_CHARS) ||
    (isZh ? '开源应用推荐清单' : 'Recommended Open-Source Apps');
  const cleanNote = sanitizeCollectionText(note, COLLECTION_NOTE_MAX_CHARS);

  const lines: string[] = [`# ${cleanTitle}`];
  if (cleanNote) {
    lines.push('', `> ${cleanNote}`);
  }

  lines.push(
    '',
    isZh
      ? '| 应用 | 仓库 | 协议 | 简介 |'
      : '| App | Repository | License | Description |',
    '| --- | --- | --- | --- |',
  );

  for (const app of apps.slice(0, COLLECTION_MAX_APPS)) {
    const appName = escapeMarkdownCell(app.name || app.repo || app.id);
    const coordLabel = escapeMarkdownCell(
      app.owner && app.repo ? `${app.owner}/${app.repo}` : app.id,
    );
    const repoUrl = buildAppRepoUrl(app);
    const repoCell = repoUrl ? `[${coordLabel}](${repoUrl})` : coordLabel;
    const licenseCell = escapeMarkdownCell(app.license || '-') || '-';
    const descCell = escapeMarkdownCell(getAppDescription(app, locale)) || '-';
    lines.push(`| ${appName} | ${repoCell} | ${licenseCell} | ${descCell} |`);
  }

  const safeDeepLinkUrl =
    deepLinkUrl && utf8ByteLength(deepLinkUrl) <= COLLECTION_MAX_DEEPLINK_LEN ? deepLinkUrl : '';
  if (safeDeepLinkUrl) {
    lines.push(
      '',
      isZh
        ? `> 在 ZStore 客户端中打开此合集预览与批量安装：\`${safeDeepLinkUrl}\``
        : `> Open in ZStore to preview and batch install: \`${safeDeepLinkUrl}\``,
    );
  }

  return lines.join('\n');
}
