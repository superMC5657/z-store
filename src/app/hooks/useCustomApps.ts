/**
 * 待收录草稿域 hook（customApps 状态机 + 六个落盘 handler + 派生序列）：
 * 从 App.tsx 迁入（对齐既有 app/hooks 下沉模式），行为与拆分前逐行同口径。
 * - customApps：后端草稿列表（null = 未加载/非 Tauri 预览，
 *   此时 PendingView 缺 entries 走内部本地态；备份/转正语义不受影响）；
 * - 挂载即拉取 + `zstore:custom-apps-changed` 变更跟随；
 * - 六个 handler 均为「后端落盘 → 全量重拉」；revert 失败必须报错并向上传递
 *   （PendingView 侧同样 toast），禁止静默本地翻 draft。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import { entryFromWire, entryToCollectedSummary, itemToWire } from '../../services/custom/mappers';
import type { DraftEntry } from '../../services/custom/types';
import type { PendingDraftItem } from '../../views/PendingView';
import { isLocalLibraryStatus } from '../selectors';

interface UseCustomAppsParams {
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

export function useCustomApps({ showToast, t }: UseCustomAppsParams) {
  // 待收录草稿后端列表（null = 未加载/非 Tauri 预览）。
  const [customApps, setCustomApps] = useState<DraftEntry[] | null>(null);

  // 待收录草稿透传（list/save/delete/markSubmitted 经 tauriApi）。
  const reloadCustomApps = useCallback(async () => {
    try {
      const wires = await tauriApi.listCustomApps(true);
      setCustomApps(wires.map(entryFromWire));
    } catch {
      // 非 Tauri 预览/后端未就绪：保持 null，PendingView 走内部本地态
      setCustomApps(null);
    }
  }, []);

  // 待收录变更跟随（移入收录/备份导入后刷新）+ 挂载即拉取：
  // 本地收录需首页/分类同展，挂载拉取保证首刷补黄（缺席无标，就绪重标），跨视图变更全局跟随。
  useEffect(() => {
    void reloadCustomApps();
    const onChanged = () => {
      void reloadCustomApps();
    };
    window.addEventListener('zstore:custom-apps-changed', onChanged);
    return () => {
      window.removeEventListener('zstore:custom-apps-changed', onChanged);
    };
  }, [reloadCustomApps]);

  const pendingEntries = useMemo(() => customApps ?? undefined, [customApps]);
  const pendingCount = useMemo(
    () => customApps?.filter((e) => !e.archived).length ?? 0,
    [customApps],
  );

  const handleSaveCustomApp = async (draft: PendingDraftItem) => {
    const existing = customApps?.find((e) => e.id === draft.id);
    await tauriApi.saveCustomApp(itemToWire(draft, existing?.item));
    await reloadCustomApps();
  };
  const handleDeleteCustomApp = async (id: string) => {
    await tauriApi.deleteCustomApp(id);
    await reloadCustomApps();
  };
  const handleMarkCustomSubmitted = async (id: string, prUrl: string) => {
    await tauriApi.markCustomSubmitted(id, prUrl);
    await reloadCustomApps();
  };
  const handleCollectLocalApp = async (id: string) => {
    await tauriApi.collectLocalApp(id);
    await reloadCustomApps();
  };
  const handleWithdrawSubmitted = async (id: string) => {
    await tauriApi.withdrawSubmitted(id);
    await reloadCustomApps();
  };
  const handleRevertCollectedApp = async (id: string) => {
    try {
      await tauriApi.revertCollectedApp(id);
      await reloadCustomApps();
    } catch (e) {
      // 落盘失败必须报错并向上传递（PendingView 侧同样 toast），禁止静默本地翻 draft
      // 否则当次停留收录退出、重启又因 DB 仍 collected 而重现。
      const detail = e instanceof Error ? e.message : String(e);
      showToast(
        t('pending.revert_failed', {
          id,
          error: detail,
          defaultValue: `退回草稿失败：${id}：${detail}`,
        }),
        'error',
      );
      throw e;
    }
  };

  // 本地库合并流：仅库内成员（collected 系 + 已提交 submitted）且未归档进入首页/分类（可搜可装，橘黄 local 徽标）。
  const localLibrarySummaries = useMemo(() => {
    const out: Array<AppSummary & { status: string; archived: boolean }> = [];
    for (const e of customApps ?? []) {
      if (e.archived || !isLocalLibraryStatus(e.status)) continue;
      out.push(entryToCollectedSummary(e));
    }
    return out;
  }, [customApps]);

  return {
    customApps,
    pendingEntries,
    pendingCount,
    localLibrarySummaries,
    handleSaveCustomApp,
    handleDeleteCustomApp,
    handleMarkCustomSubmitted,
    handleCollectLocalApp,
    handleWithdrawSubmitted,
    handleRevertCollectedApp,
  };
}
