import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, UpdateCheckProgressPayload, UpdateItem, UpdateRule } from '../../types';
import { tauriApi } from '../../services/api';

interface UseUpdateActionsParams {
  updates: UpdateItem[];
  setUpdates: React.Dispatch<React.SetStateAction<UpdateItem[]>>;
  setInstalledApps: React.Dispatch<React.SetStateAction<InstalledApp[]>>;
  setUpdateRules: React.Dispatch<React.SetStateAction<UpdateRule[]>>;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setIsCheckingUpdates: React.Dispatch<React.SetStateAction<boolean>>;
  setUpdateCheckProgress: React.Dispatch<React.SetStateAction<UpdateCheckProgressPayload | null>>;
  searchQuery: string;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * 更新规则动作簇（C3 自 App.tsx 抽出，原 L1119-1260：单项更新/
 * 跳过版本/锁定/隐藏/移除规则/清除跳过/切换锁定隐藏/批量升级/手动检查）。
 */
export function useUpdateActions({
  updates,
  setUpdates,
  setInstalledApps,
  setUpdateRules,
  setApps,
  setIsCheckingUpdates,
  setUpdateCheckProgress,
  searchQuery,
  showToast,
  t,
}: UseUpdateActionsParams) {
  // 应用单项更新
  const handleApplyUpdate = async (id: string) => {
    try {
      const updatedApp = await tauriApi.installApp(id);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== id), updatedApp]);
      setUpdates((prev) => prev.filter((u) => u.app_id !== id));
      showToast(t('toast.update_success', { name: updatedApp.app_name || id }), 'success');
    } catch (err) {
      showToast(t('toast.update_failed', { error: String(err) }), 'error');
    }
  };

  // 跳过指定版本
  const handleSkipVersion = async (id: string, version: string) => {
    await tauriApi.setAppSkipVersion(id, version);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.skip_version', { id, version }), 'info');
  };

  // 移除规则（功能 C）
  const handleRemoveRule = async (appId: string) => {
    await tauriApi.removeUpdateRule(appId);
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await tauriApi.checkForUpdates();
    setUpdates(freshUpdates);
    const catalogApps = await tauriApi.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(t('toast.clear_rules', { id: appId }), 'success');
  };

  // 清除跳过版本规则
  const handleClearRuleSkip = async (appId: string) => {
    await tauriApi.setAppSkipVersion(appId, null);
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await tauriApi.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(t('toast.restore_rules', { id: appId }), 'success');
  };

  // 切换版本锁定状态
  const handleToggleRuleFrozen = async (appId: string, isFrozen: boolean) => {
    await tauriApi.setAppFrozen(appId, isFrozen);
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await tauriApi.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(isFrozen ? t('toast.rule_locked', { id: appId }) : t('toast.rule_unlocked', { id: appId }), 'info');
  };

  // 切换应用隐藏状态
  const handleToggleRuleHidden = async (appId: string, isHidden: boolean) => {
    await tauriApi.setAppHidden(appId, isHidden);
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await tauriApi.checkForUpdates();
    setUpdates(freshUpdates);
    const catalogApps = await tauriApi.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(isHidden ? t('toast.rule_hidden', { id: appId }) : t('toast.rule_unhidden', { id: appId }), 'info');
  };

  // 批量升级：只升 `targets`（「我的应用」当前可见的可更新行）；缺省为全部更新项。
  // 成功项从快照剔除，失败项与不在目标内的项保留。
  const handleBatchUpdateAll = async (targets: UpdateItem[] = updates) => {
    showToast(t('toast.batch_update_starting'), 'info');
    let successCount = 0;
    let failCount = 0;
    const updatedIds = new Set<string>();

    for (const u of targets) {
      try {
        const updatedApp = await tauriApi.installApp(u.app_id);
        setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== u.app_id), updatedApp]);
        updatedIds.add(u.app_id);
        successCount++;
      } catch {
        failCount++;
      }
    }

    setUpdates((prev) => prev.filter((u) => !updatedIds.has(u.app_id)));
    if (failCount === 0) {
      showToast(t('toast.batch_update_success', { count: successCount }), 'success');
    } else {
      showToast(t('toast.batch_update_partial', { success: successCount, fail: failCount }), 'warning');
    }
  };

  // 手动触发检查更新
  const handleCheckUpdates = async () => {
    showToast(t('toast.checking_updates'), 'info');
    setIsCheckingUpdates(true);
    // 检查期间保留旧快照：已装行的更新态与「全部更新」不因检查而闪没，结果回来后整体替换
    setUpdateCheckProgress({ checked: 0, total: 0, app_id: '', app_name: '' });
    try {
      const freshUpdates = await tauriApi.checkForUpdates(true);
      // force 写库后重读 DB 快照（与登录/切签首屏同口径；规则过滤与剪枝已在写侧收敛）。
      let displayed = freshUpdates;
      try {
        const cached = await tauriApi.getCachedUpdates();
        if (Array.isArray(cached)) displayed = cached;
      } catch {
        // 快照缺席时回退网络回包
      }
      setUpdates(displayed);
      if (displayed.length === 0) {
        showToast(t('toast.all_latest'), 'success');
      } else {
        showToast(t('toast.updates_found', { count: displayed.length }), 'info');
      }
    } catch (e) {
      showToast(t('toast.check_failed', { error: String(e) }), 'error');
    } finally {
      setIsCheckingUpdates(false);
      setUpdateCheckProgress(null);
    }
  };

  return {
    handleApplyUpdate,
    handleSkipVersion,
    handleRemoveRule,
    handleClearRuleSkip,
    handleToggleRuleFrozen,
    handleToggleRuleHidden,
    handleBatchUpdateAll,
    handleCheckUpdates,
  };
}
