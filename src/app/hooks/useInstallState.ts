import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, ViewType } from '../../types';
import { tauriApi } from '../../services/api';
import { zlogInfo } from '../../lib/z-log';

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
  const [isRefreshingInstalled, setIsRefreshingInstalled] = useState(false);

  // 安装集合经 ref 读取，回调引用在搜索、图标升级时保持稳定
  const installingRef = useRef<Set<string>>(installingAppIds);
  installingRef.current = installingAppIds;

  // 安装应用（稳定回调：经 ref 读 installing，搜索键入/图标升级时引用不变）
  const handleInstallApp = useCallback(async (id: string, assetName?: string, customInstallDir?: string): Promise<void> => {
    if (installingRef.current.has(id)) return;
    zlogInfo(`click install id=${id} asset=${assetName || 'auto'}`);
    setInstallingAppIds((prev) => new Set(prev).add(id));
    try {
      const installed = await tauriApi.installApp(id, assetName, customInstallDir);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()), installed]);
      showToast(t('toast.install_success', { name: installed.app_name }), 'success');
    } catch (err) {
      const errStr = String(err);
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

  // 快捷安装（稳定回调，供 memo 卡片复用）
  const handleQuickInstall = useCallback(async (id: string) => {
    await handleInstallApp(id);
  }, [handleInstallApp]);

  // 启动应用
  const handleLaunchApp = async (id: string) => {
    zlogInfo(`click launch id=${id}`);
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

  // 刷新已安装应用列表（幽灵应用自愈清理）
  const handleRefreshInstalledApps = async () => {
    setIsRefreshingInstalled(true);
    try {
      const freshInstalled = await tauriApi.getInstalledApps();
      setInstalledApps(freshInstalled);
      showToast(t('toast.refresh_installed_success'), 'success');
    } catch (err) {
      showToast(t('toast.refresh_installed_failed', { error: String(err) }), 'error');
    } finally {
      setIsRefreshingInstalled(false);
    }
  };

  // 当用户切换至「已安装应用」视图时，自动触发后台校验与幽灵应用自愈清理
  useEffect(() => {
    if (currentView === 'installed') {
      tauriApi.getInstalledApps().then(setInstalledApps).catch(() => undefined);
    }
  }, [currentView]);

  // 卸载应用（触发官方卸载器 -> 等待完成 -> 校验移除 -> 从列表删除）
  const handleUninstallApp = async (id: string) => {
    if (uninstallingAppIds.has(id)) return;
    zlogInfo(`click uninstall id=${id}`);
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
    isRefreshingInstalled,
    installingRef,
    handleInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleRefreshInstalledApps,
    handleUninstallApp,
  };
}
