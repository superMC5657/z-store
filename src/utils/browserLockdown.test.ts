import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isBlockedShortcut, initBrowserLockdown } from './browserLockdown';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    openUrl: vi.fn(),
  },
}));

describe('browserLockdown', () => {
  describe('isBlockedShortcut', () => {
    it('blocks F5 and F12 single key presses', () => {
      expect(isBlockedShortcut({ key: 'F5', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'F12', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
    });

    it('blocks Alt+ArrowLeft and Alt+ArrowRight (history navigation)', () => {
      expect(isBlockedShortcut({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true })).toBe(true);
      expect(isBlockedShortcut({ key: 'ArrowRight', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true })).toBe(true);
      // 普通 ArrowLeft/Right 不拦截
      expect(isBlockedShortcut({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
    });

    it('blocks zoom shortcuts: Ctrl/Cmd + / - / = / _ / 0', () => {
      expect(isBlockedShortcut({ key: '+', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: '-', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: '=', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: '_', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: '0', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: '0', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true);
    });

    it('blocks find shortcuts: Ctrl/Cmd + F / G', () => {
      expect(isBlockedShortcut({ key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'F', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'g', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'G', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true);
    });

    it('blocks browser window/tab/history actions: Ctrl/Cmd + H/J/D/O/N/T/W', () => {
      const keys = ['h', 'j', 'd', 'o', 'n', 't', 'w'];
      for (const k of keys) {
        expect(isBlockedShortcut({ key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
        expect(isBlockedShortcut({ key: k.toUpperCase(), ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true);
      }
    });

    it('blocks Ctrl/Cmd + R/S/P/U', () => {
      expect(isBlockedShortcut({ key: 'r', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'u', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
    });

    it('blocks DevTools combinations: Ctrl+Shift+I/J/C', () => {
      expect(isBlockedShortcut({ key: 'I', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'j', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'c', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true);
      expect(isBlockedShortcut({ key: 'C', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(true);
    });

    it('allows business and standard editing shortcuts', () => {
      // Ctrl+K 搜索聚焦必须放行
      expect(isBlockedShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'K', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(false);

      // Escape 必须放行
      expect(isBlockedShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);

      // 剪贴板通用快捷键：Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z / Ctrl+Y 必须放行
      expect(isBlockedShortcut({ key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'v', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'x', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'a', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'y', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);

      // Tab, Enter, Space
      expect(isBlockedShortcut({ key: 'Tab', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
      expect(isBlockedShortcut({ key: ' ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
    });
  });

  describe('initBrowserLockdown integration and event handlers', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('attaches listeners and enforces lockdown handlers', () => {
      initBrowserLockdown();

      // 1. window.print 是空操作
      expect(typeof window.print).toBe('function');
      window.print();

      // 2. window.open 转走 api.openUrl
      const res = window.open('https://example.com');
      expect(res).toBeNull();
      expect(api.openUrl).toHaveBeenCalledWith('https://example.com');

      // 3. 点击 a[target="_blank"] 事件委托走 api.openUrl
      const link = document.createElement('a');
      link.href = 'https://github.com/superMC5657/z-store';
      link.target = '_blank';
      document.body.appendChild(link);

      const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true);
      expect(api.openUrl).toHaveBeenCalledWith('https://github.com/superMC5657/z-store');

      document.body.removeChild(link);
    });

    it('handles side mouse buttons and wheel zooming correctly', () => {
      initBrowserLockdown();

      // 鼠标侧键 button 3 和 4 被拦截
      const auxEvt = new MouseEvent('auxclick', { button: 3, cancelable: true, bubbles: true });
      document.dispatchEvent(auxEvt);
      expect(auxEvt.defaultPrevented).toBe(true);

      const upEvt = new MouseEvent('mouseup', { button: 4, cancelable: true, bubbles: true });
      document.dispatchEvent(upEvt);
      expect(upEvt.defaultPrevented).toBe(true);

      // 普通左键不拦截
      const normalMouse = new MouseEvent('mouseup', { button: 0, cancelable: true, bubbles: true });
      document.dispatchEvent(normalMouse);
      expect(normalMouse.defaultPrevented).toBe(false);

      // Ctrl + 滚轮拦截
      const ctrlWheel = new WheelEvent('wheel', { ctrlKey: true, cancelable: true, bubbles: true });
      window.dispatchEvent(ctrlWheel);
      expect(ctrlWheel.defaultPrevented).toBe(true);

      // 普通滚轮放行
      const normalWheel = new WheelEvent('wheel', { ctrlKey: false, cancelable: true, bubbles: true });
      window.dispatchEvent(normalWheel);
      expect(normalWheel.defaultPrevented).toBe(false);
    });
  });
});
