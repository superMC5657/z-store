import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import { AffinityPrivacyRow } from './AffinityPrivacyRow';
import { tauriApi } from '../services/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AffinityPrivacyRow 本地推荐画像与隐私数据看板', () => {
  it('正常渲染信号统计、Top 分类与语言，支持切换开关与清空本地画像', async () => {
    const getSummarySpy = vi
      .spyOn(tauriApi, 'getAffinityProfileSummary')
      .mockResolvedValueOnce({
        enabled: true,
        starred_repo_count: 12,
        forked_repo_count: 4,
        owned_repo_count: 3,
        favorites_count: 5,
        watched_count: 2,
        top_categories: [{ category: 'security', weight: 0.91 }],
        top_languages: ['Rust', 'TypeScript'],
        last_synced_at: 1700000500,
      })
      .mockResolvedValueOnce({
        enabled: false,
        starred_repo_count: 0,
        forked_repo_count: 0,
        owned_repo_count: 0,
        favorites_count: 5,
        watched_count: 2,
        top_categories: [],
        top_languages: [],
        last_synced_at: null,
      });
    const saveSettingSpy = vi.spyOn(tauriApi, 'saveSetting').mockResolvedValue(true);
    const resetSpy = vi.spyOn(tauriApi, 'resetAffinityProfile').mockResolvedValue(true);

    render(<AffinityPrivacyRow />);

    await waitFor(() => {
      expect(screen.getByTestId('affinity-privacy-stats').textContent).toContain('12');
    });
    expect(screen.getByTestId('affinity-privacy-stats').textContent).toContain('4');
    expect(screen.getByTestId('affinity-privacy-top-signals').textContent).toContain('Rust / TypeScript');

    // 切换个性化推荐开关
    const toggleBtn = screen.getByTestId('affinity-toggle-btn');
    expect(toggleBtn.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      expect(saveSettingSpy).toHaveBeenCalledWith('enable_local_affinity', 'false');
    });

    // 清空本地画像：第一次点击只进入确认态，文案说明一并清除兴趣与反馈
    const resetBtn = screen.getByTestId('affinity-reset-btn');
    fireEvent.click(resetBtn);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(resetBtn.textContent).toContain('兴趣方向与推荐反馈');
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledTimes(1);
    });
    expect(getSummarySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('旧后端缺少新字段时不渲染新增统计行', async () => {
    vi.spyOn(tauriApi, 'getAffinityProfileSummary').mockResolvedValue({
      enabled: true,
      starred_repo_count: 1,
      forked_repo_count: 0,
      owned_repo_count: 0,
      favorites_count: 0,
      watched_count: 0,
      top_categories: [],
      top_languages: [],
      last_synced_at: null,
    });
    render(<AffinityPrivacyRow />);
    await waitFor(() => {
      expect(screen.getByTestId('affinity-privacy-stats').textContent).toContain('1');
    });
    expect(screen.queryByTestId('affinity-stat-installed')).toBeNull();
    expect(screen.queryByTestId('affinity-clear-feedback-btn')).toBeNull();
    expect(screen.queryByTestId('affinity-interest-seeds')).toBeNull();
  });

  it('展示已装、浏览、搜索、兴趣与反馈；清空反馈需二次确认', async () => {
    vi.spyOn(tauriApi, 'getAffinityProfileSummary').mockResolvedValue({
      enabled: true,
      starred_repo_count: 0,
      forked_repo_count: 0,
      owned_repo_count: 0,
      favorites_count: 0,
      watched_count: 0,
      top_categories: [],
      top_languages: [],
      last_synced_at: null,
      installed_count: 6,
      viewed_count: 9,
      search_query_count: 3,
      interest_seeds: ['dev', 'games'],
      feedback_count: 2,
      signal_count: 20,
    });
    const clearSpy = vi.spyOn(tauriApi, 'clearFeedFeedback').mockResolvedValue(2);
    render(<AffinityPrivacyRow />);
    await waitFor(() => {
      expect(screen.getByTestId('affinity-stat-installed').textContent).toContain('6');
    });
    expect(screen.getByTestId('affinity-stat-viewed').textContent).toContain('9');
    expect(screen.getByTestId('affinity-stat-feedback').textContent).toContain('2');
    expect(screen.getByTestId('affinity-interest-seeds').textContent).toContain('开发工具');

    const btn = screen.getByTestId('affinity-clear-feedback-btn');
    fireEvent.click(btn);
    expect(clearSpy).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });
});
