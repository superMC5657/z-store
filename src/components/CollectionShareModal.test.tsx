import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSummary } from '../types';
import i18n from '../i18n';
import { CollectionShareModal } from './CollectionShareModal';
import {
  COLLECTION_DEFAULT_PRESELECT,
  COLLECTION_MAX_APPS,
  parseCollectionDeepLink,
} from '../utils/collectionShare';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function makeCandidate(i: number, prefix = 'owner'): AppSummary {
  return {
    id: `${prefix}${i}/repo${i}`,
    name: `App ${i}`,
    owner: `${prefix}${i}`,
    repo: `repo${i}`,
    icon: '',
    icon_bg: '#333333',
    description: `Description ${i}`,
    stars: 50 + i,
    forks: 5,
    license: 'MIT',
    latest_version: 'v1.0.0',
    category: 'tools',
    category_name: '效率工具',
    is_verified: true,
    forge: 'github',
    forge_host: 'github.com',
    homepage: null,
    platforms: ['windows'],
  };
}

let writeTextMock = vi.fn<(text: string) => Promise<void>>();

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CollectionShareModal', () => {
  it('preselects first 15 apps and enforces the 30-app limit', () => {
    const apps = Array.from({ length: 34 }, (_, i) => makeCandidate(i));
    render(<CollectionShareModal apps={apps} defaultTitle="我的装机" onClose={() => {}} />);

    // 默认预选 15 款
    const pickerHeader = screen.getByText('已选应用').parentElement;
    expect(pickerHeader?.querySelector('.count-badge')?.textContent).toBe(
      String(COLLECTION_DEFAULT_PRESELECT),
    );

    // 点「全选前 30」选中前 30 款，剩余 4 款复选框禁用
    fireEvent.click(screen.getByRole('button', { name: `全选前 ${COLLECTION_MAX_APPS}` }));
    expect(pickerHeader?.querySelector('.count-badge')?.textContent).toBe(
      String(COLLECTION_MAX_APPS),
    );
    expect(screen.getByText(`已达单次分享上限 ${COLLECTION_MAX_APPS} 款`)).toBeTruthy();
    const lastBox = screen.getByRole('checkbox', { name: 'App 33' }) as HTMLInputElement;
    expect(lastBox.checked).toBe(false);
    expect(lastBox.disabled).toBe(true);
  });

  it('filters candidates, updates preview, and copies deep link and Markdown', async () => {
    const apps = [makeCandidate(1), makeCandidate(2), makeCandidate(3)];
    render(<CollectionShareModal apps={apps} defaultTitle="Rust 装机" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('一句话备注（可选）'), {
      target: { value: '开箱即用' },
    });

    // 搜索过滤并取消勾选 App 2
    fireEvent.change(screen.getByPlaceholderText('筛选应用名称或仓库...'), {
      target: { value: 'App 2' },
    });
    expect(screen.queryByRole('checkbox', { name: 'App 1' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'App 2' }));
    fireEvent.change(screen.getByPlaceholderText('筛选应用名称或仓库...'), {
      target: { value: '' },
    });

    const preview = screen.getByTestId('collection-deeplink-preview').textContent ?? '';
    expect(preview).toContain('zstore://collection?ids=owner1/repo1,owner3/repo3');
    expect(preview).toContain(`title=${encodeURIComponent('Rust 装机')}`);
    expect(preview).toContain(`note=${encodeURIComponent('开箱即用')}`);
    expect(parseCollectionDeepLink(preview)).toEqual({
      title: 'Rust 装机',
      note: '开箱即用',
      app_ids: ['owner1/repo1', 'owner3/repo3'],
    });

    fireEvent.click(screen.getByTestId('collection-copy-deeplink'));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(preview);
    });
    expect(screen.getByRole('status').textContent).toBe('已复制合集深链');

    fireEvent.click(screen.getByTestId('collection-copy-markdown'));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(2);
    });
    const copiedMd = writeTextMock.mock.calls[1][0];
    expect(copiedMd).toContain('# Rust 装机');
    expect(copiedMd).toContain('> 开箱即用');
    expect(copiedMd).toContain('owner1/repo1');
    expect(copiedMd).not.toContain('owner2/repo2');
  });

  it('warns and disables deep link copy when URL exceeds 2048 bytes', async () => {
    const apps = Array.from({ length: 30 }, (_, i) =>
      makeCandidate(i, 'very-long-organization-prefix-segment-'),
    );
    render(<CollectionShareModal apps={apps} defaultTitle={'标题'.repeat(20)} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('一句话备注（可选）'), {
      target: { value: '超长备注说明'.repeat(20) },
    });

    expect(screen.getByTestId('collection-length-warning').textContent).toContain('2048');
    const copyDeepLinkBtn = screen.getByTestId('collection-copy-deeplink') as HTMLButtonElement;
    expect(copyDeepLinkBtn.disabled).toBe(true);
    // Markdown 清单仍可复制，但不再嵌入超过 2048 字节上限的无效深链
    const copyMdBtn = screen.getByTestId('collection-copy-markdown') as HTMLButtonElement;
    expect(copyMdBtn.disabled).toBe(false);
    fireEvent.click(copyMdBtn);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });
    const copiedMd = writeTextMock.mock.calls[0][0];
    expect(copiedMd).toContain('| App 0 |');
    expect(copiedMd).not.toContain('zstore://collection');
  });
});
