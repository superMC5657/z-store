import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import type {
  InstalledApp,
  UpdateCheckProgressPayload,
  UpdateItem,
  UpdateRule,
  ViewType,
} from '../../types';
import { tauriApi } from '../../services/api';
import { normalizeId, normalizeIdLowerSet } from '../../services/normalizeId';
import type { CatalogListsStore } from './useCatalogLists';
import { listenWindowEvent, newMountCtx, releaseMountCtx, trackSubscription, useLatestRef } from './mountCtx';

interface UseUpdatesStateParams {
  catalogLists: Pick<CatalogListsStore, 'setApps' | 'setFullCatalogApps'>;
  setInstalledApps: React.Dispatch<React.SetStateAction<InstalledApp[]>>;
  searchQuery: string;
  currentView: ViewType;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/** 更新与规则状态管理：收口更新列表、规则、检查进度与相关事件订阅。 */
export function useUpdatesState({
  catalogLists,
  setInstalledApps,
  searchQuery,
  currentView,
  showToast,
  t,
}: UseUpdatesStateParams) {
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [updateRules, setUpdateRules] = useState<UpdateRule[]>([]);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateCheckProgress, setUpdateCheckProgress] = useState<UpdateCheckProgressPayload | null>(null);

  const updatesRef = useLatestRef(updates);
  const searchQueryRef = useLatestRef(searchQuery);
  const showToastRef = useLatestRef(showToast);
  const tRef = useLatestRef(t);

  // 初始加载快照 + 流式更新事件 + OAuth 切换重读 DB 快照
  useEffect(() => {
    const ctx = newMountCtx();
    tauriApi
      .getUpdateRules()
      .then((rules) => {
        if (ctx.mounted) setUpdateRules(rules);
      })
      .catch(() => {});
    tauriApi
      .getCachedUpdates()
      .then((rows) => {
        if (ctx.mounted && Array.isArray(rows)) setUpdates(rows);
      })
      .catch(() => {});

    trackSubscription(
      ctx,
      tauriApi.onUpdateItemFound((item) => {
        if (!ctx.mounted) return;
        setUpdates((prev) => {
          const idx = prev.findIndex((u) => u.app_id.toLowerCase() === item.app_id.toLowerCase());
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = item;
            return next;
          }
          return [...prev, item];
        });
      }),
    );

    trackSubscription(
      ctx,
      tauriApi.onUpdateCheckProgress((payload) => {
        if (!ctx.mounted) return;
        setUpdateCheckProgress(payload);
      }),
    );

    trackSubscription(
      ctx,
      tauriApi.onUpdateCheckFinished(() => {
        if (!ctx.mounted) return;
        setIsCheckingUpdates(false);
        setUpdateCheckProgress(null);
      }),
    );

    const handleOAuthChanged = () => {
      tauriApi
        .getCachedUpdates()
        .then((rows) => {
          if (ctx.mounted && Array.isArray(rows)) setUpdates(rows);
        })
        .catch(() => {});
    };
    listenWindowEvent(ctx, 'zstore:oauth-changed', handleOAuthChanged);

    return () => {
      releaseMountCtx(ctx);
    };
  }, []);

  // 进入「我的应用」时重读更新 DB 快照（零网络）
  useEffect(() => {
    if (currentView !== 'installed') return;
    let active = true;
    tauriApi
      .getCachedUpdates()
      .then((rows) => {
        if (active && Array.isArray(rows)) setUpdates(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [currentView]);

  const handleInstalledAppRemoved = useCallback((id: string) => {
    const key = normalizeId(id);
    setUpdates((prev) => prev.filter((u) => normalizeId(u.app_id) !== key));
  }, []);

  const refreshUpdatesSnapshotFromDb = useCallback(() => {
    tauriApi
      .checkForUpdates(false)
      .then((loadedUpdates) => {
        if (Array.isArray(loadedUpdates)) setUpdates(loadedUpdates);
      })
      .catch(() => undefined);
  }, []);

  /**
   * 规则变更共享流水线：写规则 → 可选本地过滤 → 刷新 `updateRules` → 可选重拉 `updates` / 全量与搜索目录 → Toast。
   */
  const runRuleMutation = async (
    rpcCall: () => Promise<unknown>,
    opts: {
      removeUpdateId?: string;
      refreshUpdates?: boolean;
      refreshCatalog?: boolean;
      toastMsg: string;
      toastType?: 'info' | 'success';
    },
  ): Promise<void> => {
    await rpcCall();
    if (opts.removeUpdateId) {
      const key = normalizeId(opts.removeUpdateId);
      setUpdates((prev) => prev.filter((u) => normalizeId(u.app_id) !== key));
    }
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    if (opts.refreshUpdates) {
      const freshUpdates = await tauriApi.checkForUpdates();
      setUpdates(freshUpdates);
    }
    if (opts.refreshCatalog) {
      const fullCatalog = await tauriApi.searchApps('');
      catalogLists.setFullCatalogApps(fullCatalog);
      const currentQuery = searchQueryRef.current;
      catalogLists.setApps(currentQuery.trim() ? await tauriApi.searchApps(currentQuery) : fullCatalog);
    }
    showToastRef.current(opts.toastMsg, opts.toastType ?? 'info');
  };

  const handleApplyUpdate = async (id: string) => {
    try {
      const updatedApp = await tauriApi.installApp(id);
      const key = normalizeId(id);
      setInstalledApps((prev) => [...prev.filter((a) => normalizeId(a.app_id) !== key), updatedApp]);
      setUpdates((prev) => prev.filter((u) => normalizeId(u.app_id) !== key));
      showToastRef.current(tRef.current('toast.update_success', { name: updatedApp.app_name || id }), 'success');
    } catch (err) {
      showToastRef.current(tRef.current('toast.update_failed', { error: String(err) }), 'error');
    }
  };

  const handleSkipVersion = async (id: string, version: string) => {
    await runRuleMutation(() => tauriApi.setAppSkipVersion(id, version), {
      removeUpdateId: id,
      toastMsg: tRef.current('toast.skip_version', { id, version }),
    });
  };

  const handleClearRuleSkip = async (appId: string) => {
    await runRuleMutation(() => tauriApi.setAppSkipVersion(appId, null), {
      refreshUpdates: true,
      toastMsg: tRef.current('toast.restore_rules', { id: appId }),
      toastType: 'success',
    });
  };

  const handleToggleRuleFrozen = async (appId: string, isFrozen: boolean) => {
    await runRuleMutation(() => tauriApi.setAppFrozen(appId, isFrozen), {
      refreshUpdates: true,
      toastMsg: isFrozen ? tRef.current('toast.rule_locked', { id: appId }) : tRef.current('toast.rule_unlocked', { id: appId }),
    });
  };

  const handleToggleRuleHidden = async (appId: string, isHidden: boolean) => {
    await runRuleMutation(() => tauriApi.setAppHidden(appId, isHidden), {
      refreshUpdates: true,
      refreshCatalog: true,
      toastMsg: isHidden ? tRef.current('toast.rule_hidden', { id: appId }) : tRef.current('toast.rule_unhidden', { id: appId }),
    });
  };

  const handleBatchUpdateAll = async (targets: UpdateItem[] = updatesRef.current) => {
    showToastRef.current(tRef.current('toast.batch_update_starting'), 'info');
    let successCount = 0;
    let failCount = 0;
    const updatedIds = new Set<string>();

    for (const u of targets) {
      try {
        const updatedApp = await tauriApi.installApp(u.app_id);
        const key = normalizeId(u.app_id);
        setInstalledApps((prev) => [...prev.filter((a) => normalizeId(a.app_id) !== key), updatedApp]);
        updatedIds.add(key);
        successCount++;
      } catch {
        failCount++;
      }
    }

    setUpdates((prev) => prev.filter((u) => !updatedIds.has(normalizeId(u.app_id))));
    if (failCount === 0) {
      showToastRef.current(tRef.current('toast.batch_update_success', { count: successCount }), 'success');
    } else {
      showToastRef.current(
        tRef.current('toast.batch_update_partial', { success: successCount, fail: failCount }),
        'warning',
      );
    }
  };

  const handleCheckUpdates = async (
    countVisibleUpdatable?: (updates: UpdateItem[], rules: UpdateRule[]) => number,
  ) => {
    showToastRef.current(tRef.current('toast.checking_updates'), 'info');
    setIsCheckingUpdates(true);
    setUpdateCheckProgress({ checked: 0, total: 0, app_id: '', app_name: '' });
    try {
      const freshUpdates = await tauriApi.checkForUpdates(true);
      let displayed = freshUpdates;
      try {
        const cached = await tauriApi.getCachedUpdates();
        if (Array.isArray(cached)) displayed = cached;
      } catch {
        // 快照缺席时回退网络回包
      }
      setUpdates(displayed);
      let rules: UpdateRule[] = [];
      try {
        rules = await tauriApi.getUpdateRules();
        setUpdateRules(rules);
      } catch {
        // 规则读取失败时按无规则计数
      }
      let visibleCount: number;
      if (countVisibleUpdatable) {
        visibleCount = countVisibleUpdatable(displayed, rules);
      } else {
        const hiddenIds = normalizeIdLowerSet(rules.filter((r) => r.is_hidden).map((r) => r.app_id));
        visibleCount = displayed.filter((u) => !hiddenIds.has(normalizeId(u.app_id))).length;
      }
      if (visibleCount === 0) {
        showToastRef.current(tRef.current('toast.all_latest'), 'success');
      } else {
        showToastRef.current(tRef.current('toast.updates_found', { count: visibleCount }), 'info');
      }
    } catch (e) {
      showToastRef.current(tRef.current('toast.check_failed', { error: String(e) }), 'error');
    } finally {
      setIsCheckingUpdates(false);
      setUpdateCheckProgress(null);
    }
  };

  return {
    updates,
    updateRules,
    isCheckingUpdates,
    updateCheckProgress,
    handleInstalledAppRemoved,
    refreshUpdatesSnapshotFromDb,
    handleApplyUpdate,
    handleSkipVersion,
    handleClearRuleSkip,
    handleToggleRuleFrozen,
    handleToggleRuleHidden,
    handleBatchUpdateAll,
    handleCheckUpdates,
  };
}
