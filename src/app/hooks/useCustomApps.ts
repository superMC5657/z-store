/** 待收录草稿域 hook：管理后端草稿列表、本地库摘要派生与写盘同步。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import {
  entryFromWire,
  entryToCollectedSummary,
  itemToWire,
  type DraftEntry,
  type DraftItem,
} from '../../services/custom';
import { isLocalLibraryStatus } from '../selectors';

export function useCustomApps() {
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

  // 挂载拉取并监听跨视图草稿变更事件
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

  // 侧栏「待收录」角标按平台过滤口径由 `useAppSelectors().pendingFilteredCount` 派生。
  const customAppEntries = useMemo(() => customApps ?? undefined, [customApps]);

  // 写盘后重拉草稿列表并广播目录同步，保持合并目录同代
  const mutateAndReload = useCallback(
    async (mutate: () => Promise<unknown>) => {
      await mutate();
      await reloadCustomApps();
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
    },
    [reloadCustomApps],
  );

  const handleSaveCustomApp = async (draft: DraftItem) => {
    const existing = customApps?.find((e) => e.id === draft.id);
    await mutateAndReload(() => tauriApi.saveCustomApp(itemToWire(draft, existing?.item)));
  };
  const handleDeleteCustomApp = async (id: string) => {
    await mutateAndReload(() => tauriApi.deleteCustomApp(id));
  };
  const handleMarkCustomSubmitted = async (id: string, prUrl: string) => {
    await mutateAndReload(() => tauriApi.markCustomSubmitted(id, prUrl));
  };
  const handleCollectLocalApp = async (id: string) => {
    await mutateAndReload(() => tauriApi.collectLocalApp(id));
  };
  const handleWithdrawSubmitted = async (id: string) => {
    await mutateAndReload(() => tauriApi.withdrawSubmitted(id));
  };
  const handleRevertCollectedApp = async (id: string) => {
    // 失败只向上抛：错误提示由 PendingView 统一出口渲染一次（避免同一次失败两条 toast）。
    await mutateAndReload(() => tauriApi.revertCollectedApp(id));
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
    customAppEntries,
    localLibrarySummaries,
    handleSaveCustomApp,
    handleDeleteCustomApp,
    handleMarkCustomSubmitted,
    handleCollectLocalApp,
    handleWithdrawSubmitted,
    handleRevertCollectedApp,
  };
}
