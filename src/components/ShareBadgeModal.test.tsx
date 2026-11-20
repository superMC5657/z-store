import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import { ModalShell } from './ModalShell';
import { ShareBadgeModal } from './ShareBadgeModal';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

vi.mock('../utils/appHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/appHelper')>();
  return {
    ...actual,
    copyTextToClipboard: clipboardMock.copyTextToClipboard,
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => cleanup());

describe('ShareBadgeModal', () => {
  it('toggles monochrome dark/light style and copies deep link, Markdown, and HTML snippets', async () => {
    render(
      <ShareBadgeModal
        id="acme/hyper-term"
        name="HyperTerm"
        kind="launchpad"
        layer="base"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('share-code-deeplink').textContent).toBe('zstore://launchpad/acme/hyper-term');
    expect(screen.getByTestId('share-code-markdown').textContent).toContain('ZStore-acme%2Fhyper--term-111111');
    expect(screen.getByTestId('share-code-markdown').textContent).toContain('](https://z-store-web.pages.dev)');
    expect(screen.getByTestId('share-code-html').textContent).toContain('<a href="https://z-store-web.pages.dev">');

    // Switch to light monochrome style (#f4f4f5)
    fireEvent.click(screen.getByRole('tab', { name: '浅色 #f4f4f5' }));
    expect(screen.getByTestId('share-badge-preview-pill').getAttribute('data-style')).toBe('light');
    expect(screen.getByTestId('share-code-markdown').textContent).toContain('ZStore-acme%2Fhyper--term-f4f4f5');

    // Switch click target to zstore:// deep link and back
    fireEvent.click(screen.getByRole('tab', { name: 'zstore:// 深链' }));
    expect(screen.getByTestId('share-code-markdown').textContent).toContain('](zstore://launchpad/acme/hyper-term)');
    expect(screen.getByTestId('share-code-html').textContent).toContain('<a href="zstore://launchpad/acme/hyper-term">');

    fireEvent.click(screen.getByRole('tab', { name: '官网着陆页 (推荐)' }));
    expect(screen.getByTestId('share-code-markdown').textContent).toContain('](https://z-store-web.pages.dev)');

    // Copy deep link
    await act(async () => {
      fireEvent.click(screen.getByTestId('share-copy-deeplink'));
    });
    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith('zstore://launchpad/acme/hyper-term');
    expect(screen.getByRole('status').textContent).toBe('已复制到剪贴板');

    // Copy Markdown
    await act(async () => {
      fireEvent.click(screen.getByTestId('share-copy-markdown'));
    });
    expect(clipboardMock.copyTextToClipboard).toHaveBeenLastCalledWith(
      screen.getByTestId('share-code-markdown').textContent,
    );

    // Copy HTML
    await act(async () => {
      fireEvent.click(screen.getByTestId('share-copy-html'));
    });
    expect(clipboardMock.copyTextToClipboard).toHaveBeenLastCalledWith(
      screen.getByTestId('share-code-html').textContent,
    );
  });

  it('stacks above base modal with modal-layer-confirm and Esc closes only ShareBadgeModal', async () => {
    const onBaseClose = vi.fn();
    const onShareClose = vi.fn();
    const { rerender } = render(
      <>
        <ModalShell layer="base" onClose={onBaseClose} ariaLabel="Base detail">
          <div>Detail content</div>
        </ModalShell>
        <ShareBadgeModal
          id="localsend/localsend"
          name="LocalSend"
          kind="catalog"
          layer="confirm"
          onClose={onShareClose}
        />
      </>,
    );

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1].closest('.modal-backdrop')?.className).toContain('modal-layer-confirm');
    expect(screen.getByTestId('share-code-deeplink').textContent).toBe('zstore://app/localsend/localsend');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onShareClose).toHaveBeenCalledTimes(1);
    expect(onBaseClose).not.toHaveBeenCalled();

    rerender(
      <ModalShell layer="base" onClose={onBaseClose} ariaLabel="Base detail">
        <div>Detail content</div>
      </ModalShell>,
    );
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
  });
});
