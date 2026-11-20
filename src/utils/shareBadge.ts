export type ShareBadgeKind = 'launchpad' | 'catalog';

export type ShareBadgeStyle = 'dark' | 'light';

export type ShareBadgeLinkTarget = 'landing' | 'deeplink';

export const DEFAULT_SHARE_LANDING_URL = 'https://z-store-web.pages.dev';

/** 生成 ZStore 原生深链（`zstore://launchpad/{id}` 或 `zstore://app/{id}`）。 */
export function buildDeepLinkUrl(id: string, kind: ShareBadgeKind): string {
  const cleanId = id.trim().replace(/^\/+/, '');
  const route = kind === 'launchpad' ? 'launchpad' : 'app';
  return `zstore://${route}/${cleanId}`;
}

/** Shields.io 路径段转义：`-` → `--`、`_` → `__`、空白 → `_`，并做 URI 编码（保留 `/`）。 */
export function escapeShieldsSegment(raw: string): string {
  return raw
    .trim()
    .split('/')
    .map((part) =>
      encodeURIComponent(
        part
          .replace(/-/g, '--')
          .replace(/_/g, '__')
          .replace(/\s+/g, '_'),
      ),
    )
    .join('%2F');
}

/** 生成符合 D4 单色约束的 Shields.io 静态徽章 URL（`dark` `#111111` / `light` `#f4f4f5`）。 */
export function buildShieldsBadgeUrl(
  id: string,
  style: ShareBadgeStyle = 'dark',
): string {
  const message = escapeShieldsSegment(id || 'open-source');
  if (style === 'light') {
    return `https://img.shields.io/badge/ZStore-${message}-f4f4f5?style=flat&labelColor=111111`;
  }
  return `https://img.shields.io/badge/ZStore-${message}-111111?style=flat&labelColor=111111&logoColor=ffffff`;
}

/** HTML 属性值转义，防止嵌入片段注入（XSS）。 */
export function escapeHtmlAttr(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ShareBadgeInput {
  id: string;
  name: string;
  kind: ShareBadgeKind;
  style?: ShareBadgeStyle;
  linkTarget?: ShareBadgeLinkTarget;
  landingUrl?: string;
}

export interface ShareBadgeArtifacts {
  deepLinkUrl: string;
  landingUrl: string;
  badgeHref: string;
  shieldsBadgeUrl: string;
  markdownSnippet: string;
  htmlSnippet: string;
}

/** 一站生成协议深链、Shields 徽章地址、Markdown 徽章与 HTML 嵌入代码。 */
export function buildShareBadgeArtifacts(input: ShareBadgeInput): ShareBadgeArtifacts {
  const style = input.style ?? 'dark';
  const deepLinkUrl = buildDeepLinkUrl(input.id, input.kind);
  const rawLanding = (input.landingUrl ?? DEFAULT_SHARE_LANDING_URL).trim();
  const landingUrl = /^https?:\/\//i.test(rawLanding) ? rawLanding : DEFAULT_SHARE_LANDING_URL;
  const linkTarget = input.linkTarget ?? 'landing';
  const badgeHref = linkTarget === 'deeplink' ? deepLinkUrl : landingUrl;
  const shieldsBadgeUrl = buildShieldsBadgeUrl(input.id, style);
  const safeName = input.name.trim() || input.id.trim() || 'ZStore App';
  const altText = `Get ${safeName} on ZStore`;

  // GitHub README 过滤器会剥离非 https:// 链接，默认提供官网着陆引导链接，并允许切换为 zstore:// 深链。
  const markdownSnippet = `[![${altText.replace(/[[\]]/g, '')}](${shieldsBadgeUrl})](${badgeHref})`;
  const htmlSnippet = `<a href="${escapeHtmlAttr(badgeHref)}"><img src="${escapeHtmlAttr(shieldsBadgeUrl)}" alt="${escapeHtmlAttr(altText)}" /></a>`;

  return {
    deepLinkUrl,
    landingUrl,
    badgeHref,
    shieldsBadgeUrl,
    markdownSnippet,
    htmlSnippet,
  };
}
