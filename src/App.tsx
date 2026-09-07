import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { ToastContainer } from './components/Toast';
import { AppDetailModal } from './components/AppDetailModal';
import { DeveloperProfileModal } from './components/DeveloperProfileModal';
import { AppImportModal } from './components/AppImportModal';
import { RulesManagerModal } from './components/RulesManagerModal';
import { HomeView } from './views/HomeView';
import { TrendsView } from './views/TrendsView';
import { CategoriesView } from './views/CategoriesView';
import { InstalledView } from './views/InstalledView';
import { UpdatesView } from './views/UpdatesView';
import { SettingsView } from './views/SettingsView';
import { FavoritesView } from './views/FavoritesView';
import { AppDetail, AppSettings, AppSummary, InstalledApp, MirrorNodeStatus, OAuthUser, ToastMessage, UpdateItem, UpdateRule, ViewType, WatchUpdatedPayload } from './types';
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
  const [updateRules, setUpdateRules] = useState<UpdateRule[]>([]);
  const [recentlyViewedApps, setRecentlyViewedApps] = useState<AppSummary[]>([]);
  const [detectedAppIds, setDetectedAppIds] = useState<Set<string>>(new Set());
  // FR-6.2 关注（Watch）
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [watchNotifications, setWatchNotifications] = useState<WatchUpdatedPayload[]>([]);
  // FR-7 OAuth 登录态（详情弹窗标星门控）
  const [oauthUser, setOAuthUser] = useState<OAuthUser | null>(null);
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());

  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-2), { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  };
  const handleDismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

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

  // 将持久化设置快照合并入 AppSettings 并应用主题 / 字号 / 缩放（导入备份后复用同一路径）
  const applyPersistedSettings = (persisted: Record<string, string>) => {
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

    if (merged.active_mirror) {
      api.switchMirror(merged.active_mirror);
    }
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
    api.getDetectedInstalledAppIds().then((ids) => setDetectedAppIds(new Set(ids))).catch(() => {});
    api.getMirrorStatus().then(setMirrors);
    api.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    api.getUpdateRules().then(setUpdateRules);
    api.getRecentlyViewedApps().then(setRecentlyViewedApps).catch(() => {});
    api.registerDeepLinkScheme().catch(() => {});

    // Load persisted settings
    api.getSettings().then((persisted) => {
      applyPersistedSettings(persisted);
      if ((persisted.update_frequency || DEFAULT_SETTINGS.update_frequency) === 'startup') {
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

  // 应用内通知总线：新功能经 `zstore:toast` 事件投递 Toast
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string; type?: ToastMessage['type'] } | undefined;
      if (detail?.text) {
        showToast(detail.text, detail.type || 'info');
      }
    };
    window.addEventListener('zstore:toast', handler);
    return () => {
      window.removeEventListener('zstore:toast', handler);
    };
  }, []);

  // FR-6.2: 加载关注列表 + 订阅 `zstore://watch-updated` 应用内提醒
  useEffect(() => {
    let isMounted = true;
    let unlistenFn: (() => void) | null = null;
    api.getWatchedApps().then((ids) => {
      if (isMounted) setWatchedIds(new Set(ids));
    }).catch(() => {});
    api.onWatchUpdated((payload) => {
      if (!isMounted) return;
      const label = payload.app_name || payload.app_id;
      showToast(`你关注的 ${label} 发布了 ${payload.version}`, 'info');
      setWatchNotifications((prev) => {
        const next = prev.filter((n) => n.app_id !== payload.app_id);
        return [...next, payload];
      });
    }).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {});
    return () => {
      isMounted = false;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // FR-7 / FR-6.3-manual: OAuth 登录态 + 备份导入刷新
  useEffect(() => {
    let isMounted = true;
    const loadOAuthUser = () => {
      api.getOAuthUser().then((u) => {
        if (isMounted) setOAuthUser(u);
      }).catch(() => {
        if (isMounted) setOAuthUser(null);
      });
    };
    loadOAuthUser();
    const handleOAuthChanged = () => loadOAuthUser();
    const handleDataImported = async () => {
      try {
        const [persisted, favs, watched] = await Promise.all([
          api.getSettings(),
          api.getFavorites(),
          api.getWatchedApps().catch(() => [] as string[]),
        ]);
        if (!isMounted) return;
        applyPersistedSettings(persisted);
        setFavoriteIds(new Set(favs));
        setWatchedIds(new Set(watched));
      } catch {
        // 忽略：后端未就绪时保持现状
      }
    };
    window.addEventListener('zstore:oauth-changed', handleOAuthChanged);
    window.addEventListener('zstore:data-imported', handleDataImported);
    return () => {
      isMounted = false;
      window.removeEventListener('zstore:oauth-changed', handleOAuthChanged);
      window.removeEventListener('zstore:data-imported', handleDataImported);
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
    } else if (key === 'ui_scale') {
      applyUiZoom(String(value));
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
        setSelectedApp({ ...cached, isLoading: false, isRefreshing: false, loadError: undefined });
        api.recordAppView(id).then(loadRecentViews).catch(() => {});
        return;
      }
    } else {
      // 强制刷新：清理内存快照中的旧引用，确保直接穿透
      appDetailMemoryCache.current.delete(idClean);
      if (selectedApp && selectedApp.owner && selectedApp.repo) {
        const repoLower = `${selectedApp.owner}/${selectedApp.repo}`.toLowerCase();
        appDetailMemoryCache.current.delete(repoLower);
        appDetailMemoryCache.current.delete(`github.com/${repoLower}`);
      }
    }

    // 2. 内存未命中或主动刷新：若弹窗已打开则保持现有视图无感刷新，否则展示基础卡片信息
    const existing =
      apps.find((a) => a.id.toLowerCase() === idClean) ||
      recentlyViewedApps.find((a) => a.id.toLowerCase() === idClean);

    const initialDetail: AppDetail = selectedApp && selectedApp.id.toLowerCase() === idClean && forceRefresh
      ? { ...selectedApp, isLoading: false, isRefreshing: true, loadError: undefined }
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
          isRefreshing: forceRefresh,
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
          isRefreshing: forceRefresh,
        };

    // 0ms 同步打开弹窗或切换刷新态，主界面无任何阻塞感
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
          isRefreshing: false,
        });
      }

      // 同步主视图卡片列表中应用的信息（Stars、Forks、版本等）
      setApps((prev) =>
        prev.map((app) =>
          app.id.toLowerCase() === idClean ||
          (fullDetail.id && app.id.toLowerCase() === fullDetail.id.toLowerCase())
            ? {
                ...app,
                stars: fullDetail.stars,
                forks: fullDetail.forks,
                latest_version: fullDetail.latest_version,
              }
            : app
        )
      );
      setRecentlyViewedApps((prev) =>
        prev.map((app) =>
          app.id.toLowerCase() === idClean ||
          (fullDetail.id && app.id.toLowerCase() === fullDetail.id.toLowerCase())
            ? {
                ...app,
                stars: fullDetail.stars,
                forks: fullDetail.forks,
                latest_version: fullDetail.latest_version,
              }
            : app
        )
      );
    } catch (e) {
      if (activeDetailIdRef.current === id) {
        setSelectedApp((prev) =>
          prev
            ? { ...prev, isLoading: false, isRefreshing: false, loadError: String(e) }
            : null
        );
      }
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

  // Toggle Watch (FR-6.2: 关注 / 取消关注，后端未就绪时 Toast 提示且不崩溃)
  const handleToggleWatch = async (id: string) => {
    const isWatched = watchedIds.has(id);
    try {
      if (isWatched) {
        await api.unwatchApp(id);
      } else {
        await api.watchApp(id);
      }
    } catch (e) {
      showToast(`关注操作失败: ${String(e)}`, 'error');
      return;
    }
    setWatchedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast('已取消关注该应用的新版本动态', 'info');
      } else {
        next.add(id);
        showToast('已关注，新版本发布时将在应用内提醒你', 'success');
      }
      return next;
    });
    if (isWatched) {
      setWatchNotifications((prev) => prev.filter((n) => n.app_id !== id));
    }
  };

  const handleDismissWatchNotification = (appId: string) => {
    setWatchNotifications((prev) => prev.filter((n) => n.app_id !== appId));
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
  const handleInstallApp = async (id: string, assetName?: string, customInstallDir?: string): Promise<void> => {
    try {
      const installed = await api.installApp(id, assetName, customInstallDir);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id !== id), installed]);
      showToast(`${installed.app_name} 安装成功并通过 SHA-256 官方防篡改校验！`, 'success');
    } catch (err) {
      showToast(`安装失败: ${String(err)}`, 'error');
      throw err;
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

  // Unmanage App (remove from Z-Store list, keep local files intact)
  const handleUnmanageApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await api.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(`已成功取消对 ${appName} 的纳管（本机软件与数据保持完好）`, 'info');
  };

  // Manage App (import detected app into Z-Store management)
  const handleManageApp = async (id: string) => {
    try {
      await api.importSingleApp(id);
      const updatedList = await api.getInstalledApps();
      setInstalledApps(updatedList);
      setDetectedAppIds((prev) => new Set([...prev, id]));
      showToast(`已成功将应用纳入 Z-Store 统一管理`, 'success');
    } catch (err) {
      console.error('Failed to import app into management:', err);
    }
  };

  // Uninstall App (trigger official uninstaller / clean files and remove from list)
  const handleUninstallApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await api.uninstallApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    setDetectedAppIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    showToast(`已调用卸载程序并从列表中移除 ${appName}`, 'info');
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
    const updated = await api.getMirrorStatus();
    const active = updated.find((m) => m.is_active);
    const hasCustom = updated.some((m) => m.id === 'custom' && m.base_url);
    if (active?.id === 'direct' && hasCustom) {
      await handleSelectMirror('custom');
    } else {
      await handleSelectMirror('direct');
    }
  };

  const handleSelectMirror = async (mirrorId: string) => {
    await api.switchMirror(mirrorId);
    const updated = await api.getMirrorStatus();
    setMirrors(updated);
  };

  const handlePingMirrors = async () => {
    try {
      const active = mirrors.find((m) => m.is_active);
      const testUrl = active?.id === 'custom' ? active.base_url : undefined;
      const res = await api.testProxy(testUrl);
      if (res.success) {
        showToast(`测速成功: ${res.message}`, 'success');
      } else {
        showToast(`测速失败: ${res.message}`, 'error');
      }
    } catch {
      showToast('测速失败，请检查网络连接', 'error');
    }
  };

  const handleExportApps = () => {
    if (installedApps.length === 0) {
      return;
    }
    const lines = [
      '# Z-Store 已安装应用清单',
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
    navigator.clipboard.writeText(text);
  };

  const installedIds = useMemo(() => {
    const set = new Set(installedApps.map((a) => a.app_id));
    for (const id of detectedAppIds) {
      set.add(id);
    }
    return set;
  }, [installedApps, detectedAppIds]);

  const managedIds = useMemo(
    () => new Set(installedApps.map((a) => a.app_id)),
    [installedApps]
  );

  const activeMirror = mirrors.find((m) => m.is_active);
  const activeMirrorName = activeMirror
    ? activeMirror.id === 'direct'
      ? '官方直连'
      : activeMirror.name
    : '官方直连';

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
          hasUpdates={updates.length > 0 || watchNotifications.length > 0}
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
              watchedIds={watchedIds}
              recentlyViewedApps={recentlyViewedApps}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onNavigateTrends={() => setCurrentView('trends')}
              onClearRecentViews={handleClearRecentViews}
            />
          )}

          {currentView === 'trends' && (
            <TrendsView
              apps={apps}
              favoriteIds={favoriteIds}
              installedIds={installedIds}
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
              watchedIds={watchedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
            />
          )}

          {currentView === 'favorites' && (
            <FavoritesView
              apps={apps}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              installedIds={installedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
            />
          )}

          {currentView === 'installed' && (
            <InstalledView
              installedApps={installedApps}
              onLaunch={handleLaunchApp}
              onUninstall={handleUninstallApp}
              onUnmanage={handleUnmanageApp}
              onScanSystemApps={handleScanSystemApps}
              onExportApps={handleExportApps}
              onExportAppsJson={handleExportAppsJson}
              updateRules={updateRules}
              onToggleRuleFrozen={handleToggleRuleFrozen}
              onToggleRuleHidden={handleToggleRuleHidden}
              onOpenRules={() => setIsRulesModalOpen(true)}
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
              watchNotifications={watchNotifications}
              onOpenWatchedApp={handleOpenDetail}
              onDismissWatch={handleDismissWatchNotification}
            />
          )}

          {currentView === 'settings' && (
            <SettingsView
              mirrors={mirrors}
              onSelectMirror={handleSelectMirror}
              onPingMirrors={handlePingMirrors}
              theme={settings.theme}
              onSetTheme={handleSetTheme}
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
          isManaged={managedIds.has(selectedApp.id)}
          isFavorite={favoriteIds.has(selectedApp.id)}
          isWatched={watchedIds.has(selectedApp.id)}
          oauthUser={oauthUser}
          onClose={() => {
            activeDetailIdRef.current = null;
            setSelectedApp(null);
          }}
          onInstall={handleInstallApp}
          onLaunch={handleLaunchApp}
          onUninstall={handleUninstallApp}
          onUnmanage={handleUnmanageApp}
          onManageApp={handleManageApp}
          onToggleFavorite={handleToggleFavorite}
          onToggleWatch={handleToggleWatch}
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
        installedIds={installedIds}
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
        installedApps={installedApps}
        onRemoveRule={handleRemoveRule}
        onClearRuleSkip={handleClearRuleSkip}
        onToggleRuleFrozen={handleToggleRuleFrozen}
        onToggleRuleHidden={handleToggleRuleHidden}
        onSkipVersion={handleSkipVersion}
      />

      {/* 应用内通知 Toast（FR-6.2 / FR-4.4 / FR-7 / FR-6.3 共用通道） */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
};
