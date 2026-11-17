/**
 * 弹窗层级、旋转动画降级与深色遮罩通透度的样式契约：
 * - `ModalShell` 的 `layer` 修饰类层级 sub 90 < base 100 < confirm 200 < top 1000，
 *   均高于标题栏 / 缩放手柄、低于 Toast；
 * - `.icon-spin` 在 reduced-motion 下停转，视图不再自带私有旋转类；
 * - 深色遮罩保持半透，弹窗背后的界面在模糊后仍隐约可见。
 */
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
