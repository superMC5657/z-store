import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, ViewType } from '../../types';
import { tauriApi, UNVERIFIED_ASSET_MARKER } from '../../services/api';
import { normalizeId } from '../../services/normalizeId';

/** 无校验资产待确认状态：后端拒绝后挂起，待用户在警示弹窗确认后重试。 */
interface UnverifiedInstallPrompt {
  id: string;
  assetName?: string;
  customInstallDir?: string;
}

export type BatchInstallOutcome = 'installed' | 'cancelled' | 'skipped';

interface UseInstallStateParams {
  currentView: ViewType;
  apps: AppSummary[];
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
  /** 卸载或取消管理成功后回调（入参为调用方传入的原始 id），供调用方清理该应用的残留更新项。 */
  onAppRemoved?: (id: string) => void;
  /** 由上层状态域持有的已装列表（`useMyAppsState` 与更新域共享同一份）；缺省用内部状态。 */
  installedState?: [InstalledApp[], Dispatch<SetStateAction<InstalledApp[]>>];
}

export function useInstallState({
  currentView,
  apps,
  showToast,
  t,
  onAppRemoved,
  installedState,
}: UseInstallStateParams) {
  const ownInstalledState = useState<InstalledApp[]>([]);
  const [installedApps, setInstalledApps] = installedState ?? ownInstalledState;
  const [installingAppIds, setInstallingAppIds] = useState<Set<string>>(new Set());
  const [uninstallingAppIds, setUninstallingAppIds] = useState<Set<string>>(new Set());
  // 已装列表初始加载错误（null = 无错误/未加载）：与空列表区分呈现，供 InstalledView 出重试
  const [installLoadError, setInstallLoadError] = useState<string | null>(null);
  // 无校验资产待用户确认状态（null = 无待确认安装）
  const [unverifiedInstallPrompt, setUnverifiedInstallPrompt] = useState<UnverifiedInstallPrompt | null>(null);
  const unverifiedPromptRef = useRef<UnverifiedInstallPrompt | null>(null);
  const unverifiedWaiterRef = useRef<{ resolve: (confirmed: boolean) => void } | null>(null);

  const setUnverifiedPrompt = useCallback((next: UnverifiedInstallPrompt | null) => {
    unverifiedPromptRef.current = next;
    setUnverifiedInstallPrompt(next);
  }, []);

  useEffect(() => {
    return () => {
      const waiter = unverifiedWaiterRef.current;
      if (waiter) {
        unverifiedWaiterRef.current = null;
        waiter.resolve(false);
      }
    };
  }, []);

  // 安装集合经 ref 同步维护，回调引用稳定且同 tick 连续重试不读到陈旧集合
  const installingRef = useRef<Set<string>>(new Set());

  const addInstallingId = useCallback((id: string) => {
    if (!installingRef.current.has(id)) {
      const next = new Set(installingRef.current);
      next.add(id);
      installingRef.current = next;
    }
    setInstallingAppIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const removeInstallingId = useCallback((id: string) => {
    if (installingRef.current.has(id)) {
      const next = new Set(installingRef.current);
      next.delete(id);
      installingRef.current = next;
    }
    setInstallingAppIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // 安装应用（稳定回调：经 ref 读 installing，搜索键入/图标升级时引用不变）
  const handleInstallApp = useCallback(async (id: string, assetName?: string, customInstallDir?: string, allowUnverified?: boolean): Promise<void> => {
    if (installingRef.current.has(id)) return;
    addInstallingId(id);
    try {
      const installed = await tauriApi.installApp(id, assetName, customInstallDir, allowUnverified);
      const key = normalizeId(id);
      setInstalledApps((prev) => [...prev.filter((a) => normalizeId(a.app_id) !== key), installed]);
      showToast(t('toast.install_success', { name: installed.app_name }), 'success');
    } catch (err) {
      const errStr = String(err);
      if (!allowUnverified && errStr.startsWith(UNVERIFIED_ASSET_MARKER)) {
        // 无校验清单资产由弹窗确认放行，不按失败处理
        setUnverifiedPrompt({ id, assetName, customInstallDir });
        return;
      }
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('1602')) {
        showToast(t('toast.install_cancelled', { error: errStr }), 'info');
      } else {
        showToast(t('toast.install_failed', { error: errStr }), 'error');
      }
      throw err;
    } finally {
      removeInstallingId(id);
    }
  }, [addInstallingId, removeInstallingId, setUnverifiedPrompt, showToast, t]);

  // 批量安装专用的单条执行器：命中无校验清单时挂起等待 InstallConfirmDialog 决策后再继续下一款
  const handleBatchInstallApp = useCallback(async (id: string): Promise<BatchInstallOutcome> => {
    if (installingRef.current.has(id)) return 'skipped';
    let needsConfirm = false;
    addInstallingId(id);
    try {
      const installed = await tauriApi.installApp(id);
      const key = normalizeId(id);
      setInstalledApps((prev) => [...prev.filter((a) => normalizeId(a.app_id) !== key), installed]);
      showToast(t('toast.install_success', { name: installed.app_name }), 'success');
      return 'installed';
    } catch (err) {
      const errStr = String(err);
      if (errStr.startsWith(UNVERIFIED_ASSET_MARKER)) {
        needsConfirm = true;
      } else {
        if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('1602')) {
          showToast(t('toast.install_cancelled', { error: errStr }), 'info');
        } else {
          showToast(t('toast.install_failed', { error: errStr }), 'error');
        }
        throw err;
      }
    } finally {
      removeInstallingId(id);
    }

    if (needsConfirm) {
      const prevWaiter = unverifiedWaiterRef.current;
      if (prevWaiter) {
        unverifiedWaiterRef.current = null;
        prevWaiter.resolve(false);
      }
      const confirmed = await new Promise<boolean>((resolve) => {
        unverifiedWaiterRef.current = { resolve };
        setUnverifiedPrompt({ id });
      });
      if (!confirmed) {
        return 'cancelled';
      }
      await handleInstallApp(id, undefined, undefined, true);
      return 'installed';
    }

    return 'skipped';
  }, [addInstallingId, handleInstallApp, removeInstallingId, setUnverifiedPrompt, showToast, t]);

  // 无校验资产警示弹窗取消（同时唤醒阻塞中的批量安装流程）
  const dismissUnverifiedInstall = useCallback(() => {
    setUnverifiedPrompt(null);
    const waiter = unverifiedWaiterRef.current;
    if (waiter) {
      unverifiedWaiterRef.current = null;
      waiter.resolve(false);
    }
  }, [setUnverifiedPrompt]);

  // 无校验资产警示弹窗确认：批量场景交由等待方同步继续，单次场景立即携带 allowUnverified 重试
  const confirmUnverifiedInstall = useCallback(() => {
    const pending = unverifiedPromptRef.current;
    setUnverifiedPrompt(null);
    const waiter = unverifiedWaiterRef.current;
    if (waiter) {
      unverifiedWaiterRef.current = null;
      waiter.resolve(true);
      return;
    }
    if (pending) {
      void handleInstallApp(pending.id, pending.assetName, pending.customInstallDir, true);
    }
  }, [handleInstallApp, setUnverifiedPrompt]);

  // 快捷安装（稳定回调，供 memo 卡片复用）
  const handleQuickInstall = useCallback(async (id: string) => {
    await handleInstallApp(id);
  }, [handleInstallApp]);

  // 启动应用
  const handleLaunchApp = async (id: string) => {
    const key = normalizeId(id);
    const app = installedApps.find((a) => normalizeId(a.app_id) === key);
    const appName = app ? app.app_name : id;
    try {
      await tauriApi.launchApp(id);
      showToast(t('toast.launch_success', { name: appName }), 'success');
    } catch (err) {
      showToast(t('toast.launch_failed', { error: String(err) }), 'error');
    }
  };

  // 取消管理应用（从 ZStore 列表中移除，保留本地文件完好）
  const handleUnmanageApp = async (id: string) => {
    const key = normalizeId(id);
    const app = installedApps.find((a) => normalizeId(a.app_id) === key);
    const appName = app?.app_name || id;
    await tauriApi.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => normalizeId(a.app_id) !== key));
    onAppRemoved?.(id);
    showToast(t('toast.unmanage_success', { name: appName }), 'info');
  };

  // 加载已装列表（进入「我的应用」触发，亦作错误重试与检查更新重读入口）；并发挂载单飞复用。
  const inflightLoadRef = useRef<Promise<void> | null>(null);
  const loadInstalledApps = useCallback(() => {
    if (inflightLoadRef.current) return inflightLoadRef.current;
    const promise = (async () => {
      try {
        const freshInstalled = await tauriApi.getInstalledApps();
        setInstalledApps(freshInstalled);
        setInstallLoadError(null);
      } catch (err) {
        setInstallLoadError(String(err));
      }
    })();
    inflightLoadRef.current = promise;
    void promise.finally(() => {
      if (inflightLoadRef.current === promise) {
        inflightLoadRef.current = null;
      }
    });
    return promise;
  }, [setInstalledApps]);

  useEffect(() => {
    if (currentView === 'installed') {
      void loadInstalledApps();
    }
  }, [currentView, loadInstalledApps]);

  // 卸载应用（触发官方卸载器 -> 等待完成 -> 校验移除 -> 从列表删除）
  const handleUninstallApp = async (id: string) => {
    if (uninstallingAppIds.has(id)) return;
    const key = normalizeId(id);
    const app = installedApps.find((a) => normalizeId(a.app_id) === key);
    const appName = app?.app_name || apps.find((a) => normalizeId(a.id) === key)?.name || id;

    setUninstallingAppIds((prev) => new Set(prev).add(id));
    try {
      await tauriApi.uninstallApp(id);
      // 精准增量从本地管理列表中移除
      setInstalledApps((prev) => prev.filter((a) => normalizeId(a.app_id) !== key));
      onAppRemoved?.(id);
      showToast(t('toast.uninstall_success', { name: appName }), 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('保留') || errStr.includes('1602')) {
        showToast(t('toast.uninstall_cancelled'), 'info');
      } else {
        showToast(t('toast.uninstall_failed', { error: errStr }), 'error');
      }
    } finally {
      setUninstallingAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return {
    installedApps,
    setInstalledApps,
    installingAppIds,
    setInstallingAppIds,
    uninstallingAppIds,
    setUninstallingAppIds,
    installLoadError,
    loadInstalledApps,
    installingRef,
    handleInstallApp,
    handleBatchInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleUninstallApp,
    unverifiedInstallPrompt,
    dismissUnverifiedInstall,
    confirmUnverifiedInstall,
  };
}
