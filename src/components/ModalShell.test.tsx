import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModalShell, type ModalLayer } from './ModalShell';

afterEach(() => {
  cleanup();
  document.querySelectorAll('.app-window').forEach((el) => el.remove());
});

const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

function mountAppWindow() {
  const appWindow = document.createElement('div');
  appWindow.className = 'app-window';
  const titlebar = document.createElement('div');
  titlebar.className = 'titlebar';
  const appBody = document.createElement('div');
  appBody.className = 'app-body';
  appWindow.append(titlebar, appBody);
  document.body.appendChild(appWindow);
  return { appWindow, appBody };
}

describe('ModalShell', () => {
  it('portals into .app-window (sibling of the titlebar) when it exists', () => {
    const { appWindow, appBody } = mountAppWindow();
    render(
      <ModalShell ariaLabel="demo" onClose={() => {}}>
        <p>body</p>
      </ModalShell>,
      { container: appBody },
    );
    const backdrop = appWindow.querySelector('.modal-backdrop');
    expect(backdrop?.parentElement).toBe(appWindow);
    expect(appBody.querySelector('.modal-backdrop')).toBeNull();
  });

  it('renders in place when there is no .app-window', () => {
    const { container } = render(
      <ModalShell ariaLabel="demo" onClose={() => {}}>
        <p>body</p>
      </ModalShell>,
    );
    expect(container.querySelector('.modal-backdrop > .detail-modal')).toBeTruthy();
  });

  it('puts dialog semantics and extra classes on the panel', () => {
    render(
      <ModalShell
        ariaLabelledBy="title-id"
        backdropClassName="extra-backdrop"
        panelClassName="extra-panel"
        panelStyle={{ maxWidth: '480px' }}
        onClose={() => {}}
      >
        <h2 id="title-id">Title</h2>
      </ModalShell>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('title-id');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(dialog.className).toBe('detail-modal extra-panel');
    expect(dialog.style.maxWidth).toBe('480px');
    expect(dialog.parentElement?.className).toBe('modal-backdrop extra-backdrop');
  });

  it.each<[ModalLayer, string | null]>([
    ['sub', 'modal-layer-sub'],
    ['base', null],
    ['confirm', 'modal-layer-confirm'],
    ['top', 'modal-layer-top'],
  ])('layer=%s mounts the matching layer class', (layer, cls) => {
    render(
      <ModalShell layer={layer} ariaLabel="demo" onClose={() => {}}>
        <p>body</p>
      </ModalShell>,
    );
    const backdrop = screen.getByRole('dialog').parentElement!;
    const layerClasses = Array.from(backdrop.classList).filter((c) => c.startsWith('modal-layer-'));
    expect(layerClasses).toEqual(cls ? [cls] : []);
  });

  it('forwards the panel element to object and function refs', () => {
    const objectRef = React.createRef<HTMLDivElement>();
    const fnRef = vi.fn();
    render(
      <>
        <ModalShell ariaLabel="a" panelRef={objectRef}>
          <p>a</p>
        </ModalShell>
        <ModalShell ariaLabel="b" panelRef={fnRef}>
          <p>b</p>
        </ModalShell>
      </>,
    );
    expect(objectRef.current).toBe(screen.getByRole('dialog', { name: 'a' }));
    expect(fnRef).toHaveBeenCalledWith(screen.getByRole('dialog', { name: 'b' }));
  });

  describe('backdrop click', () => {
    it('closes when press and release both land on the backdrop', () => {
      const onClose = vi.fn();
      render(
        <ModalShell ariaLabel="demo" onClose={onClose}>
          <p>body</p>
        </ModalShell>,
      );
      const backdrop = screen.getByRole('dialog').parentElement!;
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close on clicks inside the panel', () => {
      const onClose = vi.fn();
      render(
        <ModalShell ariaLabel="demo" onClose={onClose}>
          <p>body</p>
        </ModalShell>,
      );
      const text = screen.getByText('body');
      fireEvent.mouseDown(text);
      fireEvent.click(text);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close when a drag starts inside the panel and ends on the backdrop', () => {
      const onClose = vi.fn();
      render(
        <ModalShell ariaLabel="demo" onClose={onClose}>
          <p>body</p>
        </ModalShell>,
      );
      const backdrop = screen.getByRole('dialog').parentElement!;
      fireEvent.mouseDown(screen.getByText('body'));
      fireEvent.click(backdrop);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores backdrop clicks when closeOnBackdrop is false', () => {
      const onClose = vi.fn();
      render(
        <ModalShell ariaLabel="demo" closeOnBackdrop={false} onClose={onClose}>
          <p>body</p>
        </ModalShell>,
      );
      const backdrop = screen.getByRole('dialog').parentElement!;
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Escape', () => {
    it('only closes the topmost of stacked shells', () => {
      const Harness = () => {
        const [lower, setLower] = useState(true);
        const [upper, setUpper] = useState(true);
        return (
          <>
            {lower && (
              <ModalShell layer="sub" ariaLabel="lower" onClose={() => setLower(false)}>
                <button type="button">lower-btn</button>
              </ModalShell>
            )}
            {upper && (
              <ModalShell ariaLabel="upper" onClose={() => setUpper(false)}>
                <button type="button">upper-btn</button>
              </ModalShell>
            )}
          </>
        );
      };
      render(<Harness />);
      act(() => pressEscape());
      expect(screen.queryByRole('dialog', { name: 'upper' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'lower' })).toBeTruthy();
      act(() => pressEscape());
      expect(screen.queryByRole('dialog', { name: 'lower' })).toBeNull();
    });

    it('prefers a custom onEscape over onClose', () => {
      const onClose = vi.fn();
      const onEscape = vi.fn();
      render(
        <ModalShell ariaLabel="demo" onClose={onClose} onEscape={onEscape}>
          <p>body</p>
        </ModalShell>,
      );
      act(() => pressEscape());
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('focuses the panel on open', () => {
      render(
        <ModalShell ariaLabel="demo" onClose={() => {}}>
          <button type="button">inner</button>
        </ModalShell>,
      );
      expect(document.activeElement).toBe(screen.getByRole('dialog'));
    });
  });

  describe('sibling layer visual stacking (F-35)', () => {
    it('gives a newly opened base modal higher z-index even when mounted earlier in DOM', () => {
      const Harness = () => {
        const [firstOpen, setFirstOpen] = useState(true);
        const [secondOpen, setSecondOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setSecondOpen(true)}>
              open-second
            </button>
            <button type="button" onClick={() => setFirstOpen(false)}>
              close-first
            </button>
            {secondOpen && (
              <ModalShell layer="base" ariaLabel="second-in-time-first-in-dom" onClose={() => setSecondOpen(false)}>
                <p>second</p>
              </ModalShell>
            )}
            {firstOpen && (
              <ModalShell layer="base" ariaLabel="first-in-time-second-in-dom" onClose={() => setFirstOpen(false)}>
                <p>first</p>
              </ModalShell>
            )}
          </>
        );
      };
      render(<Harness />);
      const firstBackdrop = screen.getByRole('dialog', { name: 'first-in-time-second-in-dom' }).parentElement!;
      expect(Number(firstBackdrop.style.zIndex)).toBe(100);

      fireEvent.click(screen.getByText('open-second'));
      const secondBackdrop = screen.getByRole('dialog', { name: 'second-in-time-first-in-dom' }).parentElement!;
      expect(Number(secondBackdrop.style.zIndex)).toBeGreaterThan(Number(firstBackdrop.style.zIndex));
      expect(Number(secondBackdrop.style.zIndex)).toBeLessThan(200);

      // Closing the older modal compacts the stack so the remaining modal returns to base z-index
      fireEvent.click(screen.getByText('close-first'));
      expect(Number(secondBackdrop.style.zIndex)).toBe(100);
    });

    it('keeps higher semantic layers above lower stacked layers', () => {
      render(
        <>
          <ModalShell layer="base" ariaLabel="base-1" onClose={() => {}}>
            <p>b1</p>
          </ModalShell>
          <ModalShell layer="base" ariaLabel="base-2" onClose={() => {}}>
            <p>b2</p>
          </ModalShell>
          <ModalShell layer="confirm" ariaLabel="confirm-1" onClose={() => {}}>
            <p>c1</p>
          </ModalShell>
        </>,
      );
      const b1 = Number(screen.getByRole('dialog', { name: 'base-1' }).parentElement!.style.zIndex);
      const b2 = Number(screen.getByRole('dialog', { name: 'base-2' }).parentElement!.style.zIndex);
      const c1 = Number(screen.getByRole('dialog', { name: 'confirm-1' }).parentElement!.style.zIndex);
      expect(b2).toBeGreaterThan(b1);
      expect(c1).toBeGreaterThan(b2);
    });
  });
});
