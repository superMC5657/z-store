/**
 * 待收录草稿域 hook（customApps 状态机 + 六个落盘 handler + 派生序列）：
 * - customApps：后端草稿列表（null = 未加载/非 Tauri 预览，
 *   此时 PendingView 缺 entries 走内部本地态；备份/转正语义不受影响）；
 * - 挂载即拉取 + `zstore:custom-apps-changed` 变更跟随；
 * - 六个 handler 均为「后端落盘 → 全量重拉」；revert 失败必须报错并向上传递
 *   （PendingView 侧同样 toast），禁止静默本地翻 draft。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import { entryFromWire, entryToCollectedSummary, itemToWire } from '../../services/custom/mappers';
import type { DraftEntry, DraftItem } from '../../services/custom/types';
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

  // 落盘后全量重拉：六个 handler 共用同一「写入 → 刷新」序列。
  const mutateAndReload = useCallback(
    async (mutate: () => Promise<unknown>) => {
      await mutate();
      await reloadCustomApps();
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
