import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, ViewType } from '../../types';
import { api } from '../../services/api';
import { zlogInfo } from '../../lib/z-log';

export interface UseInstallStateParams {
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
  const [detectedAppIds, setDetectedAppIds] = useState<Set<string>>(new Set());

  // 安装集合经 ref 读取，回调引用在搜索、图标升级时保持稳定
  const installingRef = useRef<Set<string>>(installingAppIds);
  installingRef.current = installingAppIds;

  // 安装应用（稳定回调：经 ref 读 installing，搜索键入/图标升级时引用不变）
  const handleInstallApp = useCallback(async (id: string, assetName?: string, customInstallDir?: string): Promise<void> => {
    if (installingRef.current.has(id)) return;
    zlogInfo(`click install id=${id} asset=${assetName || 'auto'}`);
    setInstallingAppIds((prev) => new Set(prev).add(id));
    try {
      const installed = await api.installApp(id, assetName, customInstallDir);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()), installed]);
      setDetectedAppIds((prev) => new Set(prev).add(id).add(id.toLowerCase()));
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
      await api.launchApp(id);
      showToast(t('toast.launch_success', { name: appName }), 'success');
    } catch (err) {
      showToast(t('toast.launch_failed', { error: String(err) }), 'error');
    }
  };

  // 取消管理应用（从 Z-Store 列表中移除，保留本地文件完好）
  const handleUnmanageApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await api.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(t('toast.unmanage_success', { name: appName }), 'info');
  };

  // 刷新已安装应用列表（幽灵应用自愈清理 + 重新扫描探测应用）
  const handleRefreshInstalledApps = async () => {
    setIsRefreshingInstalled(true);
    try {
      const [freshInstalled, freshDetected] = await Promise.all([
        api.getInstalledApps(),
        api.getDetectedInstalledAppIds(true),
      ]);
      setInstalledApps(freshInstalled);
      setDetectedAppIds(new Set(freshDetected.map((id) => id.toLowerCase())));
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
      api.getInstalledApps().then(setInstalledApps).catch(() => undefined);
    }
  }, [currentView]);

  // 将探测到的应用纳入 Z-Store 管理
  const handleManageApp = async (id: string) => {
    try {
      await api.importSingleApp(id);
      const updatedList = await api.getInstalledApps();
      setInstalledApps(updatedList);
      setDetectedAppIds((prev) => new Set([...prev, id]));
      showToast(t('toast.import_success'), 'success');
    } catch {
      /* 导入静默失败；列表保持不变 */
    }
  };

  // 卸载应用（触发官方卸载器 -> 等待完成 -> 校验移除 -> 从列表删除）
  const handleUninstallApp = async (id: string) => {
    if (uninstallingAppIds.has(id)) return;
    zlogInfo(`click uninstall id=${id}`);
    const app = installedApps.find((a) => a.app_id.toLowerCase() === id.toLowerCase());
    const appName = app?.app_name || apps.find((a) => a.id.toLowerCase() === id.toLowerCase())?.name || id;

    setUninstallingAppIds((prev) => new Set(prev).add(id));
    try {
      await api.uninstallApp(id);
      // 1. 精准增量从本地管理列表中移除
      setInstalledApps((prev) => prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()));
      // 2. 精准增量从系统探测列表中剔除（纯内存 O(1) 更新，完全无需触发全盘重扫）
      setDetectedAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        next.delete(id.toLowerCase());
        return next;
      });
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
    detectedAppIds,
    setDetectedAppIds,
    installingRef,
    handleInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleRefreshInstalledApps,
    handleManageApp,
    handleUninstallApp,
  };
}
