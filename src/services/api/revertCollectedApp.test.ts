/**
 * 退回草稿回归：命令名对齐 + 落盘可见 + draft 不再进收录。
 * 后端规范命令为 `revert_collected_to_draft`，
 * 前端 CMD 必须指向规范名，否则 invoke 走旧名在新后端缺席时静默本地翻态、
 * 重启因 DB 仍 collected 而重现。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CMD } from '../api';
import { isCollectedStatus } from '../../app/selectors';
import * as clientModule from './client';
import { revertCollectedApp } from './catalog';

describe('revertCollectedApp command alignment + persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(clientModule, 'isTauri', 'get').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CMD points at backend canonical command', () => {
    expect(CMD.revertCollectedApp).toBe('revert_collected_to_draft');
  });

  it('invokes canonical cmd with camelCase {id} and surfaces persisted draft', async () => {
    const captured: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    vi.spyOn(clientModule, 'tauriInvoke').mockImplementation(async (cmd: string, args = {}) => {
      captured.push({ cmd, args: { ...(args as Record<string, unknown>) } });
      // 后端落盘回执：status=draft，调用方可直接用于刷新（重启重读同样 draft）。
      return {
        id: 'o/r',
        item: { id: 'o/r' },
        status: 'draft',
        pr_url: null,
        created_at: 1,
        updated_at: 2,
        archived: false,
      } as never;
    });
    const entry = await revertCollectedApp('o/r');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ cmd: 'revert_collected_to_draft', args: { id: 'o/r' } });
    expect(entry.status).toBe('draft');
    // draft 不再是收录态：collectedSummaries/overlay 同一口径过滤。
    expect(isCollectedStatus(entry.status)).toBe(false);
    expect(isCollectedStatus('collected')).toBe(true);
    expect(isCollectedStatus('local_collected')).toBe(true);
  });
});
