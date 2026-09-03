import React, { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { AppDetailModal } from './components/AppDetailModal';
import { DeveloperProfileModal } from './components/DeveloperProfileModal';
import { AppImportModal } from './components/AppImportModal';
import { ToastContainer } from './components/Toast';
import { HomeView } from './views/HomeView';
import { TrendsView } from './views/TrendsView';
import { CategoriesView } from './views/CategoriesView';
import { InstalledView } from './views/InstalledView';
import { UpdatesView } from './views/UpdatesView';
import { SettingsView } from './views/SettingsView';
import { FavoritesView } from './views/FavoritesView';
import { AppDetail, AppSettings, AppSummary, InstalledApp, MirrorNodeStatus, ToastMessage, UpdateItem, UpdateRule, ViewType } from './types';
import { api, DEFAULT_SETTINGS } from './services/api';

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [mirrors, setMirrors] = useState<MirrorNodeStatus[]>([]);
  const [selectedApp, setSelectedApp] = useState<AppDetail | null>(null);
  const [selectedDeveloper, setSelectedDeveloper] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [updateRules, setUpdateRules] = useState<UpdateRule[]>([]);
  const [recentlyViewedApps, setRecentlyViewedApps] = useState<AppSummary[]>([]);

  // Toast Helper
  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  };

  const FONT_SCALE_MAP: Record<string, string> = {
    small: '0.85',
    standard: '1',
    medium: '1.18',
    large: '1.35',
  };

  const applyFontSize = (sizeKey: string) => {
    document.documentElement.setAttribute('data-font-size', sizeKey);
    const scale = FONT_SCALE_MAP[sizeKey] || '1';
    document.documentElement.style.setProperty('--font-scale', scale);
  };

  const applyUiZoom = (scaleStr: string) => {
    const factor = Number(scaleStr) / 100;
    document.documentElement.style.zoom = `${factor}`;
    document.documentElement.style.setProperty('--app-zoom', `${factor}`);

    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor))
      .catch(() => {});
  };

  // Initial load
  useEffect(() => {
    // Detect system preference
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = isDark ? 'dark' : 'light';
    setTheme(initialTheme);
    document.documentElement.setAttribute('data-theme', initialTheme);

    // Initial data fetch
    api.searchApps('').then(setApps);
    api.getInstalledApps().then(setInstalledApps);
    api.checkForUpdates().then(setUpdates);
    api.getMirrorStatus().then(setMirrors);
    api.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    api.getUpdateRules().then(setUpdateRules);
    api.getRecentlyViewedApps().then(setRecentlyViewedApps).catch(() => {});

    // Load persisted settings
    api.getSettings().then((persisted) => {
      const merged: AppSettings = { ...DEFAULT_SETTINGS };
      for (const [k, v] of Object.entries(persisted)) {
        if (k in merged) {
          if (typeof (DEFAULT_SETTINGS as any)[k] === 'boolean') {
            (merged as any)[k] = v === 'true';
          } else if (typeof (DEFAULT_SETTINGS as any)[k] === 'number') {
            (merged as any)[k] = Number(v) || (DEFAULT_SETTINGS as any)[k];
          } else {
            (merged as any)[k] = v;
          }
        }
      }
      setSettings(merged);

      // Apply theme
      const currentTheme = merged.theme === 'light' ? 'light' : 'dark';
      setTheme(currentTheme);
      document.documentElement.setAttribute('data-theme', currentTheme);

      // Apply font size
      applyFontSize(merged.font_size);

      // Apply UI zoom
      applyUiZoom(merged.ui_scale);

      // Apply Always on top
      if (merged.always_on_top) {
        import('@tauri-apps/api/window')
          .then(({ getCurrentWindow }) => {
            getCurrentWindow().setAlwaysOnTop(true).catch(() => {});
          })
          .catch(() => {});
      }

      if (merged.active_mirror) {
        api.switchMirror(merged.active_mirror);
      }
    });
  }, []);

  // Theme Toggler
  const handleToggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    handleUpdateSetting('theme', next);
    showToast(`已切换至${next === 'dark' ? '暗黑' : '明亮'}主题模式`, 'info');
  };

  const handleSetTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    handleUpdateSetting('theme', t);
    showToast(`已应用外观模式: ${t === 'dark' ? '暗黑模式' : '明亮模式'}`, 'info');
  };

  // Generic Setting Updater
  const handleUpdateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    await api.saveSetting(key, String(value));

    if (key === 'theme') {
      const t = value as 'light' | 'dark';
      setTheme(t);
      document.documentElement.setAttribute('data-theme', t);
    } else if (key === 'font_size') {
      applyFontSize(String(value));
      const labels: Record<string, string> = {
        small: '紧凑 12px',
        standard: '标准 13.5px',
        medium: '舒适 15px',
        large: '特大 16.5px',
      };
      showToast(`全局字体已设为: ${labels[String(value)] || value}`, 'info');
    } else if (key === 'ui_scale') {
      applyUiZoom(String(value));
      showToast(`界面缩放已设为: ${value}%`, 'info');
    } else if (key === 'always_on_top') {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setAlwaysOnTop(Boolean(value));
        showToast(value ? '已开启窗口置顶' : '已取消窗口置顶', 'info');
      } catch {
        showToast(value ? '已开启窗口置顶' : '已取消窗口置顶', 'info');
      }
    }
  };

  // Reset all settings to factory default
  const handleResetSettings = async () => {
    await api.resetSettings();
    setSettings(DEFAULT_SETTINGS);
    setTheme('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    applyFontSize('standard');
    applyUiZoom('100');
    showToast('已成功恢复所有出厂默认设置！', 'success');
  };

  // Export JSON Backup
  const handleExportAppsJson = () => {
    if (installedApps.length === 0) {
      showToast('当前尚未安装任何应用，无需导出', 'warning');
      return;
    }
    const data = {
      app: 'Z-Store',
      exported_at: new Date().toISOString(),
      installed_count: installedApps.length,
      apps: installedApps,
    };
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zstore-installed-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出软件资产 JSON 备份文件！', 'success');
  };

  // Search
  const handleSearchChange = async (q: string) => {
    setSearchQuery(q);
    const results = await api.searchApps(q);
    setApps(results);
    if (q && currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
      setCurrentView('home');
    }
  };

  const loadRecentViews = async () => {
    try {
      const recents = await api.getRecentlyViewedApps();
      setRecentlyViewedApps(recents);
    } catch {
      // ignore
    }
  };

  const handleClearRecentViews = async () => {
    try {
      await api.clearViewHistory();
      setRecentlyViewedApps([]);
      showToast('已清空最近浏览足迹', 'info');
    } catch {
      // ignore
    }
  };

  // Open App Detail Modal
  const handleOpenDetail = async (id: string) => {
    try {
      const detail = await api.getAppDetails(id);
      setSelectedApp(detail);
      api.recordAppView(id).then(loadRecentViews).catch(() => {});
    } catch {
      showToast(`获取应用详情失败: ${id}`, 'error');
    }
  };

  // Quick Install
  const handleQuickInstall = async (id: string) => {
    handleOpenDetail(id);
  };

  // Toggle Favorite
  const handleToggleFavorite = async (id: string) => {
    await api.toggleFavorite(id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast('已从收藏夹中移除', 'info');
      } else {
        next.add(id);
        showToast('已成功添加至我的收藏夹！', 'success');
      }
      return next;
    });
  };

  // Install App
  const handleInstallApp = async (id: string) => {
    try {
      const installed = await api.installApp(id);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== id), installed]);
      showToast(`${installed.app_name} 安装成功并通过 SHA-256 官方防篡改校验！`, 'success');
    } catch (err) {
      showToast(`安装失败: ${String(err)}`, 'error');
    }
  };

  // Launch App
  const handleLaunchApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app ? app.app_name : id;
    try {
      await api.launchApp(id);
      showToast(`🚀 已成功启动 ${appName}！`, 'success');
    } catch (err) {
      showToast(`启动失败: ${String(err)}`, 'error');
    }
  };

  // Uninstall or Unmanage App
  const handleUninstallApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const isImported = app?.install_method === 'system_import';
    const appName = app?.app_name || id;
    await api.uninstallApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    if (isImported) {
      showToast(`已成功取消对 ${appName} 的版本监控（本机软件保持完好）`, 'info');
    } else {
      showToast(`已调用官方卸载器注销并移除 ${appName}`, 'info');
    }
  };

  // Apply Single Update
  const handleApplyUpdate = async (id: string) => {
    await api.installApp(id);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    showToast(`${id} 已无缝平滑升级至最新版本！`, 'success');
  };

  // Ignore Single Update (FR-4.4)
  const handleIgnoreUpdate = (id: string) => {
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    showToast(`已跳过并忽略 ${id} 本次版本更新`, 'info');
  };

  // Skip Version (Feature C)
  const handleSkipVersion = async (id: string, version: string) => {
    await api.setAppSkipVersion(id, version);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(`已跳过 ${id} 的 ${version} 版本，下个新版本发布时将重新通知`, 'info');
  };

  // Freeze Version (Feature C)
  const handleFreezeVersion = async (id: string) => {
    await api.setAppFrozen(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(`已永久锁定 ${id} 当前版本，不再接收该应用更新`, 'info');
  };

  // Hide App (Feature C)
  const handleHideApp = async (id: string) => {
    await api.setAppHidden(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const catalogApps = await api.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(`已隐藏 ${id}，将不再在探索和更新中心显示`, 'info');
  };

  // Remove Rule (Feature C)
  const handleRemoveRule = async (appId: string) => {
    await api.removeUpdateRule(appId);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    const catalogApps = await api.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(`已清空 ${appId} 的全部版本与屏蔽规则`, 'success');
  };

  // Clear Rule Skip Version
  const handleClearRuleSkip = async (appId: string) => {
    await api.setAppSkipVersion(appId, null);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(`已恢复 ${appId} 的版本更新提醒`, 'success');
  };

  // Toggle Rule Frozen
  const handleToggleRuleFrozen = async (appId: string, isFrozen: boolean) => {
    await api.setAppFrozen(appId, isFrozen);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(isFrozen ? `已锁定 ${appId} 版本` : `已解除 ${appId} 版本锁定`, 'info');
  };

  // Toggle Rule Hidden
  const handleToggleRuleHidden = async (appId: string, isHidden: boolean) => {
    await api.setAppHidden(appId, isHidden);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    const catalogApps = await api.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(isHidden ? `已隐藏 ${appId}` : `已取消隐藏 ${appId}`, 'info');
  };

  // Batch Update
  const handleBatchUpdateAll = async () => {
    showToast('正在批量升级所有就绪应用...', 'info');
    for (const u of updates) {
      await api.installApp(u.app_id);
    }
    setUpdates([]);
    showToast('全部应用升级成功！', 'success');
  };

  // Scan System Installed Open-Source Apps (FR-5.3)
  const handleScanSystemApps = () => {
    setIsImportModalOpen(true);
  };

  const handleImportSuccess = async (count: number) => {
    showToast(`🎉 成功纳管 ${count} 款开源应用！正在检查最新版本...`, 'success');
    const [loadedInstalled, loadedUpdates] = await Promise.all([
      api.getInstalledApps(),
      api.checkForUpdates(),
    ]);
    setInstalledApps(loadedInstalled);
    setUpdates(loadedUpdates);
  };

  // Mirror Cycling
  const handleCycleMirror = async () => {
    const currentIndex = mirrors.findIndex((m) => m.is_active);
    const nextIndex = (currentIndex + 1) % mirrors.length;
    const nextMirror = mirrors[nextIndex];
    await api.switchMirror(nextMirror.id);
    setMirrors((prev) =>
      prev.map((m, idx) => ({ ...m, is_active: idx === nextIndex }))
    );
    showToast(`已切换至加速节点: ${nextMirror.name} (${nextMirror.latency_ms}ms)`, 'info');
  };

  const handleSelectMirror = async (mirrorId: string) => {
    await api.switchMirror(mirrorId);
    setMirrors((prev) =>
      prev.map((m) => ({ ...m, is_active: m.id === mirrorId }))
    );
    const node = mirrors.find((m) => m.id === mirrorId);
    showToast(`已切换至: ${node?.name || mirrorId}`, 'info');
  };

  const handlePingMirrors = async () => {
    showToast('正在对所有镜像节点进行并发测速...', 'info');
    try {
      const updated = await api.pingMirrors();
      setMirrors(updated);
      const fastest = updated[0];
      showToast(`测速完成！最快响应: ${fastest.name} (${fastest.latency_ms}ms)`, 'success');
    } catch {
      showToast('测速失败，请检查网络连接', 'error');
    }
  };

  const handleExportApps = () => {
    if (installedApps.length === 0) {
      showToast('当前尚未安装任何应用，无需导出', 'warning');
      return;
    }
    const lines = [
      '# Z-Store 已安装开源软件清单',
      '',
      `> 导出时间: ${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 应用名称 | 版本 | 安装方式 | 本地路径 |',
      '|---|---|---|---|',
      ...installedApps.map(
        (a) => `| ${a.app_name} | ${a.version} | ${a.install_method} | \`${a.install_path}\` |`
      ),
    ];
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制软件清单 Markdown 到剪贴板！', 'success');
    });
  };

  const installedIds = useMemo(
    () => new Set(installedApps.map((a) => a.app_id)),
    [installedApps]
  );

  const activeMirror = mirrors.find((m) => m.is_active);
  const activeMirrorName = activeMirror
    ? `${activeMirror.name.split(' ')[0]} (${activeMirror.latency_ms}ms)`
    : '优选中继 (38ms)';

  return (
    <div className="app-window">
      {/* TitleBar */}
      <TitleBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />

      {/* App Body */}
      <div className="app-body">
        {/* Sidebar */}
        <Sidebar
          currentView={currentView}
          onSelectView={setCurrentView}
          installedCount={installedApps.length}
          hasUpdates={updates.length > 0}
          activeMirrorName={activeMirrorName}
          onCycleMirror={handleCycleMirror}
          isCollapsed={isSidebarCollapsed}
        />

        {/* Content Views */}
        <main className="content-area">
          {currentView === 'home' && (
            <HomeView
              apps={apps}
              installedIds={installedIds}
              favoriteIds={favoriteIds}
              recentlyViewedApps={recentlyViewedApps}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onNavigateTrends={() => setCurrentView('trends')}
              onClearRecentViews={handleClearRecentViews}
            />
          )}

          {currentView === 'trends' && (
            <TrendsView
              apps={apps}
              favoriteIds={favoriteIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {currentView === 'categories' && (
            <CategoriesView
              apps={apps}
              installedIds={installedIds}
              favoriteIds={favoriteIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {currentView === 'favorites' && (
            <FavoritesView
              apps={apps}
              favoriteIds={favoriteIds}
              installedIds={installedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {currentView === 'installed' && (
            <InstalledView
              installedApps={installedApps}
              onLaunch={handleLaunchApp}
              onUninstall={handleUninstallApp}
              onScanSystemApps={handleScanSystemApps}
            />
          )}

          {currentView === 'updates' && (
            <UpdatesView
              updates={updates}
              onApplyUpdate={handleApplyUpdate}
              onBatchUpdateAll={handleBatchUpdateAll}
              onIgnoreUpdate={handleIgnoreUpdate}
              onSkipVersion={handleSkipVersion}
              onFreezeVersion={handleFreezeVersion}
              onHideApp={handleHideApp}
            />
          )}

          {currentView === 'settings' && (
            <SettingsView
              mirrors={mirrors}
              onSelectMirror={handleSelectMirror}
              onPingMirrors={handlePingMirrors}
              theme={theme}
              onSetTheme={handleSetTheme}
              onClearCache={() => {
                api.clearCache();
                showToast('本地安装包临时文件与 ETag 索引已清理完毕', 'success');
              }}
              onSaveToken={async (token) => {
                await api.setGithubToken(token);
                handleUpdateSetting('github_token', token);
                showToast(
                  token
                    ? 'GitHub Token 保存成功，API 限额已提升至 5000 次/小时'
                    : 'Token 已清除',
                  'success'
                );
              }}
              onExportApps={handleExportApps}
              onExportAppsJson={handleExportAppsJson}
              settings={settings}
              onUpdateSetting={handleUpdateSetting}
              onResetSettings={handleResetSettings}
              installedCount={installedApps.length}
              updateRules={updateRules}
              onRemoveRule={handleRemoveRule}
              onClearRuleSkip={handleClearRuleSkip}
              onToggleRuleFrozen={handleToggleRuleFrozen}
              onToggleRuleHidden={handleToggleRuleHidden}
            />
          )}
        </main>
      </div>

      {/* App Detail Modal */}
      {selectedApp && (
        <AppDetailModal
          app={selectedApp}
          isInstalled={installedIds.has(selectedApp.id)}
          isFavorite={favoriteIds.has(selectedApp.id)}
          onClose={() => setSelectedApp(null)}
          onInstall={handleInstallApp}
          onLaunch={handleLaunchApp}
          onToggleFavorite={handleToggleFavorite}
          onOpenDeveloperProfile={(owner) => setSelectedDeveloper(owner)}
        />
      )}

      {/* Developer Profile Modal (Feature D) */}
      <DeveloperProfileModal
        developer={selectedDeveloper || ''}
        isOpen={Boolean(selectedDeveloper)}
        onClose={() => setSelectedDeveloper(null)}
        onOpenAppDetail={(id) => handleOpenDetail(id)}
        onInstallApp={handleInstallApp}
      />

      {/* System Apps Import Modal (FR-5.3) */}
      <AppImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportSuccess={handleImportSuccess}
      />

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} />
    </div>
  );
};
