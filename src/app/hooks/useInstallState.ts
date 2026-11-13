import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, ViewType } from '../../types';
import { tauriApi, UNVERIFIED_ASSET_MARKER } from '../../services/api';

/** 无校验资产待确认状态：D3 门禁拒绝后挂起，待用户在警示弹窗显式确认后重试。 */
interface UnverifiedInstallPrompt {
  id: string;
  assetName?: string;
  customInstallDir?: string;
}

interface UseInstallStateParams {
  currentView: ViewType;
  apps: AppSummary[];
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

export function useInstallState({
  currentView,
  apps,
  showToast,
  t,
}: UseInstallStateParams) {
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [installingAppIds, setInstallingAppIds] = useState<Set<string>>(new Set());
  const [uninstallingAppIds, setUninstallingAppIds] = useState<Set<string>>(new Set());
  // 已装列表初始加载错误（null = 无错误/未加载）：与空列表区分呈现，供 InstalledView 出重试
  const [installLoadError, setInstallLoadError] = useState<string | null>(null);
  // D3 门禁：无校验资产待用户确认（null = 无待确认安装）
  const [unverifiedInstallPrompt, setUnverifiedInstallPrompt] = useState<UnverifiedInstallPrompt | null>(null);

  // 安装集合经 ref 读取，回调引用在搜索、图标升级时保持稳定
  const installingRef = useRef<Set<string>>(installingAppIds);
  installingRef.current = installingAppIds;

  // 安装应用（稳定回调：经 ref 读 installing，搜索键入/图标升级时引用不变）
  const handleInstallApp = useCallback(async (id: string, assetName?: string, customInstallDir?: string, allowUnverified?: boolean): Promise<void> => {
    if (installingRef.current.has(id)) return;
    setInstallingAppIds((prev) => new Set(prev).add(id));
    try {
      const installed = await tauriApi.installApp(id, assetName, customInstallDir, allowUnverified);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()), installed]);
      showToast(t('toast.install_success', { name: installed.app_name }), 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.startsWith(UNVERIFIED_ASSET_MARKER)) {
        // D3 门禁：无校验清单资产默认拒绝。挂起待确认（UI 警示弹窗），非失败态：
        // 不弹错误 toast、不 rethrow，用户确认后经 onConfirm 携 allowUnverified 重试。
        setUnverifiedInstallPrompt({ id, assetName, customInstallDir });
        return;
      }
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('1602')) {
        showToast(t('toast.install_cancelled', { error: errStr }), 'info');
      } else {
        showToast(t('toast.install_failed', { error: errStr }), 'error');
      }
      throw err;
    } finally {
      setInstallingAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [showToast, t]);

  // 无校验资产警示弹窗关闭（确认/取消共用清口）
  const dismissUnverifiedInstall = useCallback(() => {
    setUnverifiedInstallPrompt(null);
  }, []);

  // 快捷安装（稳定回调，供 memo 卡片复用）
  const handleQuickInstall = useCallback(async (id: string) => {
    await handleInstallApp(id);
  }, [handleInstallApp]);

  // 启动应用
  const handleLaunchApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
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
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await tauriApi.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(t('toast.unmanage_success', { name: appName }), 'info');
  };

  // 已装列表加载：进入「我的应用」视图自动触发，失败保存错误态（避免与空列表混同静默）；
  // 同一函数兼作 InstalledView 错误卡的重试入口，以及「检查更新」时的已装状态重读。
  const loadInstalledApps = useCallback(async () => {
    try {
      const freshInstalled = await tauriApi.getInstalledApps();
      setInstalledApps(freshInstalled);
      setInstallLoadError(null);
    } catch (err) {
      setInstallLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    if (currentView === 'installed') {
      void loadInstalledApps();
    }
  }, [currentView, loadInstalledApps]);

  // 卸载应用（触发官方卸载器 -> 等待完成 -> 校验移除 -> 从列表删除）
  const handleUninstallApp = async (id: string) => {
    if (uninstallingAppIds.has(id)) return;
    const app = installedApps.find((a) => a.app_id.toLowerCase() === id.toLowerCase());
    const appName = app?.app_name || apps.find((a) => a.id.toLowerCase() === id.toLowerCase())?.name || id;

    setUninstallingAppIds((prev) => new Set(prev).add(id));
    try {
      await tauriApi.uninstallApp(id);
      // 精准增量从本地管理列表中移除
      setInstalledApps((prev) => prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()));
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
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleUninstallApp,
    unverifiedInstallPrompt,
    dismissUnverifiedInstall,
  };
}
