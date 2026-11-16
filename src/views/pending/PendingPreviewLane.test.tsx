/**
 * 待收录草稿预览卡标签栏：开源协议在平台之前，平台合并为一枚纯图标标签（平台名在悬停提示）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import { PendingPreviewLane } from './PendingPreviewLane';
import { PENDING_EMPTY_DRAFT, type PendingDraftItem } from './draftModel';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function renderLane(form: Partial<PendingDraftItem>, previewPlatforms: string[]) {
  return render(
    <PendingPreviewLane
      form={{ ...PENDING_EMPTY_DRAFT, id: 'o/r', owner: 'o', repo: 'r', license: 'MIT', ...form }}
      previewPlatforms={previewPlatforms}
      expectedId="o/r"
      expanded
      onToggle={() => {}}
    />,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
});

describe('PendingPreviewLane 标签栏', () => {
  it('多平台合并为一枚纯图标标签，平台名只在悬停提示', () => {
    renderLane({}, ['windows', 'macos', 'linux']);
    const tag = screen.getByTestId('pending-preview-platforms');
    expect(tag.querySelectorAll('svg').length).toBe(3);
    expect(tag.textContent).toBe('');
    expect(tag.getAttribute('title')).toBe('支持平台: Windows, macOS, Linux');
  });

  it('开源协议标签位于平台标签之前', () => {
    const { container } = renderLane({}, ['windows']);
    const tags = Array.from(container.querySelectorAll('.pending-preview-tags > .pending-preview-tag'));
    const licenseIdx = tags.findIndex((el) => el.textContent === 'MIT');
    const platformIdx = tags.indexOf(screen.getByTestId('pending-preview-platforms'));
    expect(licenseIdx).toBeGreaterThanOrEqual(0);
    expect(platformIdx).toBeGreaterThan(licenseIdx);
  });

  it('未填写平台时展示占位标签', () => {
    renderLane({}, []);
    expect(screen.queryByTestId('pending-preview-platforms')).toBeNull();
    expect(screen.getByText('未填写平台')).toBeTruthy();
  });
});
