// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml attacker cases', () => {
  it('blocks data:image/svg+xml payload in img src', () => {
    const out = sanitizeHtml(
      '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
    );
    expect(out).not.toContain('data:image/svg+xml');
    expect(out).not.toContain('onload');
  });

  it('drops video tag (and onerror) while keeping inner text', () => {
    const out = sanitizeHtml('<video src="https://example.com/x.mp4" onerror="alert(1)">hi</video>');
    expect(out).not.toContain('<video');
    expect(out).not.toContain('onerror');
  });

  it('drops audio/source/picture tags', () => {
    const out = sanitizeHtml(
      '<audio src="https://example.com/x.mp3"></audio><picture><source srcset="https://example.com/x.webp"><img src="https://example.com/x.png"></picture>',
    );
    expect(out).not.toContain('<audio');
    expect(out).not.toContain('<source');
    expect(out).not.toContain('<picture');
  });

  it('keeps legit https img with hardening attrs', () => {
    const out = sanitizeHtml('<img src="https://example.com/a.png" alt="a">');
    expect(out).toContain('<img');
    expect(out).toContain('https://example.com/a.png');
  });

  it('keeps data:image/png but blocks data:text/html', () => {
    const kept = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(kept).toContain('data:image/png');
    const blocked = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(blocked).not.toContain('data:text/html');
  });

  it('blocks control-char and whitespace obfuscated javascript/vbscript schemes (F-24a)', () => {
    const cases = [
      '<a href="java&#x09;script:alert(1)">tab-entity</a>',
      '<a href="java\tscript:alert(1)">raw-tab</a>',
      '<a href="&#x01;javascript:alert(1)">c0-prefix</a>',
      '<a href="java\nscript:alert(1)">newline</a>',
      '<a href="vb&#x09;script:msgbox(1)">vbscript</a>',
      '<img src="java&#x09;script:alert(1)">',
    ];
    for (const html of cases) {
      const out = sanitizeHtml(html);
      expect(out).not.toMatch(/\bhref=/i);
      expect(out).not.toMatch(/\bsrc=/i);
      expect(out.toLowerCase()).not.toContain('script:');
    }
  });

  it('enforces strict URL scheme allowlist and forbids asset:/tauri:/data: on a[href] (F-24b/c)', () => {
    // Disallowed schemes on a[href] and img[src]
    const blocked = [
      '<a href="asset://localhost/secret">asset</a>',
      '<a href="tauri://localhost/index.html">tauri</a>',
      '<a href="data:image/png;base64,iVBORw0KGgo=">data-on-a</a>',
      '<a href="file:///etc/passwd">file</a>',
      '<a href="//evil.example/x">proto-rel</a>',
      '<img src="asset://localhost/pic.png">',
      '<img src="tauri://localhost/pic.png">',
      '<img src="mailto:test@example.com">',
    ];
    for (const html of blocked) {
      const out = sanitizeHtml(html);
      expect(out).not.toMatch(/\bhref=/i);
      expect(out).not.toMatch(/\bsrc=/i);
    }

    // Allowed schemes
    const okHttps = sanitizeHtml('<a href="https://example.com/docs">docs</a>');
    expect(okHttps).toContain('href="https://example.com/docs"');
    expect(okHttps).toContain('target="_blank"');
    expect(okHttps).toContain('rel="noopener noreferrer"');

    const okMailto = sanitizeHtml('<a href="mailto:hi@example.com">mail</a>');
    expect(okMailto).toContain('href="mailto:hi@example.com"');
    expect(okMailto).toContain('target="_blank"');

    // Relative links resolved via repoBaseUrl / rawBaseUrl
    const resolved = sanitizeHtml('<a href="docs/guide.md">g</a><img src="assets/logo.png">', {
      repoBaseUrl: 'https://github.com/o/r/blob/HEAD/',
      rawBaseUrl: 'https://raw.githubusercontent.com/o/r/HEAD/',
    });
    expect(resolved).toContain('href="https://github.com/o/r/blob/HEAD/docs/guide.md"');
    expect(resolved).toContain('src="https://raw.githubusercontent.com/o/r/HEAD/assets/logo.png"');
  });

  it('strips inline style attributes to prevent clickjacking and external CSS IP leaks (F-24d)', () => {
    const out = sanitizeHtml(
      '<div style="position:fixed;inset:0;z-index:999999;background:url(https://attacker.test/px)">hi</div>',
    );
    expect(out).toContain('<div>hi</div>');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('position');
    expect(out).not.toContain('attacker.test');
  });

  it('sanitizes img srcset per candidate while preserving data:image base64 commas (F-24e)', () => {
    const mixed = sanitizeHtml(
      '<img srcset="data:image/png;base64,iVBORw0KGgo= 2x, https://example.com/a.png 1x, asset://localhost/x.png 3x, data:image/svg+xml;base64,PHN2Zz4= 4x, java&#x09;script:alert(1) 1x">',
    );
    expect(mixed).toContain('data:image/png;base64,iVBORw0KGgo= 2x');
    expect(mixed).toContain('https://example.com/a.png 1x');
    expect(mixed).not.toContain('asset://');
    expect(mixed).not.toContain('image/svg+xml');
    expect(mixed).not.toContain('script:');

    const allBad = sanitizeHtml(
      '<img srcset="tauri://localhost/a.png 1x, javascript:alert(1) 2x">',
    );
    expect(allBad).not.toContain('srcset');
  });

  it('does not add target="_blank" or rel to in-page #anchor links (F-25a)', () => {
    const anchor = sanitizeHtml('<a href="#getting-started" target="_blank" rel="noopener">Jump</a>');
    expect(anchor).toContain('href="#getting-started"');
    expect(anchor).not.toContain('target=');
    expect(anchor).not.toContain('rel=');
  });
});
