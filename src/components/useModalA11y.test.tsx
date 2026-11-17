import React, { useRef, useState } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useModalA11y } from './useModalA11y';

afterEach(cleanup);

const Dialog: React.FC<{
  name: string;
  onClose?: () => void;
  open?: boolean;
  children?: React.ReactNode;
}> = ({ name, onClose, open = true, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, { open, onEscape: onClose });
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      {children ?? (
        <>
          <button type="button">{`${name}-first`}</button>
          <button type="button">{`${name}-last`}</button>
        </>
      )}
    </div>
  );
};

const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('useModalA11y', () => {
  it('moves focus into the dialog on open and restores it on close', () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          <Dialog name="a" open={open} onClose={() => setOpen(false)} />
        </>
      );
    };
    render(<Harness />);
    const opener = screen.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    act(() => pressEscape());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes only the topmost of stacked dialogs on Escape', () => {
    const onCloseBottom = vi.fn();
    const Harness = () => {
      const [topOpen, setTopOpen] = useState(true);
      return (
        <>
          <Dialog name="bottom" onClose={onCloseBottom} />
          <Dialog name="top" open={topOpen} onClose={() => setTopOpen(false)} />
        </>
      );
    };
    render(<Harness />);
    act(() => pressEscape());
    expect(screen.queryByRole('dialog', { name: 'top' })).toBeNull();
    expect(onCloseBottom).not.toHaveBeenCalled();
    act(() => pressEscape());
    expect(onCloseBottom).toHaveBeenCalledTimes(1);
  });

  it('lets an inner control claim Escape via preventDefault', () => {
    const onClose = vi.fn();
    render(
      <Dialog name="a" onClose={onClose}>
        <input aria-label="inner" onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />
      </Dialog>,
    );
    const input = screen.getByLabelText('inner');
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores Escape when no handler is given', () => {
    render(<Dialog name="a" />);
    act(() => pressEscape());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(<Dialog name="a" onClose={() => {}} />);
    const first = screen.getByText('a-first');
    const last = screen.getByText('a-last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back in when Tab is pressed from outside the dialog', () => {
    render(
      <>
        <button type="button">outside</button>
        <Dialog name="a" onClose={() => {}} />
      </>,
    );
    const outside = screen.getByText('outside');
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('a-first'));
  });
});
