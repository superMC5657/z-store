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
});
