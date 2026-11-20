import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppDetailViewModel, AppSummary, SimilarAppsResponse } from '../../types';
import '../../i18n';

const mocks = vi.hoisted(() => ({
  getSimilarApps: vi.fn(),
  fetchStarredStatus: vi.fn(async () => false),
  queueAssembledRowIcons: vi.fn(),
}));

vi.mock('../../services/api', () => {
  const tauriApi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'getSimilarApps') return mocks.getSimilarApps;
        if (prop === 'fetchStarredStatus') return mocks.fetchStarredStatus;
        if (prop === 'openUrl') return async () => undefined;
        if (prop.startsWith('on')) return async () => () => {};
        return async () => undefined;
      },
    },
  );
  return { tauriApi };
});

vi.mock('../../services/iconStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/iconStore')>();
  return {
    ...actual,
    queueAssembledRowIcons: mocks.queueAssembledRowIcons,
  };
});

import { AppDetailModal } from './index';
import { SimilarAppsSection } from './SimilarAppsSection';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeSummary(id: string, name: string, overrides: Partial<AppSummary> = {}): AppSummary {
  const [owner = 'acme', repo = id] = id.split('/');
  return {
    id,
    name,
    owner,
    repo,
    icon: '',
    icon_bg: 'linear-gradient(135deg, #475569, #334155)',
    description: `${name} description`,
    stars: 1200,
    forks: 40,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'system',
    category_name: '系统实用',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows', 'linux'],
    ...overrides,
  };
}

function makeDetail(id: string, name: string, overrides: Partial<AppDetailViewModel> = {}): AppDetailViewModel {
  return {
    ...makeSummary(id, name),
    changelog: '',
    readme_markdown: '# Hello',
    releases: [],
    isLoading: false,
    ...overrides,
  };
}

describe('SimilarAppsSection & Header alternatives badge', () => {
  it('renders similar cards with CountBadge and calls onSelectApp when clicked', async () => {
    const response: SimilarAppsResponse = {
      target_id: 'rustdesk/rustdesk',
      target_alternatives: ['TeamViewer', 'AnyDesk', 'ToDesk'],
      items: [
        {
          app: makeSummary('acme/moonlight', 'Moonlight', { stars: 25000 }),
          similarity: 0.72,
          reasons: [{ kind: 'keywords', tokens: ['remote', 'desktop'] }],
        },
        {
          app: makeSummary('rustdesk/rustdesk-server', 'RustDesk Server', { stars: 4300 }),
          similarity: 0.65,
          reasons: [{ kind: 'owner', owner: 'rustdesk' }],
        },
      ],
    };
    mocks.getSimilarApps.mockResolvedValueOnce(response);

    const onSelectApp = vi.fn();
    const { container } = render(
      <SimilarAppsSection
        app={makeDetail('rustdesk/rustdesk', 'RustDesk')}
        onSelectApp={onSelectApp}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-similar-section')).toBeTruthy();
    });

    const badge = container.querySelector('.detail-similar-title .count-badge');
    expect(badge?.textContent).toBe('2');
    expect(screen.getByTestId('similar-card-acme/moonlight')).toBeTruthy();
    expect(screen.getByTestId('similar-card-rustdesk/rustdesk-server')).toBeTruthy();
    expect(mocks.queueAssembledRowIcons).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('similar-card-acme/moonlight'));
    expect(onSelectApp).toHaveBeenCalledWith('acme/moonlight');
  });

  it('collapses silently when backend returns empty items', async () => {
    mocks.getSimilarApps.mockResolvedValueOnce({
      target_id: 'acme/solo',
      target_alternatives: [],
      items: [],
    });

    render(<SimilarAppsSection app={makeDetail('acme/solo', 'Solo')} />);

    await waitFor(() => {
      expect(mocks.getSimilarApps).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('detail-similar-section')).toBeNull();
  });

  it('ignores stale responses when app.id changes quickly', async () => {
    let resolveFirst!: (v: SimilarAppsResponse) => void;
    let resolveSecond!: (v: SimilarAppsResponse) => void;

    mocks.getSimilarApps
      .mockImplementationOnce(
        () =>
          new Promise<SimilarAppsResponse>((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SimilarAppsResponse>((r) => {
            resolveSecond = r;
          }),
      );

    const { rerender } = render(
      <SimilarAppsSection app={makeDetail('acme/first', 'First')} />,
    );
    rerender(<SimilarAppsSection app={makeDetail('acme/second', 'Second')} />);

    resolveSecond({
      target_id: 'acme/second',
      target_alternatives: [],
      items: [
        {
          app: makeSummary('acme/new-peer', 'New Peer'),
          similarity: 0.6,
          reasons: [{ kind: 'category', category: 'system' }],
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('similar-card-acme/new-peer')).toBeTruthy();
    });

    resolveFirst({
      target_id: 'acme/first',
      target_alternatives: [],
      items: [
        {
          app: makeSummary('acme/stale-peer', 'Stale Peer'),
          similarity: 0.9,
          reasons: [{ kind: 'owner', owner: 'acme' }],
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByTestId('similar-card-acme/stale-peer')).toBeNull();
      expect(screen.getByTestId('similar-card-acme/new-peer')).toBeTruthy();
    });
  });

  it('shows monochrome alternatives tag in Header when alternatives exist and hides when absent', async () => {
    mocks.getSimilarApps
      .mockResolvedValueOnce({
        target_id: 'rustdesk/rustdesk',
        target_alternatives: ['TeamViewer', 'AnyDesk', 'ToDesk'],
        items: [],
      })
      .mockResolvedValueOnce({
        target_id: 'acme/plain',
        target_alternatives: [],
        items: [],
      });

    const { rerender } = render(
      <AppDetailModal
        app={makeDetail('rustdesk/rustdesk', 'RustDesk', {
          alternatives: ['TeamViewer', 'AnyDesk', 'ToDesk'],
        })}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );

    const tag = screen.getByTestId('detail-alternatives-tag');
    expect(tag.className).toContain('modal-tag');
    expect(tag.textContent).toContain('TeamViewer · AnyDesk');
    expect(tag.getAttribute('title')).toContain('TeamViewer · AnyDesk · ToDesk');

    rerender(
      <AppDetailModal
        app={makeDetail('acme/plain', 'Plain App')}
        isInstalled={false}
        platformLoading={false}
        onClose={() => {}}
        onInstall={async () => {}}
        onLaunch={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('detail-alternatives-tag')).toBeNull();
    });
  });

  it('prefers owner over keywords over category in single-reason badge', async () => {
    mocks.getSimilarApps.mockResolvedValueOnce({
      target_id: 'rustdesk/rustdesk',
      target_alternatives: [],
      items: [
        {
          app: makeSummary('rustdesk/rustdesk-server', 'RustDesk Server'),
          similarity: 0.85,
          reasons: [
            { kind: 'owner', owner: 'rustdesk' },
            { kind: 'keywords', tokens: ['remote', 'relay'] },
            { kind: 'category', category: 'system' },
          ],
        },
        {
          app: makeSummary('acme/peer', 'Peer App'),
          similarity: 0.65,
          reasons: [
            { kind: 'keywords', tokens: ['remote', 'desktop'] },
            { kind: 'category', category: 'system' },
          ],
        },
      ],
    });

    render(<SimilarAppsSection app={makeDetail('rustdesk/rustdesk', 'RustDesk')} />);
    await waitFor(() => {
      expect(screen.getByTestId('similar-card-rustdesk/rustdesk-server')).toBeTruthy();
    });

    const ownerCard = screen.getByTestId('similar-card-rustdesk/rustdesk-server');
    const kwCard = screen.getByTestId('similar-card-acme/peer');
    expect(ownerCard.querySelector('.detail-similar-reason')?.textContent).toBe('同一作者');
    expect(kwCard.querySelector('.detail-similar-reason')?.textContent).toContain('remote / desktop');
  });
});
