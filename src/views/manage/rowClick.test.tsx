import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { rowClickHandler } from './rowClick';

afterEach(cleanup);

function renderRow(open: () => void) {
  const onAction = vi.fn();
  render(
    <div data-testid="row" onClick={rowClickHandler(open)}>
      <span>Name</span>
      <button type="button" onClick={onAction}>
        action
      </button>
      <div data-row-click-ignore>
        <span>actions gap</span>
      </div>
    </div>,
  );
  return onAction;
}

describe('rowClickHandler', () => {
  it('opens when clicking plain text or the row itself', () => {
    const open = vi.fn();
    renderRow(open);
    fireEvent.click(screen.getByText('Name'));
    fireEvent.click(screen.getByTestId('row'));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('leaves buttons and ignored regions to themselves', () => {
    const open = vi.fn();
    const onAction = renderRow(open);
    fireEvent.click(screen.getByText('action'));
    fireEvent.click(screen.getByText('actions gap'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open while the user has text selected inside the row', () => {
    const open = vi.fn();
    renderRow(open);
    const text = screen.getByText('Name').firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(screen.getByText('Name'));
    selection.removeAllRanges();
    expect(open).not.toHaveBeenCalled();
  });

  it('returns no handler when there is nothing to open', () => {
    expect(rowClickHandler(undefined)).toBeUndefined();
  });
});
