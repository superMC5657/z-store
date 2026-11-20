import { describe, expect, it } from 'vitest';
import {
  buildDeepLinkUrl,
  buildShareBadgeArtifacts,
  buildShieldsBadgeUrl,
  DEFAULT_SHARE_LANDING_URL,
  escapeHtmlAttr,
  escapeShieldsSegment,
} from './shareBadge';

describe('shareBadge utilities', () => {
  it('builds launchpad and catalog deep links', () => {
    expect(buildDeepLinkUrl('acme/hyper-term', 'launchpad')).toBe('zstore://launchpad/acme/hyper-term');
    expect(buildDeepLinkUrl('codeberg:pix/palette', 'catalog')).toBe('zstore://app/codeberg:pix/palette');
  });

  it('escapes Shields.io dashes, underscores, and slashes', () => {
    expect(escapeShieldsSegment('acme/hyper-term_v2')).toBe('acme%2Fhyper--term__v2');
    const darkUrl = buildShieldsBadgeUrl('acme/hyper-term_v2', 'dark');
    expect(darkUrl).toContain('ZStore-acme%2Fhyper--term__v2-111111');
    expect(darkUrl).toContain('labelColor=111111');

    const lightUrl = buildShieldsBadgeUrl('acme/hyper-term_v2', 'light');
    expect(lightUrl).toContain('ZStore-acme%2Fhyper--term__v2-f4f4f5');
    expect(lightUrl).toContain('labelColor=111111');
  });

  it('escapes HTML attributes to prevent XSS and emits safe Markdown & HTML snippets', () => {
    expect(escapeHtmlAttr('" onclick="alert(1)<script>')).toBe(
      '&quot; onclick=&quot;alert(1)&lt;script&gt;',
    );

    const out = buildShareBadgeArtifacts({
      id: 'acme/hyper-term',
      name: 'Hyper "Term" <X>',
      kind: 'launchpad',
      style: 'light',
    });

    expect(out.deepLinkUrl).toBe('zstore://launchpad/acme/hyper-term');
    expect(out.landingUrl).toBe(DEFAULT_SHARE_LANDING_URL);
    expect(out.badgeHref).toBe(DEFAULT_SHARE_LANDING_URL);
    expect(out.markdownSnippet).toBe(
      `[![Get Hyper "Term" <X> on ZStore](${out.shieldsBadgeUrl})](${DEFAULT_SHARE_LANDING_URL})`,
    );
    expect(out.htmlSnippet).toBe(
      `<a href="${DEFAULT_SHARE_LANDING_URL}"><img src="${escapeHtmlAttr(out.shieldsBadgeUrl)}" alt="Get Hyper &quot;Term&quot; &lt;X&gt; on ZStore" /></a>`,
    );
    expect(out.htmlSnippet).not.toContain('<X>');

    const deeplinkOut = buildShareBadgeArtifacts({
      id: 'acme/hyper-term',
      name: 'HyperTerm',
      kind: 'catalog',
      linkTarget: 'deeplink',
    });
    expect(deeplinkOut.badgeHref).toBe('zstore://app/acme/hyper-term');
    expect(deeplinkOut.markdownSnippet).toContain('](zstore://app/acme/hyper-term)');
    expect(deeplinkOut.htmlSnippet).toContain('<a href="zstore://app/acme/hyper-term">');
  });
});
