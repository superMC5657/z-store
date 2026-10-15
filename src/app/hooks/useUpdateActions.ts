import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, UpdateCheckProgressPayload, UpdateItem, UpdateRule } from '../../types';
import { tauriApi } from '../../services/api';

export interface UseUpdateActionsParams {
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
 * 更新规则动作簇（C3 自 App.tsx 抽出，原 L1119-1260：单项更新/忽略/
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

  // 忽略单项更新（FR-4.4）
  const handleIgnoreUpdate = async (id: string) => {
    const target = updates.find((u) => u.app_id === id);
    await tauriApi.setAppSkipVersion(id, target?.latest_version ?? null);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.skip_update', { id }), 'info');
  };

  // 跳过指定版本（功能 C）
  const handleSkipVersion = async (id: string, version: string) => {
    await tauriApi.setAppSkipVersion(id, version);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.skip_version', { id, version }), 'info');
  };

  // 锁定当前版本（功能 C）
  const handleFreezeVersion = async (id: string) => {
    await tauriApi.setAppFrozen(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.lock_version', { id }), 'info');
  };

  // 隐藏应用（功能 C）
  const handleHideApp = async (id: string) => {
    await tauriApi.setAppHidden(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await tauriApi.getUpdateRules();
    setUpdateRules(rules);
    const catalogApps = await tauriApi.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(t('toast.hide_app', { id }), 'info');
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

  // 批量升级
  const handleBatchUpdateAll = async () => {
    showToast(t('toast.batch_update_starting'), 'info');
    let successCount = 0;
    let failCount = 0;
    const remainingUpdates: UpdateItem[] = [];

    for (const u of updates) {
      try {
        const updatedApp = await tauriApi.installApp(u.app_id);
        setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== u.app_id), updatedApp]);
        successCount++;
      } catch {
        failCount++;
        remainingUpdates.push(u);
      }
    }

    setUpdates(remainingUpdates);
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
    setUpdates([]); // 清空旧列表，使最新检测出来的项目逐个跳出
    setUpdateCheckProgress({ checked: 0, total: 0, app_id: '', app_name: '' });
    try {
      const freshUpdates = await tauriApi.checkForUpdates(true);
      setUpdates(freshUpdates);
      if (freshUpdates.length === 0) {
        showToast(t('toast.all_latest'), 'success');
      } else {
        showToast(t('toast.updates_found', { count: freshUpdates.length }), 'info');
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
    handleIgnoreUpdate,
    handleSkipVersion,
    handleFreezeVersion,
    handleHideApp,
    handleRemoveRule,
    handleClearRuleSkip,
    handleToggleRuleFrozen,
    handleToggleRuleHidden,
    handleBatchUpdateAll,
    handleCheckUpdates,
  };
}
