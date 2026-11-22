/**
 * 待收录页测试装配：挂载真实 `useCustomApps`，在 `tauriApi` 接缝上替换一个内存草稿后端。
 * 只供单测导入（依赖 vitest）。
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { tauriApi } from '../../services/api';
import { itemToWire, type DraftEntryWire, type DraftItemWire } from '../../services/custom';
import type { LicenseAllowlistResult } from '../../services/api/catalog';
import { useCustomApps, type CustomAppsStore } from '../../app/hooks/useCustomApps';
import { PendingView } from '../PendingView';
import type { CustomDraftEntry } from './draftModel';

type PendingViewProps = React.ComponentProps<typeof PendingView>;
export type PendingViewTestProps = Omit<PendingViewProps, 'customApps'>;

type BackendMethod =
  | 'saveCustomApp'
  | 'deleteCustomApp'
  | 'collectLocalApp'
  | 'revertCollectedApp'
  | 'withdrawSubmitted'
  | 'markCustomSubmitted'
  | 'getCustomAppPrUrl'
  | 'getCustomAppPrPayload';

export interface PendingHarnessOptions extends PendingViewTestProps {
  entries?: CustomDraftEntry[];
  /**
   * 替换某个后端写/读方法的实现（不再改内存行，等价后端未变更）：用于注入失败、挂起或断言入参。
   */
  api?: Partial<Record<BackendMethod, (...args: never[]) => unknown>>;
  /** 许可名单响应；缺省即请求失败（与非 Tauri 环境一致）。函数形态可自定义延迟/失败/计数。 */
  gate?: LicenseAllowlistResult | (() => Promise<LicenseAllowlistResult>);
  /** 演示站模式：Issue 预填获取缺席。 */
  demoMode?: boolean;
  prUrl?: string;
  prPayload?: string;
}

export function entryToWire(e: CustomDraftEntry): DraftEntryWire {
  return {
    id: e.id,
    item: { ...itemToWire(e.item), id: e.item.id || e.id },
    status: e.status,
    pr_url: e.pr_url ?? null,
    created_at: 0,
    updated_at: e.updated_at ?? 0,
    archived: e.archived,
  };
}

/** 内存草稿后端：每个方法都是 spy，可用 `mockRejectedValueOnce` 注入失败。 */
export function installPendingBackend(
  options: Pick<PendingHarnessOptions, 'entries' | 'gate' | 'prUrl' | 'prPayload' | 'api'>,
) {
  const rows: DraftEntryWire[] = (options.entries ?? []).map(entryToWire);
  const find = (id: string): DraftEntryWire => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`草稿不存在: ${id}`);
    return row;
  };
  const setStatus = (id: string, status: string, prUrl: string | null) => {
    const row = find(id);
    row.status = status;
    row.pr_url = prUrl;
    return { ...row };
  };
  const gate = options.gate;
  const backend = {
    rows,
    listCustomApps: vi
      .spyOn(tauriApi, 'listCustomApps')
      .mockImplementation(async () => rows.map((r) => ({ ...r, item: { ...r.item } }))),
    saveCustomApp: vi.spyOn(tauriApi, 'saveCustomApp').mockImplementation(async (item: DraftItemWire) => {
      const existing = rows.find((r) => r.id === item.id);
      if (existing) {
        existing.item = { ...item };
        return { ...existing };
      }
      const created: DraftEntryWire = {
        id: item.id,
        item: { ...item },
        status: 'draft',
        pr_url: null,
        created_at: 0,
        updated_at: 0,
        archived: false,
      };
      rows.push(created);
      return { ...created };
    }),
    deleteCustomApp: vi.spyOn(tauriApi, 'deleteCustomApp').mockImplementation(async (id: string) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return idx >= 0;
    }),
    collectLocalApp: vi
      .spyOn(tauriApi, 'collectLocalApp')
      .mockImplementation(async (id: string) => setStatus(id, 'collected', find(id).pr_url ?? null)),
    revertCollectedApp: vi
      .spyOn(tauriApi, 'revertCollectedApp')
      .mockImplementation(async (id: string) => setStatus(id, 'draft', null)),
    withdrawSubmitted: vi
      .spyOn(tauriApi, 'withdrawSubmitted')
      .mockImplementation(async (id: string) => setStatus(id, 'collected', null)),
    markCustomSubmitted: vi
      .spyOn(tauriApi, 'markCustomSubmitted')
      .mockImplementation(async (id: string, prUrl: string) => setStatus(id, 'submitted', prUrl)),
    getCustomAppPrUrl: vi
      .spyOn(tauriApi, 'getCustomAppPrUrl')
      .mockImplementation(async (id: string) => options.prUrl ?? `https://github.com/test/catalog/issues/new?title=${id}`),
    getCustomAppPrPayload: vi
      .spyOn(tauriApi, 'getCustomAppPrPayload')
      .mockImplementation(async (id: string) => options.prPayload ?? JSON.stringify({ id })),
    getLicenseAllowlist: vi.spyOn(tauriApi, 'getLicenseAllowlist').mockImplementation(async () => {
      if (typeof gate === 'function') return gate();
      if (gate) return { ...gate, allowed: [...gate.allowed] };
      throw new Error('license allowlist unavailable');
    }),
  };
  for (const [method, impl] of Object.entries(options.api ?? {})) {
    if (impl) (backend[method as BackendMethod] as { mockImplementation: (f: unknown) => unknown }).mockImplementation(impl);
  }
  return backend;
}

export type PendingBackend = ReturnType<typeof installPendingBackend>;

/** 等待挂载拉取与许可名单预取落定。 */
async function settleMount(backend: PendingBackend): Promise<void> {
  await waitFor(() => expect(backend.listCustomApps).toHaveBeenCalled());
  await act(async () => {
    await Promise.allSettled(backend.listCustomApps.mock.results.map((r) => r.value));
    await Promise.allSettled(backend.getLicenseAllowlist.mock.results.map((r) => r.value));
  });
}

/** 挂载 `useCustomApps` + `PendingView`，等待首屏列表落定后返回。 */
export async function renderPending(options: PendingHarnessOptions = {}) {
  const { entries, gate, demoMode = false, prUrl, prPayload, api, ...viewProps } = options;
  const backend = installPendingBackend({ entries, gate, prUrl, prPayload, api });
  const latest: { current: CustomAppsStore | null } = { current: null };

  function Harness(props: PendingViewTestProps) {
    const store = useCustomApps({ demoMode });
    latest.current = store;
    return <PendingView customApps={store} {...props} />;
  }

  const rendered = render(<Harness {...viewProps} />);
  await settleMount(backend);
  return {
    ...rendered,
    backend,
    store: () => latest.current!,
    rerenderView: (next: PendingViewTestProps) => rendered.rerender(<Harness {...viewProps} {...next} />),
  };
}
