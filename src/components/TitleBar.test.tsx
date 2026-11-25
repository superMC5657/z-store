/** 测试 `TitleBar` 的输入防抖搜索、立即清空及 IME 合成期 Enter 拦截。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import '../i18n';
import { TitleBar } from './TitleBar';

const mocks = vi.hoisted(() => ({
  getSearchHistory: vi.fn(async () => [] as string[]),
  recordSearchQuery: vi.fn(async () => {}),
}));

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get: (target, prop) => {
        if (prop === 'getSearchHistory') return mocks.getSearchHistory;
        if (prop === 'recordSearchQuery') return mocks.recordSearchQuery;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTitleBar(overrides?: Partial<React.ComponentProps<typeof TitleBar>>) {
  const onSearchDraft = vi.fn();
  const onSearchChange = vi.fn();
  const utils = render(
    <TitleBar
      searchQuery=""
      onSearchDraft={onSearchDraft}
      onSearchChange={onSearchChange}
      theme="light"
      onToggleTheme={() => {}}
      {...overrides}
    />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { ...utils, input, onSearchDraft, onSearchChange };
}

describe('TitleBar 搜索输入与触发时机', () => {
  it('输入新词立即通知 onSearchDraft，250ms 防抖后触发 onSearchChange；清空立即生效', () => {
    const { input, onSearchDraft, onSearchChange } = renderTitleBar();

    fireEvent.change(input, { target: { value: 'codex' } });
    expect(onSearchDraft).toHaveBeenCalledWith('codex');
    expect(onSearchChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(onSearchChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSearchChange).toHaveBeenCalledWith('codex');

    fireEvent.change(input, { target: { value: '' } });
    expect(onSearchChange).toHaveBeenLastCalledWith('');
  });

  it('IME 合成态按 Enter 不调用 preventDefault 也不提交；正常 Enter 阻止默认行为并立即本地搜索', () => {
    const { input, onSearchChange } = renderTitleBar();
    fireEvent.change(input, { target: { value: 'codex' } });

    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    const composingNotPrevented = input.dispatchEvent(composingEvent);
    expect(composingNotPrevented).toBe(true);
    expect(composingEvent.defaultPrevented).toBe(false);
    expect(onSearchChange).not.toHaveBeenCalled();

    const keyCode229Event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(keyCode229Event);
    expect(keyCode229Event.defaultPrevented).toBe(false);
    expect(onSearchChange).not.toHaveBeenCalled();

    // compositionend 后 50ms 内的 Enter（Safari 时序倒置场景）同样放行不误提交
    const compEnd = new Event('compositionend', { bubbles: true });
    Object.defineProperty(compEnd, 'timeStamp', { value: 1000 });
    input.dispatchEvent(compEnd);
    const immediateAfterComp = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(immediateAfterComp, 'timeStamp', { value: 1010 });
    input.dispatchEvent(immediateAfterComp);
    expect(immediateAfterComp.defaultPrevented).toBe(false);
    expect(onSearchChange).not.toHaveBeenCalled();

    const normalEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(normalEnter, 'timeStamp', { value: 1100 });
    input.dispatchEvent(normalEnter);
    expect(normalEnter.defaultPrevented).toBe(true);
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith('codex');
  });

  it('模态弹窗打开时忽略 Ctrl+K / Cmd+K，不抢夺焦点 (F-36)', () => {
    const { input } = renderTitleBar();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const modalBtn = document.createElement('button');
    modal.appendChild(modalBtn);
    document.body.appendChild(modal);
    modalBtn.focus();

    try {
      const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
      window.dispatchEvent(ctrlK);
      expect(ctrlK.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(modalBtn);

      const metaK = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
      window.dispatchEvent(metaK);
      expect(metaK.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(modalBtn);
    } finally {
      modal.remove();
    }

    // 弹窗关闭后 Ctrl+K 恢复聚焦搜索框
    const ctrlKAfter = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    window.dispatchEvent(ctrlKAfter);
    expect(ctrlKAfter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('按 Escape 时关闭搜索历史下拉框并失焦 (F-36)', async () => {
    mocks.getSearchHistory.mockResolvedValue(['rustdesk', 'vscode']);
    const { container, input } = renderTitleBar();

    // Flush initial loadSearchHistory
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.focus(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('.search-history-dropdown')).toBeTruthy();

    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('.search-history-dropdown')).toBeNull();
    expect(document.activeElement).not.toBe(input);
  });
});
