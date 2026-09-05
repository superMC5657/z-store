import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { AppDetailModal } from './components/AppDetailModal';
import { DeveloperProfileModal } from './components/DeveloperProfileModal';
import { AppImportModal } from './components/AppImportModal';
import { RulesManagerModal } from './components/RulesManagerModal';
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
import { preloadIcons } from './components/AppIcon';

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
  const activeDetailIdRef = useRef<string | null>(null);
  const [selectedDeveloper, setSelectedDeveloper] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [updateRules, setUpdateRules] = useState<UpdateRule[]>([]);
  const [recentlyViewedApps, setRecentlyViewedApps] = useState<AppSummary[]>([]);
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());

  // Toast Helper - 严格保证右下角通知最多只有一个（新通知直接顶替并重置 3.5s 计时）
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    // 最多只有一个通知
    setToasts([{ id, text, type }]);

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToasts([]);
      toastTimerRef.current = null;
    }, 3500);
  };

  const dismissToast = (id?: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (id) {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    } else {
      setToasts([]);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const FONT_SCALE_MAP: Record<string, string> = {
    '12': '0.86',
    '14': '1',
    '16': '1.14',
    '18': '1.28',
    '20': '1.43',
    small: '0.86',
    standard: '1',
    medium: '1.14',
    large: '1.28',
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
    api.searchApps('').then((loadedApps) => {
      setApps(loadedApps);
      // 预解码热门应用图标，若本地配置目录已缓存则秒读，未缓存则后台下载并缓存
      preloadIcons(
        loadedApps
          .slice(0, 30)
          .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon }))
      );
    });
    api.getInstalledApps().then(setInstalledApps);
    api.getMirrorStatus().then(setMirrors);
    api.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    api.getUpdateRules().then(setUpdateRules);
    api.getRecentlyViewedApps().then(setRecentlyViewedApps).catch(() => {});
    api.registerDeepLinkScheme().catch(() => {});

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
      let currentTheme: 'light' | 'dark' = 'dark';
      if (merged.theme === 'light') {
        currentTheme = 'light';
      } else if (merged.theme === 'dark') {
        currentTheme = 'dark';
      } else {
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = isDark ? 'dark' : 'light';
      }
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

      if (merged.update_frequency === 'startup') {
        api.checkForUpdates(false).then(setUpdates).catch(() => {});
      }
    });

    const handleCatalogSynced = () => {
      api.searchApps('').then((updatedApps) => {
        setApps(updatedApps);
        preloadIcons(
          updatedApps
            .slice(0, 30)
            .filter((a) => a.icon)
            .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon }))
        );
      });
    };
    window.addEventListener('zstore:catalog-synced', handleCatalogSynced);

    return () => {
      window.removeEventListener('zstore:catalog-synced', handleCatalogSynced);
    };
  }, []);

  // 跟随系统主题动态监听
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (settings.theme === 'system') {
        const nextTheme = e.matches ? 'dark' : 'light';
        setTheme(nextTheme);
        document.documentElement.setAttribute('data-theme', nextTheme);
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [settings.theme]);

  // 仅在用户主动进入“更新中心”标签页时才执行轻量检查，彻底避免在后台静默消耗用户配额
  useEffect(() => {
    if (currentView === 'updates' && updates.length === 0) {
      api.checkForUpdates(false).then(setUpdates).catch(() => {});
    }
  }, [currentView]);

  // Theme Toggler
  const handleToggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    handleUpdateSetting('theme', next);
    showToast(`已切换至${next === 'dark' ? '暗黑' : '明亮'}主题模式`, 'info');
  };

  const handleSetTheme = (t: 'light' | 'dark' | 'system') => {
    let effective: 'light' | 'dark' = 'dark';
    if (t === 'light') {
      effective = 'light';
    } else if (t === 'dark') {
      effective = 'dark';
    } else {
      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      effective = isDark ? 'dark' : 'light';
    }
    setTheme(effective);
    document.documentElement.setAttribute('data-theme', effective);
    handleUpdateSetting('theme', t);
    const label = t === 'system' ? '跟随系统' : t === 'dark' ? '暗黑模式' : '明亮模式';
    showToast(`已应用外观模式: ${label}`, 'info');
  };

  // Generic Setting Updater
  const handleUpdateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    await api.saveSetting(key, String(value));

    if (key === 'theme') {
      const t = value as 'light' | 'dark' | 'system';
      let effective: 'light' | 'dark' = 'dark';
      if (t === 'light') {
        effective = 'light';
      } else if (t === 'dark') {
        effective = 'dark';
      } else {
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        effective = isDark ? 'dark' : 'light';
      }
      setTheme(effective);
      document.documentElement.setAttribute('data-theme', effective);
    } else if (key === 'font_size') {
      applyFontSize(String(value));
      const labels: Record<string, string> = {
        '12': '紧凑 12px',
        '14': '标准 14px',
        '16': '舒适 16px',
        '18': '较大 18px',
        '20': '特大 20px',
        small: '紧凑 12px',
        standard: '标准 14px',
        medium: '舒适 16px',
        large: '较大 18px',
      };
      showToast(`全局字体已设为: ${labels[String(value)] || `${value}px`}`, 'info');
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
    applyFontSize('14');
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

  // Open App Detail Modal (优先内存/数据库 0ms 瞬间秒开，且一个仓库生命周期内只拉取一次)
  const handleOpenDetail = async (id: string, forceRefresh = false) => {
    const idClean = id.trim().toLowerCase();
    activeDetailIdRef.current = id;

    // 1. 若非主动强制刷新，优先检查前端内存级快照缓存，实现绝对零延迟 0ms 打开，无任何骨架屏闪烁
    if (!forceRefresh) {
      const cached = appDetailMemoryCache.current.get(idClean);
      if (cached) {
        setSelectedApp({ ...cached, isLoading: false, loadError: undefined });
        api.recordAppView(id).then(loadRecentViews).catch(() => {});
        return;
      }
    }

    // 2. 内存未命中或主动刷新：先展示现有基础卡片信息
    const existing =
      apps.find((a) => a.id.toLowerCase() === idClean) ||
      recentlyViewedApps.find((a) => a.id.toLowerCase() === idClean);

    const initialDetail: AppDetail = selectedApp && selectedApp.id.toLowerCase() === idClean && forceRefresh
      ? { ...selectedApp, isLoading: true }
      : existing
      ? {
          id: existing.id,
          name: existing.name,
          owner: existing.owner,
          repo: existing.repo,
          icon: existing.icon,
          icon_bg: existing.icon_bg,
          description: existing.description,
          stars: existing.stars,
          forks: existing.forks,
          license: existing.license,
          latest_version: existing.latest_version,
          changelog: '',
          is_verified: existing.is_verified,
          readme_markdown: '',
          releases: [],
          category: existing.category,
          category_name: existing.category_name,
          forge: existing.forge,
          forge_host: existing.forge_host,
          isLoading: true,
        }
      : {
          id,
          name: id,
          owner: '加载中...',
          repo: id,
          icon: '📦',
          icon_bg: 'linear-gradient(135deg, #475569, #334155)',
          description: '正在获取应用元数据...',
          stars: 0,
          forks: 0,
          license: '...',
          latest_version: '...',
          changelog: '',
          is_verified: false,
          readme_markdown: '',
          releases: [],
          category: 'system',
          category_name: '应用',
          isLoading: true,
        };

    // 0ms 同步打开弹窗，主界面无任何阻塞感
    setSelectedApp(initialDetail);
    api.recordAppView(id).then(loadRecentViews).catch(() => {});

    try {
      const fullDetail = await api.getAppDetails(id, forceRefresh);
      // 写入前端内存缓存，支持 id 及 owner/repo 索引
      appDetailMemoryCache.current.set(idClean, fullDetail);
      if (fullDetail.id.toLowerCase() !== idClean) {
        appDetailMemoryCache.current.set(fullDetail.id.toLowerCase(), fullDetail);
      }
      if (fullDetail.owner && fullDetail.repo) {
        const repoLower = `${fullDetail.owner}/${fullDetail.repo}`.toLowerCase();
        appDetailMemoryCache.current.set(repoLower, fullDetail);
        appDetailMemoryCache.current.set(`github.com/${repoLower}`, fullDetail);
      }

      // 竞态校验：仅当当前关注的应用与返回的应用一致时更新
      if (activeDetailIdRef.current === id) {
        setSelectedApp({
          ...fullDetail,
          isLoading: false,
        });
        if (forceRefresh) {
          showToast(`${fullDetail.name} 元数据与最新 Release 信息已刷新！`, 'success');
        }
      }
    } catch (e) {
      if (activeDetailIdRef.current === id) {
        setSelectedApp((prev) =>
          prev && prev.id === id
            ? { ...prev, isLoading: false, loadError: String(e) }
            : null
        );
      }
      showToast(`获取应用详情失败: ${id}`, 'error');
    }
  };

  // Quick Install
  const handleQuickInstall = async (id: string) => {
    handleInstallApp(id);
  };

  // Deep Link Dispatcher (Feature E)
  const handleDispatchDeepLink = async (rawUrl: string) => {
    try {
      const action = await api.handleDeepLink(rawUrl);
      if (action.action === 'app_detail') {
        handleOpenDetail(action.payload.app_id);
      } else if (action.action === 'install_app') {
        handleOpenDetail(action.payload.app_id);
        handleInstallApp(action.payload.app_id);
      } else if (action.action === 'search') {
        handleSearchChange(action.payload.query);
      } else if (action.action === 'developer_profile') {
        setSelectedDeveloper(action.payload.owner);
      } else if (action.action === 'open_view') {
        const validViews: ViewType[] = ['home', 'trends', 'categories', 'installed', 'updates', 'favorites', 'settings'];
        if (validViews.includes(action.payload.view as ViewType)) {
          setCurrentView(action.payload.view as ViewType);
        }
      }
      showToast(`已响应协议链接: ${rawUrl}`, 'info');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  useEffect(() => {
    (window as any).dispatchZStoreDeepLink = handleDispatchDeepLink;

    // 检查 CLI 参数是否带有唤起协议 (如外部双击链接拉起新进程)
    api.getCliDeepLink().then((cliLink) => {
      if (cliLink) {
        handleDispatchDeepLink(cliLink);
      }
    }).catch(() => {});

    return () => {
      delete (window as any).dispatchZStoreDeepLink;
    };
  }, []);

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
    try {
      const updatedApp = await api.installApp(id);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== id), updatedApp]);
      setUpdates((prev) => prev.filter((u) => u.app_id !== id));
      showToast(`${updatedApp.app_name || id} 已无缝平滑升级至最新版本！`, 'success');
    } catch (err) {
      showToast(`升级失败: ${String(err)}`, 'error');
    }
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
    let successCount = 0;
    let failCount = 0;
    const remainingUpdates: UpdateItem[] = [];

    for (const u of updates) {
      try {
        const updatedApp = await api.installApp(u.app_id);
        setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== u.app_id), updatedApp]);
        successCount++;
      } catch {
        failCount++;
        remainingUpdates.push(u);
      }
    }

    setUpdates(remainingUpdates);
    if (failCount === 0) {
      showToast(`全部 ${successCount} 款应用已成功升级至最新版本！`, 'success');
    } else {
      showToast(`批量升级完成：${successCount} 款成功，${failCount} 款失败`, 'warning');
    }
  };

  // Trigger Manual Update Check
  const handleCheckUpdates = async () => {
    showToast('正在向各开源托管仓库检查最新发布...', 'info');
    try {
      const freshUpdates = await api.checkForUpdates(true);
      setUpdates(freshUpdates);
      if (freshUpdates.length === 0) {
        showToast('太棒了！所有应用均已是最新版本', 'success');
      } else {
        showToast(`发现 ${freshUpdates.length} 个应用有新版本可用！`, 'info');
      }
    } catch (e) {
      showToast(`检查更新失败: ${String(e)}`, 'error');
    }
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
      {/* Dynamic Ambient Aurora Background Blobs for Glass Refraction */}
      <div className="aurora-ambient-glow" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      {/* Authentic Acrylic Frosted Noise Texture Layer (亚克力微晶磨砂层) */}
      <div className="acrylic-noise-overlay" aria-hidden="true" />

      {/* TitleBar */}
      <TitleBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        onNavigateSettings={() => setCurrentView('settings')}
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
              onExportApps={handleExportApps}
              onExportAppsJson={handleExportAppsJson}
            />
          )}

          {currentView === 'updates' && (
            <UpdatesView
              updates={updates}
              onApplyUpdate={handleApplyUpdate}
              onBatchUpdateAll={handleBatchUpdateAll}
              onCheckUpdates={handleCheckUpdates}
              onIgnoreUpdate={handleIgnoreUpdate}
              onSkipVersion={handleSkipVersion}
              onFreezeVersion={handleFreezeVersion}
              onHideApp={handleHideApp}
              updateRulesCount={updateRules.length}
              onOpenRules={() => setIsRulesModalOpen(true)}
            />
          )}

          {currentView === 'settings' && (
            <SettingsView
              mirrors={mirrors}
              onSelectMirror={handleSelectMirror}
              onPingMirrors={handlePingMirrors}
              theme={settings.theme}
              onSetTheme={handleSetTheme}
              onClearCache={() => {
                appDetailMemoryCache.current.clear();
                api.clearCache();
                showToast('本地安装包临时文件、应用详情缓存与 ETag 索引已清理完毕', 'success');
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
              updateRulesCount={updateRules.length}
              onOpenRules={() => setIsRulesModalOpen(true)}
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
          onClose={() => {
            activeDetailIdRef.current = null;
            setSelectedApp(null);
          }}
          onInstall={handleInstallApp}
          onLaunch={handleLaunchApp}
          onToggleFavorite={handleToggleFavorite}
          onOpenDeveloperProfile={(owner) => setSelectedDeveloper(owner)}
          onRetry={(retryId) => handleOpenDetail(retryId)}
          onRefresh={(refreshId) => handleOpenDetail(refreshId, true)}
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

      {/* Update Rules Manager Modal */}
      <RulesManagerModal
        isOpen={isRulesModalOpen}
        onClose={() => setIsRulesModalOpen(false)}
        updateRules={updateRules}
        onRemoveRule={handleRemoveRule}
        onClearRuleSkip={handleClearRuleSkip}
        onToggleRuleFrozen={handleToggleRuleFrozen}
        onToggleRuleHidden={handleToggleRuleHidden}
      />

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
