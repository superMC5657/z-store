import type { AppSummary } from '../types';
import { formatPlatformLabels } from '../lib/platformFilter';
import { canonicalAppId } from '../services/normalizeId';
import { buildAppRepoUrl, getAppDescription } from './appHelper';

export const COLLECTION_MAX_APPS = 30;
export const COLLECTION_DEFAULT_PRESELECT = 15;
export const COLLECTION_MAX_DEEPLINK_LEN = 2048;
export const COLLECTION_WARN_DEEPLINK_LEN = 1900;
export const COLLECTION_TITLE_MAX_CHARS = 60;
export const COLLECTION_NOTE_MAX_CHARS = 140;

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
  const length = new TextEncoder().encode(url).length;
  return {
    url,
    length,
    exceedsMaxLen: length > COLLECTION_MAX_DEEPLINK_LEN,
    nearMaxLen: length >= COLLECTION_WARN_DEEPLINK_LEN,
    appIds: cleanIds,
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
}

/** 生成排版规范的 Markdown 推荐清单（含表格与 `zstore://collection` 一键打开提示）。 */
export function buildCollectionMarkdown({
  title,
  note = '',
  apps,
  deepLinkUrl,
  locale = 'zh-CN',
}: BuildCollectionMarkdownInput): string {
  const isZh = !locale || locale.startsWith('zh');
  const cleanTitle =
    sanitizeCollectionText(title, COLLECTION_TITLE_MAX_CHARS) ||
    (isZh ? '开源应用推荐清单' : 'Recommended Open-Source Apps');
  const cleanNote = sanitizeCollectionText(note, COLLECTION_NOTE_MAX_CHARS);

  const lines: string[] = [`# ${cleanTitle}`];
  if (cleanNote) {
    lines.push('', `> ${cleanNote}`);
  }

  lines.push(
    '',
    isZh
      ? '| 应用 | 仓库 | 协议 | 平台 | 简介 |'
      : '| App | Repository | License | Platforms | Description |',
    '| --- | --- | --- | --- | --- |',
  );

  for (const app of apps.slice(0, COLLECTION_MAX_APPS)) {
    const appName = escapeMarkdownCell(app.name || app.repo || app.id);
    const coordLabel = escapeMarkdownCell(
      app.owner && app.repo ? `${app.owner}/${app.repo}` : app.id,
    );
    const repoUrl = buildAppRepoUrl(app);
    const repoCell = repoUrl ? `[${coordLabel}](${repoUrl})` : coordLabel;
    const licenseCell = escapeMarkdownCell(app.license || '-') || '-';
    const platformsCell = escapeMarkdownCell(formatPlatformLabels(app.platforms)) || '-';
    const descCell = escapeMarkdownCell(getAppDescription(app, locale)) || '-';
    lines.push(`| ${appName} | ${repoCell} | ${licenseCell} | ${platformsCell} | ${descCell} |`);
  }

  if (deepLinkUrl) {
    lines.push(
      '',
      isZh
        ? `> 在 ZStore 客户端中打开此合集预览与批量安装：\`${deepLinkUrl}\``
        : `> Open in ZStore to preview and batch install: \`${deepLinkUrl}\``,
    );
  }

  return lines.join('\n');
}
