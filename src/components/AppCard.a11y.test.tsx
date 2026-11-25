/** 回归测试 AppCard 嵌套按钮键盘冒泡拦截与 Space 防滚动（F-36）。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../i18n';
import type { AppSummary } from '../types';
import { AppCard } from './AppCard';

afterEach(cleanup);

function makeSummary(): AppSummary {
  return {
    id: 'owner/demo',
    name: 'Demo App',
    owner: 'owner',
    repo: 'demo',
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: 'Demo description',
    stars: 42,
    forks: 5,
    license: 'MIT',
    latest_version: '1.0.0',
    category: 'system',
    category_name: '系统',
    is_verified: false,
    is_cataloged: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

describe('AppCard keyboard accessibility (F-36)', () => {
  it('ignores Enter/Space keydowns bubbling from nested action buttons', () => {
    const onOpenDetail = vi.fn();
    const onQuickInstall = vi.fn();
    const onToggleFavorite = vi.fn();
    const onToggleWatch = vi.fn();

    render(
      <AppCard
        app={makeSummary()}
        isInstalled={false}
        isManaged={false}
        platformLoading={false}
        onOpenDetail={onOpenDetail}
        onQuickInstall={onQuickInstall}
        onToggleFavorite={onToggleFavorite}
        onToggleWatch={onToggleWatch}
      />,
    );

    const buttons = screen.getAllByRole('button').filter((el) => el.tagName === 'BUTTON');
    expect(buttons.length).toBeGreaterThanOrEqual(3);

    for (const btn of buttons) {
      fireEvent.keyDown(btn, { key: 'Enter', bubbles: true });
      fireEvent.keyDown(btn, { key: ' ', bubbles: true });
    }

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('activates onOpenDetail and calls preventDefault on Space pressed directly on card root', () => {
    const onOpenDetail = vi.fn();
    const { container } = render(
      <AppCard
        app={makeSummary()}
        isInstalled={false}
        isManaged={false}
        platformLoading={false}
        onOpenDetail={onOpenDetail}
        onQuickInstall={() => {}}
      />,
    );

    const card = container.querySelector('.app-card') as HTMLElement;
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    card.dispatchEvent(spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(true);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith('owner/demo');
  });
});
