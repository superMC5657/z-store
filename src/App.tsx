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
import { AppDetail, AppDetailViewModel, AppSummary, InstalledApp, OAuthUser, UpdateItem, UpdateCheckProgressPayload, UpdateRule, ViewType, WatchUpdatedPayload } from './types';
import { api, DEFAULT_SETTINGS } from './services/api';
import { preloadIcons } from './components/AppIcon';
import { zlogInfo } from './lib/z-log';
import { PLATFORM_IDS, matchPlatformSet, normalizePlatform, togglePlatformSet, type PlatformId } from './lib/platformFilter';
import { useToasts } from './useToasts';
import { useAppSettings } from './useAppSettings';

export const PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v1';

/**
 * 将原始 localStorage 字符串解析为经过验证的平台选择集合。
 * 未知 ID 会被白名单过滤剔除。有效（可解析）的数组将按原样处理——
 * 包括空数组（这是合法的选择，代表空列表，各页面会据此渲染筛选为空的引导状态），
 * 以及仅含未知项的数组（根据同一规则过滤缩减为 []）。
 * 仅在键缺失或 JSON 损坏/非数组时，才会回退至全选集合（等效于“无过滤”）。
 *
 * 注意：此函数与 `src/lib/platformFilter.ts` 中的 `parseSelectedPlatformArray` 有所区别——
 * 后者接收已解码的字符串数组（readonly string[] | null | undefined）并将 null/undefined
 * 映射为空集合（绝不回退至全选）。而本字符串版本接收原始存储字符串，在缺失或损坏时有意回退至全选。
 */
export function parseSelectedPlatforms(raw: string | null | undefined): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  if (!raw) return full;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return full;
  }
  if (!Array.isArray(parsed)) return full;
  const known = new Set<PlatformId>();
  for (const id of parsed) {
    if (typeof id !== 'string') continue;
    const n = normalizePlatform(id);
    if ((PLATFORM_IDS as readonly string[]).includes(n)) known.add(n as PlatformId);
  }
  return known;
}

/**
 * 首次渲染时读取持久化的平台选择。保证绝不抛错：
 * 存储缺失、值损坏或存储抛错均产生全选集合；
 * 存储为有效的空数组则产生空集合。
 */
export function loadSelectedPlatforms(): Set<PlatformId> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return new Set<PlatformId>(PLATFORM_IDS);
    return parseSelectedPlatforms(window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY));
  } catch {
    return new Set<PlatformId>(PLATFORM_IDS);
  }
}

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [installingAppIds, setInstallingAppIds] = useState<Set<string>>(new Set());
  const [uninstallingAppIds, setUninstallingAppIds] = useState<Set<string>>(new Set());
  const [isRefreshingInstalled, setIsRefreshingInstalled] = useState(false);
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateCheckProgress, setUpdateCheckProgress] = useState<UpdateCheckProgressPayload | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<AppDetailViewModel | null>(null);
  const activeDetailIdRef = useRef<string | null>(null);
  const [selectedDeveloper, setSelectedDeveloper] = useState<string | null>(null);
  // P0-1 深链安装守卫：`install_app` 深链仅暂存待确认状态——安装必须经由用户显式点击确认方可启动。
  const [pendingDeepLinkInstall, setPendingDeepLinkInstall] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const {
    theme,
    settings,
    applyPersistedSettings,
    handleToggleTheme,
    handleSetTheme,
    handleToggleLanguage,
    handleUpdateSetting,
  } = useAppSettings();
  const [updateRules, setUpdateRules] = useState<UpdateRule[]>([]);
  const [recentlyViewedApps, setRecentlyViewedApps] = useState<AppSummary[]>([]);
  const [detectedAppIds, setDetectedAppIds] = useState<Set<string>>(new Set());
  // FR-6.2 关注（Watch）
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [watchNotifications, setWatchNotifications] = useState<WatchUpdatedPayload[]>([]);
  // 任务 3（设备平台全局过滤）：App 级别多选平台状态，默认选中全部 5 种 PLATFORM_IDS，
  // 仅持久化至 localStorage——刻意不接入 api.getSettings()/UserDataBackup（仅为本地界面偏好，非备份数据）。
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(() => loadSelectedPlatforms());
  // FR-7 OAuth 登录态（详情弹窗标星门控）
  const [oauthUser, setOAuthUser] = useState<OAuthUser | null>(null);
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());

  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const { toasts, showToast, handleDismissToast } = useToasts();

  // 初始加载
  useEffect(() => {
    // 初始数据拉取
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
    api.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    api.getUpdateRules().then(setUpdateRules);
    api.getRecentlyViewedApps().then((recents) => setRecentlyViewedApps(recents.filter((a) => matchPlatformSet(a, selectedPlatforms)))).catch(() => {});
    api.registerDeepLinkScheme().catch(() => {});

    // 加载持久化设置
    api.getSettings().then((persisted) => {
      applyPersistedSettings(persisted);
      // P2-6: 仅启动时自动检查更新——`daily`（每日）更新频率选项目前在“设置”中刻意禁用（未开发功能，暂无调度器），
      // 因此此处仅对 `startup`（启动时）触发自动检查；`daily`/`manual` 用户可通过“更新中心”标签页手动检查。
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

  // 任务 3：平台选择变更时将其回写至 localStorage。
  useEffect(() => {
    try {
      window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([...selectedPlatforms]));
    } catch {
      // 忽略：无痕模式/配额满/存储抛错时保持内存选择状态
    }
  }, [selectedPlatforms]);

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

  // 订阅更新项逐条跳出事件与流式进度通知（检测出一项立即跳出一项）
  useEffect(() => {
    let isMounted = true;
    let unlistenItem: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;

    api.onUpdateItemFound((item) => {
      if (!isMounted) return;
      setUpdates((prev) => {
        const idx = prev.findIndex((u) => u.app_id.toLowerCase() === item.app_id.toLowerCase());
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = item;
          return next;
        }
        return [...prev, item];
      });
    }).then((unlisten) => {
      if (isMounted) unlistenItem = unlisten;
      else unlisten();
    }).catch(() => {});

    api.onUpdateCheckProgress((payload) => {
      if (!isMounted) return;
      setUpdateCheckProgress(payload);
    }).then((unlisten) => {
      if (isMounted) unlistenProgress = unlisten;
      else unlisten();
    }).catch(() => {});

    api.onUpdateCheckFinished(() => {
      if (!isMounted) return;
      setIsCheckingUpdates(false);
      setUpdateCheckProgress(null);
    }).then((unlisten) => {
      if (isMounted) unlistenFinished = unlisten;
      else unlisten();
    }).catch(() => {});

    return () => {
      isMounted = false;
      if (unlistenItem) unlistenItem();
      if (unlistenProgress) unlistenProgress();
      if (unlistenFinished) unlistenFinished();
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
    let unlistenExpired: (() => void) | undefined;
    api.onOAuthExpired(() => {
      if (isMounted) {
        showToast('GitHub 登录授权已失效 (401)，请重新登录', 'warning');
        loadOAuthUser();
        window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
      }
    }).then((un) => {
      unlistenExpired = un;
    }).catch(() => {});

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
      if (unlistenExpired) unlistenExpired();
      window.removeEventListener('zstore:oauth-changed', handleOAuthChanged);
      window.removeEventListener('zstore:data-imported', handleDataImported);
    };
  }, []);

  // 仅在用户主动进入“更新中心”标签页时才执行轻量检查（30 秒防抖冷却，避免频繁切标签重复消耗配额）
  const lastTabUpdateCheckRef = useRef<number>(0);
  useEffect(() => {
    if (currentView === 'updates' && updates.length === 0) {
      const now = Date.now();
      if (now - lastTabUpdateCheckRef.current > 30_000) {
        lastTabUpdateCheckRef.current = now;
        api.checkForUpdates(false).then(setUpdates).catch(() => {});
      }
    }
  }, [currentView, updates.length]);

  const isFirstViewRender = useRef(true);
  const prevViewRef = useRef<ViewType>('home');
  useEffect(() => {
    if (isFirstViewRender.current) {
      isFirstViewRender.current = false;
      prevViewRef.current = currentView;
      return;
    }
    // Wave2：视图切换永带 from + params（杜绝裸 switch），sid 由 z-log 自动关联行为链。
    const from = prevViewRef.current;
    prevViewRef.current = currentView;
    zlogInfo(`switch view='${currentView}' from='${from}' params={}`);
  }, [currentView]);

  // 导出软件资产 JSON 备份
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
    showToast('已导出软件资产 JSON 备份文件', 'success');
  };

  // 搜索逻辑
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
      // 忽略错误
    }
  };

  const handleClearRecentViews = async () => {
    try {
      await api.clearViewHistory();
      setRecentlyViewedApps([]);
      showToast('已清空最近浏览足迹', 'info');
    } catch {
      // 忽略错误
    }
  };

  // 同步详情快照缓存与卡片列表数据（消除后台条件探查与主动刷新之间的重复逻辑）
  const syncDetailCacheAndAppLists = (idClean: string, detail: AppDetail, isBackgroundSilent = false) => {
    appDetailMemoryCache.current.set(idClean, detail);
    if (detail.id.toLowerCase() !== idClean) {
      appDetailMemoryCache.current.set(detail.id.toLowerCase(), detail);
    }
    if (detail.owner && detail.repo) {
      const repoLower = `${detail.owner}/${detail.repo}`.toLowerCase();
      appDetailMemoryCache.current.set(repoLower, detail);
      appDetailMemoryCache.current.set(`github.com/${repoLower}`, detail);
    }

    if (activeDetailIdRef.current === detail.id || activeDetailIdRef.current?.toLowerCase() === idClean) {
      setSelectedApp((prev) => {
        if (!prev) return { ...detail, isLoading: false, isRefreshing: false };
        if (
          !isBackgroundSilent ||
          prev.latest_version !== detail.latest_version ||
          prev.releases.length !== detail.releases.length ||
          prev.stars !== detail.stars
        ) {
          return { ...detail, isLoading: false, isRefreshing: false };
        }
        return prev;
      });
    }

    const patchSummary = (app: AppSummary): AppSummary =>
      app.id.toLowerCase() === idClean ||
      (detail.id && app.id.toLowerCase() === detail.id.toLowerCase())
        ? {
            ...app,
            stars: detail.stars,
            forks: detail.forks,
            latest_version: detail.latest_version,
          }
        : app;

    setApps((prev) => prev.map(patchSummary));
    setRecentlyViewedApps((prev) => prev.map(patchSummary));
  };

  // 打开应用详情弹窗（优先内存/数据库 0ms 瞬间秒开，且一个仓库生命周期内只拉取一次）
  const handleOpenDetail = async (id: string, forceRefresh = false) => {
    const idClean = id.trim().toLowerCase();
    activeDetailIdRef.current = id;

    // 1. 若非主动强制刷新，优先检查前端内存级快照缓存，实现绝对零延迟 0ms 打开，无任何骨架屏闪烁
    if (!forceRefresh) {
      const cached = appDetailMemoryCache.current.get(idClean);
      if (cached) {
        // 先以 0ms 瞬间展示内存快照，避免骨架屏闪烁
        setSelectedApp({ ...cached, isLoading: false, isRefreshing: false, loadError: undefined });
        api.recordAppView(id).then(loadRecentViews).catch(() => {});

        // 后台静默发起 ETag 条件探查：版本未变（304）后端毫秒级短路，版本变化则静默平滑更新
        api.getAppDetails(id, false).then((updatedDetail) => {
          syncDetailCacheAndAppLists(idClean, updatedDetail, true);
        }).catch(() => {
          // 静默忽略后台探查异常，保留已展示的快照
        });
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

    const initialDetail: AppDetailViewModel = selectedApp && selectedApp.id.toLowerCase() === idClean && forceRefresh
      ? { ...selectedApp, isLoading: false, isRefreshing: true, loadError: undefined }
      : existing
      ? {
          id: existing.id,
          name: existing.name,
          description_en: existing.description_en,
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
          homepage: existing.homepage,
          platforms: existing.platforms,
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
          forge: 'github',
          forge_host: 'github.com',
          homepage: null,
          platforms: ['windows'],
          isLoading: true,
          isRefreshing: forceRefresh,
        };

    // 0ms 同步打开弹窗或切换刷新态，主界面无任何阻塞感
    setSelectedApp(initialDetail);
    api.recordAppView(id).then(loadRecentViews).catch(() => {});

    try {
      const fullDetail = await api.getAppDetails(id, forceRefresh);
      syncDetailCacheAndAppLists(idClean, fullDetail, false);
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

  // 快捷安装
  const handleQuickInstall = async (id: string) => {
    handleInstallApp(id);
  };

  // 深链调度分发器（功能 E）
  const handleDispatchDeepLink = async (rawUrl: string) => {
    try {
      const action = await api.handleDeepLink(rawUrl);
      if (action.action === 'app_detail') {
        handleOpenDetail(action.payload.app_id);
      } else if (action.action === 'install_app') {
        // P0-1: 绝不直接自深链自动安装——打开详情视图并弹出显式确认弹窗；安装仅在用户点击确认后启动。
        handleOpenDetail(action.payload.app_id);
        setPendingDeepLinkInstall(action.payload.app_id);
        showToast(`外部链接请求安装 ${action.payload.app_id}，请在弹窗中确认后继续`, 'warning');
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

  // 切换收藏状态
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

  // 任务 3：设备平台切换。空选择是有效状态（代表空列表；页面渲染筛选为空的引导状态），
  // 因此对任何已知 ID 的切换均无条件提交。切换逻辑位于更新函数（函数式 updater）内部，
  // 保证始终基于最新提交的选择进行计算，同一 tick 内的双击顺序生效。
  // 未知 ID 会被静默忽略（侧栏仅发射已知 ID，无需 Toast 提示）。
  const handleTogglePlatform = (id: PlatformId) => {
    setSelectedPlatforms((prev) => togglePlatformSet(prev, id));
  };

  // 安装应用
  const handleInstallApp = async (id: string, assetName?: string, customInstallDir?: string): Promise<void> => {
    if (installingAppIds.has(id)) return;
    zlogInfo(`click install id=${id} asset=${assetName || 'auto'}`);
    setInstallingAppIds((prev) => new Set(prev).add(id));
    try {
      const installed = await api.installApp(id, assetName, customInstallDir);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()), installed]);
      setDetectedAppIds((prev) => new Set(prev).add(id).add(id.toLowerCase()));
      showToast(`${installed.app_name} 安装完成！`, 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('1602')) {
        showToast(`已取消安装: ${errStr}`, 'info');
      } else {
        showToast(`安装未完成: ${errStr}`, 'error');
      }
      throw err;
    } finally {
      setInstallingAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // 启动应用
  const handleLaunchApp = async (id: string) => {
    zlogInfo(`click launch id=${id}`);
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app ? app.app_name : id;
    try {
      await api.launchApp(id);
      showToast(`已成功启动 ${appName}！`, 'success');
    } catch (err) {
      showToast(`启动失败: ${String(err)}`, 'error');
    }
  };

  // 取消管理应用（从 Z-Store 列表中移除，保留本地文件完好）
  const handleUnmanageApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await api.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(`已成功取消对 ${appName} 的管理（本机软件与数据保持完好）`, 'info');
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
      showToast('已成功刷新已安装应用状态！', 'success');
    } catch (err) {
      showToast(`刷新失败: ${String(err)}`, 'error');
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
      showToast(`已成功将应用纳入 Z-Store 统一管理`, 'success');
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
      showToast(`已成功卸载 ${appName}！`, 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('保留') || errStr.includes('1602')) {
        showToast(`已取消卸载操作`, 'info');
      } else {
        showToast(`卸载未完成: ${errStr}`, 'error');
      }
    } finally {
      setUninstallingAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // 应用单项更新
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

  // 忽略单项更新（FR-4.4）
  const handleIgnoreUpdate = async (id: string) => {
    const target = updates.find((u) => u.app_id === id);
    await api.setAppSkipVersion(id, target?.latest_version ?? null);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(`已跳过并忽略 ${id} 本次版本更新`, 'info');
  };

  // 跳过指定版本（功能 C）
  const handleSkipVersion = async (id: string, version: string) => {
    await api.setAppSkipVersion(id, version);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(`已跳过 ${id} 的 ${version} 版本，下个新版本发布时将重新通知`, 'info');
  };

  // 锁定当前版本（功能 C）
  const handleFreezeVersion = async (id: string) => {
    await api.setAppFrozen(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(`已永久锁定 ${id} 当前版本，不再接收该应用更新`, 'info');
  };

  // 隐藏应用（功能 C）
  const handleHideApp = async (id: string) => {
    await api.setAppHidden(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const catalogApps = await api.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(`已隐藏 ${id}，将不再在探索和更新中心显示`, 'info');
  };

  // 移除规则（功能 C）
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

  // 清除跳过版本规则
  const handleClearRuleSkip = async (appId: string) => {
    await api.setAppSkipVersion(appId, null);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(`已恢复 ${appId} 的版本更新提醒`, 'success');
  };

  // 切换版本锁定状态
  const handleToggleRuleFrozen = async (appId: string, isFrozen: boolean) => {
    await api.setAppFrozen(appId, isFrozen);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(isFrozen ? `已锁定 ${appId} 版本` : `已解除 ${appId} 版本锁定`, 'info');
  };

  // 切换应用隐藏状态
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

  // 批量升级
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

  // 手动触发检查更新
  const handleCheckUpdates = async () => {
    showToast('正在向各开源托管仓库检查最新发布...', 'info');
    setIsCheckingUpdates(true);
    setUpdates([]); // 清空旧列表，使最新检测出来的项目逐个跳出
    setUpdateCheckProgress({ checked: 0, total: 0, app_id: '', app_name: '' });
    try {
      const freshUpdates = await api.checkForUpdates(true);
      setUpdates(freshUpdates);
      if (freshUpdates.length === 0) {
        showToast('太棒了！所有应用均已是最新版本', 'success');
      } else {
        showToast(`检查完成，共发现 ${freshUpdates.length} 个应用有新版本可用！`, 'info');
      }
    } catch (e) {
      showToast(`检查更新失败: ${String(e)}`, 'error');
    } finally {
      setIsCheckingUpdates(false);
      setUpdateCheckProgress(null);
    }
  };

  // 扫描系统已安装的开源应用（FR-5.3）
  const handleScanSystemApps = () => {
    setIsImportModalOpen(true);
  };

  const handleImportSuccess = async (count: number) => {
    showToast(`🎉 成功添加 ${count} 款开源应用到管理列表！`, 'success');
    try {
      const loadedInstalled = await api.getInstalledApps();
      setInstalledApps(loadedInstalled);
    } catch {
      /* Toast 提示后刷新静默失败 */
    }

    // 后台静默执行远端更新检查，绝不阻塞本地已安装列表呈现与界面交互
    api
      .checkForUpdates(false)
      .then((loadedUpdates) => {
        setUpdates(loadedUpdates);
      })
      .catch(() => undefined);
  };

  const handleSelectMirror = async (mirrorId: string) => {
    await api.switchMirror(mirrorId);
  };


  // 任务 3：以平台优先派生数据供给 精选/趋势/分类 视图（使用同名 apps 属性）。
  const platformFilteredApps = useMemo(
    () => apps.filter((a) => matchPlatformSet(a, selectedPlatforms)),
    [apps, selectedPlatforms]
  );

  // 任务 4（设备平台全局过滤）：侧栏分组的各平台应用计数，
  // 基于全量 `apps` 数组（而非已过滤数组）计算，以便准确呈现“有多少应用支持该设备”。
  const platformCounts = useMemo(() => {
    const counts = {} as Record<PlatformId, number>;
    for (const id of PLATFORM_IDS) {
      counts[id] = apps.filter((a) => matchPlatformSet(a, new Set([id]))).length;
    }
    return counts;
  }, [apps]);

  const installedIds = useMemo(() => {    const set = new Set<string>();
    for (const a of installedApps) {
      set.add(a.app_id);
      set.add(a.app_id.toLowerCase());
    }
    for (const id of detectedAppIds) {
      set.add(id);
      set.add(id.toLowerCase());
    }
    return set;
  }, [installedApps, detectedAppIds]);

  const managedIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of installedApps) {
      set.add(a.app_id);
      set.add(a.app_id.toLowerCase());
    }
    return set;
  }, [installedApps]);

  // P0-1 深链安装确认弹窗：呈现应用名称、仓库/来源以及 SHA-256（优先使用已加载详情，兜底使用列表快照）。
  const pendingDeepLinkDetail =
    pendingDeepLinkInstall !== null &&
    selectedApp !== null &&
    selectedApp.id.toLowerCase() === pendingDeepLinkInstall.toLowerCase() &&
    !selectedApp.isLoading
      ? selectedApp
      : null;
  const pendingDeepLinkSummary =
    pendingDeepLinkDetail ??
    (pendingDeepLinkInstall !== null
      ? apps.find((a) => a.id.toLowerCase() === pendingDeepLinkInstall.toLowerCase()) ??
        recentlyViewedApps.find((a) => a.id.toLowerCase() === pendingDeepLinkInstall.toLowerCase()) ??
        null
      : null);
  const pendingDeepLinkSha256 = pendingDeepLinkDetail?.releases.find((r) => r.sha256)?.sha256;

  // 跳转设置页 GitHub 账号区（侧栏登录胶囊入口）
  const handleOpenAccountSettings = () => {
    setCurrentView('settings');
    setTimeout(() => {
      document.getElementById('settings-account')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  };

  return (
    <div className="app-window">
      {/* 顶部标题栏 */}
      <TitleBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        language={settings.language}
        onToggleLanguage={handleToggleLanguage}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />

      {/* 应用主体区域 */}
      <div className="app-body">
        {/* 侧边导航栏 */}
        <Sidebar
          currentView={currentView}
          onSelectView={setCurrentView}
          installedCount={installedApps.length}
          hasUpdates={updates.length > 0 || watchNotifications.length > 0}
          onOpenAccount={handleOpenAccountSettings}
          isCollapsed={isSidebarCollapsed}
          selectedPlatforms={selectedPlatforms}
          onTogglePlatform={handleTogglePlatform}
          platformCounts={platformCounts}
        />

        {/* 主内容显示区域 */}
        <main className="content-area">
          {currentView === 'home' && (
            <HomeView
              apps={platformFilteredApps}
              installedIds={installedIds}
              installingIds={installingAppIds}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              recentlyViewedApps={recentlyViewedApps}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onNavigateTrends={() => setCurrentView('trends')}
              onClearRecentViews={handleClearRecentViews}
              onResetPlatformFilter={() => setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS))}
            />
          )}

          {currentView === 'trends' && (
            <TrendsView
              apps={platformFilteredApps}
              favoriteIds={favoriteIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onResetPlatformFilter={() => setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS))}
            />
          )}

          {currentView === 'categories' && (
            <CategoriesView
              apps={platformFilteredApps}
              installedIds={installedIds}
              installingIds={installingAppIds}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onResetPlatformFilter={() => setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS))}
            />
          )}

          {currentView === 'favorites' && (
            <FavoritesView
              apps={platformFilteredApps}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              oauthUser={oauthUser}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
            />
          )}

          {currentView === 'installed' && (
            <InstalledView
              installedApps={installedApps.filter((inst) => {
                const catalogEntry = apps.find(
                  (a) => a.id.toLowerCase() === inst.app_id.toLowerCase()
                );
                return !catalogEntry || matchPlatformSet(catalogEntry, selectedPlatforms);
              })}
              apps={platformFilteredApps}
              uninstallingAppIds={uninstallingAppIds}
              onOpenDetail={handleOpenDetail}
              onLaunch={handleLaunchApp}
              onUninstall={handleUninstallApp}
              onUnmanage={handleUnmanageApp}
              onScanSystemApps={handleScanSystemApps}
              onExportAppsJson={handleExportAppsJson}
              updateRules={updateRules}
              onToggleRuleFrozen={handleToggleRuleFrozen}
              onToggleRuleHidden={handleToggleRuleHidden}
              onOpenRules={() => setIsRulesModalOpen(true)}
              onRefresh={handleRefreshInstalledApps}
              isRefreshing={isRefreshingInstalled}
            />
          )}

          {currentView === 'updates' && (
            <UpdatesView
              updates={updates.filter((u) => {
                const catalogEntry = apps.find(
                  (a) => a.id.toLowerCase() === u.app_id.toLowerCase()
                );
                return !catalogEntry || matchPlatformSet(catalogEntry, selectedPlatforms);
              })}
              apps={platformFilteredApps}
              isChecking={isCheckingUpdates}
              checkProgress={updateCheckProgress}
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
              onSelectMirror={handleSelectMirror}
              theme={settings.theme}
              onSetTheme={handleSetTheme}
              onExportAppsJson={handleExportAppsJson}
              settings={settings}
              onUpdateSetting={handleUpdateSetting}
              installedCount={installedApps.length}
              updateRulesCount={updateRules.length}
              onOpenRules={() => setIsRulesModalOpen(true)}
            />
          )}
        </main>
      </div>

      {/* P0-1 深度链接安装确认弹窗（显式用户授权门禁） */}
      {pendingDeepLinkInstall !== null && (
        <div className="modal-backdrop" onClick={() => setPendingDeepLinkInstall(null)}>
          <div
            className="detail-modal"
            style={{ maxWidth: '480px', width: '92%', padding: '24px 28px' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="确认安装"
          >
            <div className="modal-header" style={{ position: 'relative', padding: 0, marginBottom: '12px' }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>确认安装</h2>
            </div>
            <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
              外部链接请求安装以下应用，请确认后再继续：
            </p>
            <div style={{ margin: '0 0 8px', lineHeight: 1.8 }}>
              <div>
                应用：{pendingDeepLinkDetail?.name ?? pendingDeepLinkSummary?.name ?? pendingDeepLinkInstall}
              </div>
              <div>
                仓库：{pendingDeepLinkDetail
                  ? `${pendingDeepLinkDetail.owner}/${pendingDeepLinkDetail.repo}`
                  : pendingDeepLinkSummary
                    ? `${pendingDeepLinkSummary.owner}/${pendingDeepLinkSummary.repo}`
                    : pendingDeepLinkInstall}
              </div>
              <div>
                来源：{pendingDeepLinkDetail?.forge_host ?? pendingDeepLinkSummary?.forge_host ?? '未知来源'}
              </div>
              {pendingDeepLinkSha256 && (
                <div style={{ wordBreak: 'break-all' }}>
                  SHA-256：{pendingDeepLinkSha256}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button
                className="btn-fluent btn-secondary"
                onClick={() => {
                  setPendingDeepLinkInstall(null);
                  showToast('已取消外部链接发起的安装请求', 'info');
                }}
              >
                取消
              </button>
              <button
                className="btn-fluent btn-primary"
                onClick={() => {
                  const id = pendingDeepLinkInstall;
                  setPendingDeepLinkInstall(null);
                  if (id !== null) {
                    handleInstallApp(id);
                  }
                }}
              >
                确认安装
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 应用详情弹窗 */}
      {selectedApp && (
        <AppDetailModal
          app={selectedApp}
          isInstalled={installedIds.has(selectedApp.id)}
          isManaged={managedIds.has(selectedApp.id)}
          isExploreMode={currentView === 'home' || currentView === 'trends' || currentView === 'categories'}
          isFavorite={favoriteIds.has(selectedApp.id)}
          isWatched={watchedIds.has(selectedApp.id)}
          isInstallingGlobal={installingAppIds.has(selectedApp.id)}
          isUninstallingGlobal={uninstallingAppIds.has(selectedApp.id)}
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
          onOpenAccountSettings={handleOpenAccountSettings}
          onRetry={(retryId) => handleOpenDetail(retryId)}
          onRefresh={(refreshId) => handleOpenDetail(refreshId, true)}
        />
      )}

      {/* 开发者主页弹窗（功能 D） */}
      <DeveloperProfileModal
        developer={selectedDeveloper || ''}
        isOpen={Boolean(selectedDeveloper)}
        onClose={() => setSelectedDeveloper(null)}
        onOpenAppDetail={(id) => handleOpenDetail(id)}
        onInstallApp={handleInstallApp}
        installedIds={installedIds}
      />

      {/* 系统已安装应用导入弹窗（FR-5.3） */}
      <AppImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportSuccess={handleImportSuccess}
      />

      {/* 更新规则管理弹窗 */}
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
