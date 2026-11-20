import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSummary, CollectionModalData } from '../types';
import i18n from '../i18n';

const mocks = vi.hoisted(() => ({
  resolveCollectionApps: vi.fn<(ids: readonly string[]) => Promise<AppSummary[]>>(),
}));

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
  return {
    ...actual,
    tauriApi: new Proxy(actual.tauriApi, {
      get(target, prop: string) {
        if (prop === 'resolveCollectionApps') return (ids: readonly string[]) => mocks.resolveCollectionApps(ids);
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

import { CollectionPreviewModal } from './CollectionPreviewModal';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function makeSummary(partial: Partial<AppSummary> & Pick<AppSummary, 'id' | 'name'>): AppSummary {
  const [owner, repo] = partial.id.split('/');
  return {
    owner: owner ?? 'owner',
    repo: repo ?? partial.name.toLowerCase(),
    icon: '',
    icon_bg: '#333333',
    description: `${partial.name} description`,
    stars: 100,
    forks: 10,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'tools',
    category_name: '效率工具',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
    ...partial,
  };
}

const COLLECTION: CollectionModalData = {
  title: 'Rust 装机精选',
  note: '日常开发效率组合',
  app_ids: ['rustdesk/rustdesk', 'localsend/localsend', 'acme/linux-only', 'acme/cold-tool'],
};

const RESOLVED_APPS: AppSummary[] = [
  makeSummary({ id: 'rustdesk/rustdesk', name: 'RustDesk', platforms: ['windows', 'linux'] }),
  makeSummary({ id: 'localsend/localsend', name: 'LocalSend', platforms: ['windows'] }),
  makeSummary({ id: 'acme/linux-only', name: 'LinuxOnly', platforms: ['linux'] }),
  makeSummary({ id: 'acme/cold-tool', name: 'cold-tool', platforms: [], is_cataloged: false, description: '' }),
];

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  mocks.resolveCollectionApps.mockResolvedValue(RESOLVED_APPS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CollectionPreviewModal', () => {
  it('hydrates title, note, CountBadge, and disables installed apps from default selection', async () => {
    render(
      <CollectionPreviewModal
        collection={COLLECTION}
        installedIds={new Set(['rustdesk/rustdesk'])}
        favoriteIds={new Set()}
        onClose={() => {}}
        onInstallApp={async () => {}}
        onToggleFavorite={async () => {}}
      />,
    );

    expect(await screen.findByText('LocalSend')).toBeTruthy();
    expect(mocks.resolveCollectionApps).toHaveBeenCalledWith(COLLECTION.app_ids);

    const heading = screen.getByRole('heading', { name: /Rust 装机精选/ });
    expect(heading.querySelector('.count-badge')?.textContent).toBe('4');
    expect(screen.getByText('日常开发效率组合')).toBeTruthy();

    // 已安装项不默认勾选且禁用，并带 .status-tag 已安装
    const rustdeskBox = screen.getByRole('checkbox', { name: 'RustDesk' }) as HTMLInputElement;
    expect(rustdeskBox.checked).toBe(false);
    expect(rustdeskBox.disabled).toBe(true);
    expect(screen.getByText('已安装')).toBeTruthy();

    // 支持宿主（windows）的未安装项与平台未知占位项默认勾选；仅 linux 项默认不勾选
    const localsendBox = screen.getByRole('checkbox', { name: 'LocalSend' }) as HTMLInputElement;
    const coldBox = screen.getByRole('checkbox', { name: 'cold-tool' }) as HTMLInputElement;
    const linuxBox = screen.getByRole('checkbox', { name: 'LinuxOnly' }) as HTMLInputElement;
    expect(localsendBox.checked).toBe(true);
    expect(coldBox.checked).toBe(true);
    expect(linuxBox.checked).toBe(false);

    // 主按钮不带 CountBadge，底栏叙述摘要显示已选 2 款
    const installBtn = screen.getByRole('button', { name: '安装选中项' });
    expect(installBtn.querySelector('.count-badge')).toBeNull();
    expect(screen.getByText('已选 2 款')).toBeTruthy();
  });

  it('installs selected apps sequentially and continues if one fails', async () => {
    const order: string[] = [];
    const onInstallApp = vi.fn(async (id: string) => {
      order.push(id);
      if (id === 'localsend/localsend') {
        throw new Error('checksum mismatch');
      }
    });
    const showToast = vi.fn();

    render(
      <CollectionPreviewModal
        collection={COLLECTION}
        installedIds={new Set(['rustdesk/rustdesk'])}
        favoriteIds={new Set()}
        onClose={() => {}}
        onInstallApp={onInstallApp}
        onToggleFavorite={async () => {}}
        showToast={showToast}
      />,
    );

    await screen.findByText('LocalSend');
    fireEvent.click(screen.getByRole('button', { name: /安装选中项/ }));

    await waitFor(() => {
      expect(onInstallApp).toHaveBeenCalledTimes(2);
    });
    expect(order).toEqual(['localsend/localsend', 'acme/cold-tool']);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('成功 1 款，失败或跳过 1 款'),
      'warning',
    );
  });

  it('favorites only unfavorited items and supports select-all toggle and detail open', async () => {
    const onToggleFavorite = vi.fn(async () => {});
    const onOpenDetail = vi.fn();
    const showToast = vi.fn();

    render(
      <CollectionPreviewModal
        collection={COLLECTION}
        installedIds={new Set(['rustdesk/rustdesk'])}
        favoriteIds={new Set(['rustdesk/rustdesk', 'localsend/localsend'])}
        onClose={() => {}}
        onOpenDetail={onOpenDetail}
        onInstallApp={async () => {}}
        onToggleFavorite={onToggleFavorite}
        showToast={showToast}
      />,
    );

    await screen.findByText('LocalSend');

    // 点击应用名打开详情
    fireEvent.click(screen.getByRole('button', { name: 'LocalSend' }));
    expect(onOpenDetail).toHaveBeenCalledWith('localsend/localsend');

    // 全选未安装 → 全部 3 个未安装项均选中，再点变为取消全选
    fireEvent.click(screen.getByRole('button', { name: '全选未安装' }));
    expect(screen.getByText('已选 3 款')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getByText('已选 0 款')).toBeTruthy();

    // 全部加入收藏：跳过已收藏的 rustdesk 与 localsend
    fireEvent.click(screen.getByRole('button', { name: '全部加入收藏' }));
    await waitFor(() => {
      expect(onToggleFavorite).toHaveBeenCalledTimes(2);
    });
    expect(onToggleFavorite).toHaveBeenCalledWith('acme/linux-only');
    expect(onToggleFavorite).toHaveBeenCalledWith('acme/cold-tool');
    expect(showToast).toHaveBeenCalledWith('已将 2 款应用加入收藏', 'success');
  });

  it('shows per-item batch install progress and counts cancelled unverified prompts as skipped', async () => {
    let resolveFirst!: (val: 'installed') => void;
    let resolveSecond!: (val: 'cancelled') => void;
    const onInstallApp = vi
      .fn<() => Promise<'installed' | 'cancelled'>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    const showToast = vi.fn();

    render(
      <CollectionPreviewModal
        collection={COLLECTION}
        installedIds={new Set(['rustdesk/rustdesk'])}
        favoriteIds={new Set()}
        onClose={() => {}}
        onInstallApp={onInstallApp}
        onToggleFavorite={async () => {}}
        showToast={showToast}
      />,
    );

    await screen.findByText('LocalSend');
    fireEvent.click(screen.getByRole('button', { name: '安装选中项' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('正在安装第 1 / 2 款：LocalSend');
    });
    expect(screen.getByText('安装中...')).toBeTruthy();

    resolveFirst('installed');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('正在安装第 2 / 2 款：cold-tool');
    });

    resolveSecond('cancelled');
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('成功 1 款，失败或跳过 1 款'),
        'warning',
      );
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('allows loading detail for uncataloged rows with existing description and unchecks newly incompatible rows', async () => {
    const withDesc = makeSummary({
      id: 'acme/cached-desc',
      name: 'CachedDesc',
      description: 'Cached summary without platforms',
      platforms: [],
      is_cataloged: false,
    });
    const hydratedIncompatible = makeSummary({
      id: 'acme/cached-desc',
      name: 'CachedDesc',
      description: 'Cached summary without platforms',
      platforms: ['linux'],
      is_cataloged: false,
    });
    mocks.resolveCollectionApps
      .mockResolvedValueOnce([withDesc])
      .mockResolvedValueOnce([hydratedIncompatible]);
    const onLoadUncatalogedDetail = vi.fn(async () => {});

    render(
      <CollectionPreviewModal
        collection={{ title: 'Test', app_ids: ['acme/cached-desc'] }}
        installedIds={new Set()}
        favoriteIds={new Set()}
        onClose={() => {}}
        onLoadUncatalogedDetail={onLoadUncatalogedDetail}
        onInstallApp={async () => 'installed'}
        onToggleFavorite={async () => {}}
      />,
    );

    const loadBtn = await screen.findByRole('button', { name: '加载详情' });
    const checkbox = screen.getByRole('checkbox', { name: 'CachedDesc' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(loadBtn);
    await waitFor(() => {
      expect(onLoadUncatalogedDetail).toHaveBeenCalledWith('acme/cached-desc');
    });
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: 'CachedDesc' }) as HTMLInputElement).checked).toBe(false);
    });
  });

  it('reports partial or failed favorite-all summary when items return false or throw', async () => {
    const showToast = vi.fn();
    const onToggleFavorite = vi
      .fn<(id: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('db offline'));

    render(
      <CollectionPreviewModal
        collection={COLLECTION}
        installedIds={new Set(['rustdesk/rustdesk'])}
        favoriteIds={new Set(['rustdesk/rustdesk'])}
        onClose={() => {}}
        onInstallApp={async () => 'installed'}
        onToggleFavorite={onToggleFavorite}
        showToast={showToast}
      />,
    );

    await screen.findByText('LocalSend');
    fireEvent.click(screen.getByRole('button', { name: '全部加入收藏' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('已将 1 款应用加入收藏，2 款失败', 'warning');
    });
  });
});
