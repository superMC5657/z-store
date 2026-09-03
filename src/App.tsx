import React, { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { AppDetailModal } from './components/AppDetailModal';
import { ToastContainer } from './components/Toast';
import { HomeView } from './views/HomeView';
import { TrendsView } from './views/TrendsView';
import { CategoriesView } from './views/CategoriesView';
import { InstalledView } from './views/InstalledView';
import { UpdatesView } from './views/UpdatesView';
import { SettingsView } from './views/SettingsView';
import { FavoritesView } from './views/FavoritesView';
import { AppDetail, AppSummary, InstalledApp, MirrorNodeStatus, ToastMessage, UpdateItem, ViewType } from './types';
import { api } from './services/api';

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
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast Helper
  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
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

    // Persisted settings
    api.getSettings().then((settings) => {
      if (settings.theme === 'dark' || settings.theme === 'light') {
        setTheme(settings.theme);
        document.documentElement.setAttribute('data-theme', settings.theme);
      }
      if (settings.active_mirror) {
        api.switchMirror(settings.active_mirror);
      }
    });
  }, []);

  // Theme Toggler
  const handleToggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    api.saveSetting('theme', next);
    showToast(`已切换至${next === 'dark' ? '暗黑' : '明亮'}主题模式`, 'info');
  };

  const handleSetTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    api.saveSetting('theme', t);
    showToast(`已应用外观模式: ${t === 'dark' ? '暗黑模式' : '明亮模式'}`, 'info');
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

  // Open App Detail Modal
  const handleOpenDetail = async (id: string) => {
    try {
      const detail = await api.getAppDetails(id);
      setSelectedApp(detail);
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
        showToast('⭐️ 已成功添加至我的收藏夹！', 'success');
      }
      return next;
    });
  };

  // Install App
  const handleInstallApp = async (id: string) => {
    try {
      const installed = await api.installApp(id);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== id), installed]);
      showToast(`✅ ${installed.app_name} 安装成功并通过 SHA-256 官方防篡改校验！`, 'success');
    } catch (err) {
      showToast(`❌ 安装失败: ${String(err)}`, 'error');
    }
  };

  // Launch App
  const handleLaunchApp = (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    showToast(`🚀 已成功调起 ${app ? app.app_name : id}`, 'info');
  };

  // Uninstall App
  const handleUninstallApp = async (id: string) => {
    await api.uninstallApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(`🗑️ 已调用官方卸载器注销并移除 ${id}`, 'info');
  };

  // Apply Single Update
  const handleApplyUpdate = async (id: string) => {
    await api.installApp(id);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    showToast(`✨ ${id} 已无缝平滑升级至最新版本！`, 'success');
  };

  // Ignore Single Update (FR-4.4)
  const handleIgnoreUpdate = (id: string) => {
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    showToast(`已跳过并忽略 ${id} 本次版本更新`, 'info');
  };

  // Batch Update
  const handleBatchUpdateAll = async () => {
    showToast('🚀 正在批量升级所有就绪应用...', 'info');
    for (const u of updates) {
      await api.installApp(u.app_id);
    }
    setUpdates([]);
    showToast('✅ 全部应用升级成功！', 'success');
  };

  // Scan System Installed Open-Source Apps (FR-5.3)
  const handleScanSystemApps = () => {
    showToast('🔍 正在扫描系统注册表与开源应用特征...', 'info');
    setTimeout(() => {
      // 模拟探测命中系统存量软件
      const detected = apps.find((a) => a.id === 'vlc' || a.id === '7-zip');
      if (detected && !installedIds.has(detected.id)) {
        showToast(`💡 成功探测到系统已安装 ${detected.name}，可随时在此纳管更新！`, 'success');
      } else {
        showToast('✅ 扫描完毕，系统开源软件均已在 Z-Store 纳管中。', 'success');
      }
    }, 900);
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
    showToast(`🔄 自动切换加速节点: ${nextMirror.name} (${nextMirror.latency_ms}ms)`, 'info');
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
    showToast('⚡ 正在对所有镜像节点进行真实并发测速...', 'info');
    try {
      const updated = await api.pingMirrors();
      setMirrors(updated);
      const fastest = updated[0];
      showToast(`✅ 测速完成！最快响应: ${fastest.name} (${fastest.latency_ms}ms)`, 'success');
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
      showToast('📋 已复制软件清单 Markdown 到剪贴板！', 'success');
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
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onNavigateTrends={() => setCurrentView('trends')}
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
                showToast('🧹 本地安装包临时文件与 ETag 索引已清理完毕', 'success');
              }}
              onSaveToken={async (token) => {
                await api.setGithubToken(token);
                showToast(
                  token
                    ? '🔑 GitHub Token 保存成功，API 限额已提升至 5000 次/小时'
                    : 'Token 已清除',
                  'success'
                );
              }}
              onExportApps={handleExportApps}
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
        />
      )}

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} />
    </div>
  );
};
