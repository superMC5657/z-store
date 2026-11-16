/**
 * z-store-launchpad 共享常量与纯函数：规范标识、OSI 协议名单、分类、平台推导、
 * Issue Form 解析与时间工具。与 ZStore 客户端同口径（ADR-0010 / ADR-0018 / ADR-0029）。
 */

export const LAUNCHPAD_REPO = 'superMC5657/z-store-launchpad';
export const MANIFEST_VERSION = 1;
export const SPOTLIGHT_MAX_SLOTS = 4;
export const MAKER_NOTE_MAX = 140;
export const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios'];
export const PIN_TIERS = ['sponsor', 'featured'];

/** 托管源 → 默认主机。 */
export const FORGE_HOSTS = {
  github: 'github.com',
  codeberg: 'codeberg.org',
  gitea: 'gitea.com',
  gitlab: 'gitlab.com',
};

/** ZStore 标准 10 类（与 z-store-catalog 同源）。 */
export const CATEGORIES = [
  { key: 'system', name: '系统实用' },
  { key: 'network', name: '网络工具' },
  { key: 'media', name: '影音播放' },
  { key: 'security', name: '安全加密' },
  { key: 'dev', name: '开发编程' },
  { key: 'graphics', name: '图形创作' },
  { key: 'office', name: '办公协同' },
  { key: 'reading', name: '阅读学习' },
  { key: 'ops', name: '运维部署' },
  { key: 'games', name: '休闲游戏' },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

/** ZStore `[license_gate]` 37 项 OSI SPDX 白名单（大写归一，与客户端 config.toml 同序同值）。 */
export const OSI_LICENSES = [
  'MIT', 'ISC', 'APACHE-2.0', 'APACHE-1.1',
  'GPL-2.0', 'GPL-2.0-ONLY', 'GPL-2.0-OR-LATER', 'GPL-3.0', 'GPL-3.0-ONLY', 'GPL-3.0-OR-LATER',
  'LGPL-2.0', 'LGPL-2.0-ONLY', 'LGPL-2.0-OR-LATER', 'LGPL-2.1', 'LGPL-2.1-ONLY', 'LGPL-2.1-OR-LATER',
  'LGPL-3.0', 'LGPL-3.0-ONLY', 'LGPL-3.0-OR-LATER',
  'AGPL-3.0', 'AGPL-3.0-ONLY', 'AGPL-3.0-OR-LATER',
  'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'MPL-2.0', 'MPL-1.1', 'MPL-1.0', 'MS-PL', 'MS-RL',
  'UNLICENSE', 'ZLIB', 'ARTISTIC-2.0', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'OSL-3.0', 'AFL-3.0',
];
const OSI_SET = new Set(OSI_LICENSES);

export function isOsiLicense(spdx) {
  return typeof spdx === 'string' && OSI_SET.has(spdx.trim().toUpperCase());
}

/** `(forge, forge_host, owner, repo)` → 规范标识（小写）。 */
export function deriveId({ forge, forge_host, owner, repo }) {
  const f = String(forge || 'github').toLowerCase();
  const host = String(forge_host || FORGE_HOSTS[f] || '').toLowerCase();
  const coord = `${owner}/${repo}`.toLowerCase();
  if (f === 'github' && host === 'github.com') return coord;
  if (host === FORGE_HOSTS[f]) return `${f}:${coord}`;
  return `${f}:${host}/${coord}`;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** 解析公开仓库地址 → `{ forge, forge_host, owner, repo }`；不识别返回 `null`。 */
export function parseRepoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo) || owner.startsWith('.') || repo.startsWith('.')) return null;
  let forge = Object.keys(FORGE_HOSTS).find((f) => FORGE_HOSTS[f] === host);
  if (!forge) {
    if (host.includes('gitlab')) forge = 'gitlab';
    else if (host.includes('gitea') || host.includes('forgejo')) forge = 'gitea';
    else return null;
  }
  return { forge, forge_host: host, owner, repo };
}

/** 发布资产文件名 → 平台集合（与客户端/目录仓同口径的后缀规则）。 */
export function platformsFromAssets(assetNames) {
  const names = (assetNames || []).map((n) => String(n).toLowerCase());
  const out = new Set();
  for (const n of names) {
    if (/\.(exe|msi|msix|appx)$/.test(n) || /(win64|win32|windows)/.test(n)) out.add('windows');
    if (/\.(dmg|pkg)$/.test(n) || /\.app\.(zip|tar\.gz)$/.test(n) || /(darwin|macos|osx)/.test(n)) out.add('macos');
    if (/\.(appimage|deb|rpm|flatpak|snap)$/.test(n) || /linux/.test(n)) out.add('linux');
    if (/\.(apk|aab)$/.test(n)) out.add('android');
    if (/\.ipa$/.test(n)) out.add('ios');
  }
  return PLATFORMS.filter((p) => out.has(p));
}

/** 单行折叠：去换行与连续空白。 */
export function foldLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 按 Unicode 码点计数（中文与 emoji 各算 1）。 */
export function charCount(text) {
  return [...String(text ?? '')].length;
}

export function isIsoUtc(value) {
  return typeof value === 'string' && /T/.test(value) && Number.isFinite(Date.parse(value));
}

export function isoNow(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addDaysIso(nowMs, days) {
  return isoNow(nowMs + days * 86_400_000);
}

const NO_RESPONSE = new Set(['_no response_', 'none', 'n/a', '']);

/**
 * 解析 GitHub Issue Form 渲染出的 `### <Heading>` 段落。
 * `headings` 为按表单顺序排列的 `{ fieldId: 'Heading text' }`：每个标题只在上一个标题之后查找，
 * 自由文本里伪造的标题无法覆盖它之前的字段。空选填项（`_No response_`）返回空串。
 */
export function parseIssueForm(body, headings) {
  const text = `\n${String(body ?? '').replace(/\r\n/g, '\n')}`;
  const found = [];
  let cursor = 0;
  for (const [id, heading] of Object.entries(headings)) {
    const marker = `\n### ${heading}\n`;
    const at = text.indexOf(marker, cursor);
    if (at === -1) continue;
    found.push({ id, start: at, contentStart: at + marker.length });
    cursor = at + marker.length;
  }
  const out = Object.fromEntries(Object.keys(headings).map((id) => [id, '']));
  found.forEach((f, i) => {
    const end = found[i + 1]?.start ?? text.length;
    const raw = text.slice(f.contentStart, end).trim();
    out[f.id] = NO_RESPONSE.has(raw.toLowerCase()) ? '' : raw;
  });
  return out;
}

/** 下拉选项取首个空格/破折号前的值键（如 `spotlight-7d — 申请…` → `spotlight-7d`）。 */
export function optionKey(value) {
  return String(value ?? '').trim().split(/\s+[—-]\s+|\s/)[0].toLowerCase();
}

/** 稳定排序：`launched_at DESC, id ASC`。 */
export function sortItems(items) {
  return [...items].sort(
    (a, b) => Date.parse(b.launched_at) - Date.parse(a.launched_at) || a.id.localeCompare(b.id),
  );
}

/** 磁盘格式：2 空格缩进 + 末尾换行。 */
export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
