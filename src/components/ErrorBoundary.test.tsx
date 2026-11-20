/** 测试顶层 `ErrorBoundary` 的正常渲染、错误卡降级及重载交互。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import i18n from '../i18n';
import { ErrorBoundary } from './ErrorBoundary';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function Boom(): React.ReactElement {
  throw new Error('render crash boom');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  return i18n.changeLanguage('zh-CN');
});

describe('ErrorBoundary', () => {
  it('renders healthy children unchanged', () => {
    render(
      <ErrorBoundary>
        <div>healthy-subtree</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy-subtree')).toBeTruthy();
  });

  it('catches render crash and shows fallback card with detail', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('界面出错了')).toBeTruthy();
    expect(screen.getByText(/应用遇到未预期的错误/)).toBeTruthy();
    expect(screen.getByText('render crash boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重载应用' })).toBeTruthy();
    expect(screen.queryByText(/ Boom/)).toBeNull();
    errSpy.mockRestore();
  });

  it('reload button invokes window.location.reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: '重载应用' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
