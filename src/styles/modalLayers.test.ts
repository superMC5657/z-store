/** 弹窗层级顺序、reduced-motion 旋转降级与深色遮罩透明度的样式契约测试。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = (name: string) => fs.readFileSync(path.resolve(here, name), 'utf8');

function zIndexOf(source: string, selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*?z-index:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

describe('modal layer classes', () => {
  const modal = css('components-modal.css');

  it('orders sub < base < confirm < top between the window chrome and toasts', () => {
    const layers = [
      zIndexOf(modal, '.modal-backdrop.modal-layer-sub'),
      zIndexOf(modal, '.modal-backdrop'),
      zIndexOf(modal, '.modal-backdrop.modal-layer-confirm'),
      zIndexOf(modal, '.modal-backdrop.modal-layer-top'),
    ];
    expect(layers).toEqual([90, 100, 200, 1000]);

    const titlebar = css('layout-titlebar.css');
    const toast = css('components-toast.css');
    const chromeMax = Math.max(zIndexOf(titlebar, '.titlebar') ?? 0, zIndexOf(titlebar, '.resize-handle') ?? 0);
    expect(chromeMax).toBeGreaterThan(0);
    expect(layers[0]!).toBeGreaterThan(chromeMax);
    expect(zIndexOf(toast, '.toast-container')).toBeGreaterThan(layers[3]!);
  });

  it('keeps per-view stylesheets free of private modal layers', () => {
    expect(css('components-launchpad.css')).not.toMatch(/launchpad-discussion-backdrop/);
  });
});

describe('spin utility', () => {
  it('stops .icon-spin under prefers-reduced-motion', () => {
    const feedback = css('components-feedback.css');
    expect(feedback).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.icon-spin\s*\{\s*animation:\s*none;/);
  });

  it('has no view-private refresh spin classes', () => {
    expect(css('components-launchpad.css')).not.toMatch(/launchpad-refresh-spin/);
    expect(css('components-trends.css')).not.toMatch(/trends-refresh-spin/);
  });
});

describe('dark overlay', () => {
  it('keeps the dark backdrop translucent so the blurred window stays visible', () => {
    const tokens = css('tokens.css');
    const dark = tokens.slice(tokens.indexOf('[data-theme="dark"]'));
    const m = dark.match(/--overlay-bg:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/);
    expect(m).not.toBeNull();
    const alpha = Number(m![1]);
    expect(alpha).toBeGreaterThanOrEqual(0.5);
    expect(alpha).toBeLessThanOrEqual(0.62);
  });
});
