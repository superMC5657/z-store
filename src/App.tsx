import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
// ResizeHandles is only loaded in Tauri desktop environment; in test/web environments
// it is skipped to avoid evaluating Tauri internals or failing on mock contracts.
const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const ResizeHandles = isTauriEnv
  ? React.lazy(() => import('./components/ResizeHandles').then((m) => ({ default: m.ResizeHandles })))
  : () => null;
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
import { EmptyState } from './components/EmptyState';
import { Search } from 'lucide-react';
import { AppDetail, AppDetailViewModel, AppSummary, OAuthUser, UpdateItem, UpdateCheckProgressPayload, UpdateRule, ViewType, WatchUpdatedPayload } from './types';
import { api, DEFAULT_SETTINGS } from './services/api';
import { preloadIcons, invalidateIconCache, isAvatarUrl } from './components/AppIcon';
import { zlogInfo } from './lib/z-log';
import { PLATFORM_IDS, isPlatformPending, matchPlatformSetWithPending, normalizePlatform, togglePlatformSet, type PlatformId } from './lib/platformFilter';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  DETAIL_RICHCARD_HEAL_EVENT,
  appSummaryFromDetail,
  detailHealKeysFor,
  evictTrendEnrichCachesForDetail,
  isPlaceholderDescription,
  snapshotTrendEnrichCache,
  upsertTrendEnrichFromDetail,
  upsertTrendEnrichRichcard,
  type DetailPlatformsHealPayload,
  type DetailRichcardHealPayload,
} from './services/trends';
import { useToasts } from './useToasts';
import { useAppSettings } from './useAppSettings';
import { useTranslation } from 'react-i18next';
import './i18n';

import {
  PLATFORM_FILTER_STORAGE_KEY,
  parseSelectedPlatforms,
  loadSelectedPlatforms,
} from './app/platformStorage';
import { InstallConfirmDialog } from './app/InstallConfirmDialog';
import { usePlatformBackfill } from './app/hooks/usePlatformBackfill';
import { useSearchState } from './app/hooks/useSearchState';
import { useInstallState } from './app/hooks/useInstallState';
import { useDeepLink } from './app/hooks/useDeepLink';

export {
  PLATFORM_FILTER_STORAGE_KEY,
  parseSelectedPlatforms,
  loadSelectedPlatforms,
};

/**
 * 单图标升级时仅替换对应 id 的对象，其余复用原引用；
 * 若目标不存在或图标已一致则直接返回原数组引用，避免全网格重渲染闪烁。
 */
export function patchAppIconList(prev: AppSummary[], targetIdLower: string, icon: string): AppSummary[] {
  let changed = false;
  const next = prev.map((a) => {
    if (a.id.toLowerCase() === targetIdLower) {
      if (a.icon === icon) return a;
      changed = true;
      return { ...a, icon };
    }
    return a;
  });
  return changed ? next : prev;
}

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateCheckProgress, setUpdateCheckProgress] = useState<UpdateCheckProgressPayload | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<AppDetailViewModel | null>(null);
  const activeDetailIdRef = useRef<string | null>(null);
  const [selectedDeveloper, setSelectedDeveloper] = useState<string | null>(null);
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
  // FR-6.2 关注（Watch）
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [watchNotifications, setWatchNotifications] = useState<WatchUpdatedPayload[]>([]);
  // 任务 3（设备平台全局过滤）：App 级别多选平台状态，默认选中全部 6 种 PLATFORM_IDS（含虚拟 other），
  // 仅持久化至 localStorage——刻意不接入 api.getSettings()/UserDataBackup（仅为本地界面偏好，非备份数据）。
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(() => loadSelectedPlatforms());
  // FR-7 OAuth 登录态（详情弹窗标星门控）
  const [oauthUser, setOAuthUser] = useState<OAuthUser | null>(null);
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());
  // 卡片 memo 稳定回调支撑：经 ref 读取最新列表/详情，避免 handleOpenDetail 依赖 apps 而每搜必变
  const appsRef = useRef<AppSummary[]>([]);
  appsRef.current = apps;
  const recentsRef = useRef<AppSummary[]>([]);
  recentsRef.current = recentlyViewedApps;
  const selectedAppRef = useRef<AppDetailViewModel | null>(null);
  selectedAppRef.current = selectedApp;
  const watchedRef = useRef<Set<string>>(watchedIds);
  watchedRef.current = watchedIds;

  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const { toasts, showToast, handleDismissToast } = useToasts();
  const { t } = useTranslation();

  // 1. 安装管理 Hook
  const {
    installedApps,
    setInstalledApps,
    installingAppIds,
    uninstallingAppIds,
    isRefreshingInstalled,
    detectedAppIds,
    setDetectedAppIds,
    handleInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleRefreshInstalledApps,
    handleManageApp,
    handleUninstallApp,
  } = useInstallState({
    currentView,
    apps,
    showToast,
    t,
  });

  // 2. 平台回填与搜索解耦
  const lazyBackfillRef = useRef<(summaries: AppSummary[], seq: number) => void>(() => {});

  const {
    searchQuery,
    searchSeqRef,
    currentSearchIdRef,
    isSearchingOnline,
    onlineSearchPerformed,
    isOnlineResultSet,
    onlineApps,
    setOnlineApps,
    onlineHasMore,
    isLoadingOnlineMore,
    onlineAppsRef,
    handleSearchChange,
    handleSearchSubmit,
    handleOnlineLoadMore,
  } = useSearchState({
    currentView,
    setCurrentView,
    setApps,
    lazyBackfillPlatforms: (summaries, seq) => lazyBackfillRef.current(summaries, seq),
    showToast,
    t,
  });

  const {
    platformResolvedOtherIds,
    setPlatformResolvedOtherIds,
    lazyBackfillPlatforms,
  } = usePlatformBackfill({
    apps,
    onlineApps,
    recentlyViewedApps,
    appsRef,
    onlineAppsRef,
    recentsRef,
    searchSeqRef,
    setApps,
    setOnlineApps,
    setRecentlyViewedApps,
  });
  lazyBackfillRef.current = lazyBackfillPlatforms;

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
    api.getRecentlyViewedApps().then((recents) => setRecentlyViewedApps(recents.filter((a) => matchPlatformSetWithPending(a, selectedPlatforms, platformResolvedOtherIds)))).catch(() => {});
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

    const handleIconChanged = (e: Event) => {
      const customEvent = e as CustomEvent<{ appId: string; icon: string }>;
      const { appId, icon } = customEvent.detail || {};
      if (!appId) return;
      if (icon && isAvatarUrl(icon)) return;
      const targetId = appId.toLowerCase();
      setApps((prevApps) => patchAppIconList(prevApps, targetId, icon));
      setOnlineApps((prev) => patchAppIconList(prev, targetId, icon));
      setRecentlyViewedApps((prevRecents) => patchAppIconList(prevRecents, targetId, icon));
    };
    window.addEventListener('zstore:icon-changed', handleIconChanged);

    let unlistenSearchIcons: (() => void) | null = null;
    api
      .onSearchIconUpgraded((payload) => {
        if (!payload || !payload.app_id || !payload.icon || isAvatarUrl(payload.icon)) return;
        if (payload.search_id && currentSearchIdRef.current && payload.search_id !== currentSearchIdRef.current) {
          return;
        }

        const targetId = payload.app_id.toLowerCase();
        invalidateIconCache(targetId);
        preloadIcons([{ id: targetId, icon: payload.icon }]);

        setApps((prevApps) => patchAppIconList(prevApps, targetId, payload.icon));
        setOnlineApps((prev) => patchAppIconList(prev, targetId, payload.icon));
        setRecentlyViewedApps((prevRecents) => patchAppIconList(prevRecents, targetId, payload.icon));
      })
      .then((unlisten) => {
        unlistenSearchIcons = unlisten;
      });

    return () => {
      window.removeEventListener('zstore:catalog-synced', handleCatalogSynced);
      window.removeEventListener('zstore:icon-changed', handleIconChanged);
      if (unlistenSearchIcons) unlistenSearchIcons();
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
      showToast(t('toast.watch_update_released', { name: label, version: payload.version }), 'info');
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
        showToast(t('toast.github_auth_expired'), 'warning');
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
      showToast(t('toast.no_installed_to_export'), 'warning');
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
    showToast(t('toast.export_success'), 'success');
  };

  const loadRecentViews = useCallback(async () => {
    try {
      const recents = await api.getRecentlyViewedApps();
      // 趋势富卡治愈：后端 history 对未收录行原样拷贝占位简介，此处用富卡非占位值一次治愈
      // （首刷新增行 + 旧占位行；后到的 load 不再覆盖 sync 的治愈值；无富卡保持原值走现有空渲染）。
      try {
        const snap = snapshotTrendEnrichCache();
        if (Object.keys(snap).length === 0) {
          setRecentlyViewedApps(recents);
          return;
        }
        const pickReal = (v: unknown): string | undefined => {
          if (typeof v !== 'string') return undefined;
          const t = v.trim();
          if (t === '' || isPlaceholderDescription(t)) return undefined;
          return v;
        };
        const healed = recents.map((r) => {
          const needDesc =
            typeof r.description !== 'string' || r.description.trim() === '' || isPlaceholderDescription(r.description);
          const needDescEn =
            typeof r.description_en === 'string' &&
            (r.description_en.trim() === '' || isPlaceholderDescription(r.description_en));
          if (!needDesc && !needDescEn) return r;
          const keys: string[] = [(r.id || '').toLowerCase()];
          if (r.owner && r.repo) keys.push(`${r.owner}/${r.repo}`.toLowerCase());
          let enrichDesc: string | undefined;
          let enrichDescEn: string | undefined;
          for (const k of keys) {
            if (!k) continue;
            const hit = snap[k];
            if (!hit) continue;
            if (needDesc && enrichDesc === undefined) {
              const cand = pickReal(hit.description);
              if (cand !== undefined) enrichDesc = cand;
            }
            if (needDescEn && enrichDescEn === undefined) {
              const candEn = pickReal(hit.description_en);
              if (candEn !== undefined) enrichDescEn = candEn;
            }
            if ((!needDesc || enrichDesc !== undefined) && (!needDescEn || enrichDescEn !== undefined)) break;
          }
          let next = r;
          if (needDesc && enrichDesc !== undefined) next = { ...next, description: enrichDesc };
          if (needDescEn && enrichDescEn !== undefined) next = { ...next, description_en: enrichDescEn };
          return next;
        });
        setRecentlyViewedApps(healed);
      } catch {
        setRecentlyViewedApps(recents);
      }
    } catch {
      // 忽略错误
    }
  }, []);

  const handleClearRecentViews = async () => {
    try {
      await api.clearViewHistory();
      setRecentlyViewedApps([]);
      showToast(t('toast.clear_history_success'), 'info');
    } catch {
      // 忽略错误
    }
  };

  // 同步详情快照缓存与卡片列表数据（消除后台条件探查与主动刷新之间的重复逻辑）
  // 列表 patch 仅在目标命中且字段确变时生成新对象并返回新数组，否则原引用返回，避免无谓全网格重渲染
  const syncDetailCacheAndAppLists = useCallback((idClean: string, detail: AppDetail, isBackgroundSilent = false) => {
    // F1：后端占位简介不污染内存快照——先算富卡兜底，落盘即存治愈值，
    // 后续 handleOpenDetail 命中缓存直接展现实简介，不再闪占位。
    const pickRealDescription = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      if (t === '' || isPlaceholderDescription(t)) return undefined;
      return v;
    };
    let enrichDesc: string | undefined;
    let enrichDescEn: string | undefined;
    try {
      const snap = snapshotTrendEnrichCache();
      const lookupKeys: string[] = [idClean, (detail.id || '').toLowerCase()];
      if (detail.owner && detail.repo) {
        lookupKeys.push(`${detail.owner}/${detail.repo}`.toLowerCase());
      }
      for (const k of lookupKeys) {
        if (!k) continue;
        const hit = snap[k];
        if (!hit) continue;
        if (enrichDesc === undefined) {
          const cand = pickRealDescription(hit.description);
          if (cand !== undefined) enrichDesc = cand;
        }
        if (enrichDescEn === undefined) {
          const candEn = pickRealDescription(hit.description_en);
          if (candEn !== undefined) enrichDescEn = candEn;
        }
        if (enrichDesc !== undefined && enrichDescEn !== undefined) break;
      }
    } catch {
      // 快照读取失败即无富卡兜底，沿用 prev/空逻辑
    }
    const detailDescIsPlaceholder = isPlaceholderDescription(detail.description);
    const detailDescEnIsPlaceholder =
      typeof detail.description_en === 'string' && isPlaceholderDescription(detail.description_en);

    // 内存快照存治愈值：占位即用富卡非占位兜底，无富卡即存 ''（渲染侧走现有空逻辑，不存占位文案）。
    const detailForCache: AppDetail =
      detailDescIsPlaceholder || detailDescEnIsPlaceholder
        ? {
            ...detail,
            description: detailDescIsPlaceholder ? (enrichDesc ?? '') : detail.description,
            description_en: detailDescEnIsPlaceholder ? (enrichDescEn ?? '') : detail.description_en,
          }
        : detail;
    appDetailMemoryCache.current.set(idClean, detailForCache);
    if (detail.id.toLowerCase() !== idClean) {
      appDetailMemoryCache.current.set(detail.id.toLowerCase(), detailForCache);
    }
    if (detail.owner && detail.repo) {
      const repoLower = `${detail.owner}/${detail.repo}`.toLowerCase();
      appDetailMemoryCache.current.set(repoLower, detailForCache);
      appDetailMemoryCache.current.set(`github.com/${repoLower}`, detailForCache);
    }

    if (activeDetailIdRef.current?.toLowerCase() === detail.id.toLowerCase() || activeDetailIdRef.current?.toLowerCase() === idClean) {
      setSelectedApp((prev) => {
        let nextDesc = detail.description;
        let nextDescEn = detail.description_en;
        if (detailDescIsPlaceholder) {
          nextDesc = enrichDesc ?? pickRealDescription(prev?.description) ?? '';
        }
        if (detailDescEnIsPlaceholder) {
          nextDescEn = enrichDescEn ?? pickRealDescription(prev?.description_en) ?? '';
        }
        if (!prev) return { ...detail, description: nextDesc, description_en: nextDescEn, isLoading: false, isRefreshing: false };
        if (
          !isBackgroundSilent ||
          prev.latest_version !== detail.latest_version ||
          prev.releases.length !== detail.releases.length ||
          prev.stars !== detail.stars ||
          detailDescIsPlaceholder ||
          detailDescEnIsPlaceholder
        ) {
          return { ...detail, description: nextDesc, description_en: nextDescEn, isLoading: false, isRefreshing: false };
        }
        return prev;
      });
    }

    const patchedIcon = detail.icon?.trim() && !isAvatarUrl(detail.icon) ? detail.icon.trim() : undefined;
    // stale 离线缓存不具权威：平台相关一律保持 pending（不确认、不治愈、不碰榜单缓存）
    const isStaleDetail = Boolean(detail.is_stale);
    const detailPlatforms = !isStaleDetail && detail.platforms && detail.platforms.length > 0 ? detail.platforms : undefined;
    const detailConfirmedEmpty = !isStaleDetail && !detailPlatforms;

    const patchSummary = (app: AppSummary): AppSummary => {
      const isTarget =
        app.id.toLowerCase() === idClean ||
        (detail.id && app.id.toLowerCase() === detail.id.toLowerCase());
      if (!isTarget) return app;
      const nextIcon = patchedIcon ? patchedIcon : app.icon;
      // stale 详情不碰平台：列表保持 pending，避免离线快照误治愈/误确认
      const nextPlatforms = detailPlatforms && (!app.platforms || app.platforms.length === 0)
        ? detailPlatforms
        : app.platforms;
      // 富卡全字段回填：同值即保持原引用（避免无谓全网格重渲染），异值即取详情新值；
      // Rust 合成占位简介视为空（保留列表实值，不污染三列表）；
      // 趋势富卡兜底：detail 占位且富卡有实值时优先用富卡，治愈已在 recents 的旧占位行；无富卡仍保留旧值（空/占位走现有空渲染）。
      const nextDescription = isPlaceholderDescription(detail.description)
        ? (enrichDesc ?? app.description)
        : detail.description;
      const nextDescriptionEnRaw = detail.description_en;
      const nextDescriptionEn =
        typeof nextDescriptionEnRaw === 'string' && isPlaceholderDescription(nextDescriptionEnRaw)
          ? (enrichDescEn ?? app.description_en)
          : nextDescriptionEnRaw;
      const nextHomepage = detail.homepage;
      if (
        app.stars === detail.stars &&
        app.forks === detail.forks &&
        app.latest_version === detail.latest_version &&
        app.icon === nextIcon &&
        app.platforms === nextPlatforms &&
        app.description === nextDescription &&
        (app.description_en ?? undefined) === (nextDescriptionEn ?? undefined) &&
        app.license === detail.license &&
        app.category === detail.category &&
        app.category_name === detail.category_name &&
        app.is_verified === detail.is_verified &&
        (app.homepage ?? null) === (nextHomepage ?? null) &&
        app.name === detail.name
      ) {
        return app;
      }
      return {
        ...app,
        stars: detail.stars,
        forks: detail.forks,
        latest_version: detail.latest_version,
        icon: nextIcon,
        platforms: nextPlatforms,
        description: nextDescription,
        description_en: nextDescriptionEn,
        license: detail.license,
        category: detail.category,
        category_name: detail.category_name,
        is_verified: detail.is_verified,
        homepage: nextHomepage,
        name: detail.name,
      };
    };

    const patchList = (prev: AppSummary[]): AppSummary[] => {
      let changed = false;
      const next = prev.map((app) => {
        const patched = patchSummary(app);
        if (patched !== app) changed = true;
        return patched;
      });
      return changed ? next : prev;
    };
    // 双键（idClean + detail.id，大小写不敏感）：与 patchSummary 同目标口径，兼容两者不一致
    const patchIconBoth = (prev: AppSummary[], icon: string): AppSummary[] => {
      const keyA = idClean.toLowerCase();
      const keyB = (detail.id || '').toLowerCase() || keyA;
      const once = patchAppIconList(prev, keyA, icon);
      return keyB === keyA ? once : patchAppIconList(once, keyB, icon);
    };
    setApps(patchList);
    // 在线段与本地段上下分段展示：详情回填必须直接落盘 onlineApps，不依赖 icon-changed 事件
    setOnlineApps(patchList);
    setRecentlyViewedApps(patchList);
    // 详情已取回仍为空（非 stale）：记为已确认 other，徽标/统计/过滤一次落定
    if (detailConfirmedEmpty) {
      const keys = new Set<string>([idClean, detail.id.toLowerCase()]);
      setPlatformResolvedOtherIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const k of keys) {
          if (!next.has(k)) {
            next.add(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    // 详情带回真实平台（非 stale）：解除已确认 other、驱逐榜单 stale [] 缓存、
    // 并向 TrendsView 推送治愈（列表 patch 覆盖不到未收录行，此处补齐）。
    // VoiceStudio 类 bug 的治愈路径：行内 Other → OS 图标，过滤/计数同步跟进。
    if (detailPlatforms) {
      const healKeys = detailHealKeysFor(idClean, detail.owner, detail.repo);
      // 兼容 detail.id 与 idClean 不一致时的双键
      const extraKeys = new Set<string>([idClean, detail.id.toLowerCase()]);
      for (const k of extraKeys) {
        if (k && !healKeys.includes(k)) healKeys.push(k);
      }
      setPlatformResolvedOtherIds((prev) => {
        let hit = false;
        for (const k of healKeys) {
          if (prev.has(k)) {
            hit = true;
            break;
          }
        }
        if (!hit) return prev;
        const next = new Set(prev);
        for (const k of healKeys) next.delete(k);
        return next;
      });
      evictTrendEnrichCachesForDetail(idClean, detail.owner, detail.repo);
      upsertTrendEnrichFromDetail(detail);
      try {
        const payload: DetailPlatformsHealPayload = {
          keys: healKeys,
          platforms: [...detailPlatforms],
          summary: appSummaryFromDetail(detail),
        };
        window.dispatchEvent(new CustomEvent(DETAIL_PLATFORMS_HEAL_EVENT, { detail: payload }));
      } catch {
        // 事件派发失败不影响列表已落定的治愈
      }
    }
    // 富卡全字段治愈（与平台治愈并行，不改平台语义）：非 stale 即用内存旧值 diff→upsert，
    // dirty 非空或已确认 other 即派发富卡事件（含 platforms 仅非空才带）；旧事件与 icon 通道不动。
    if (!isStaleDetail) {
      try {
        const prevLookup = (k: string): AppSummary | undefined => {
          const lk = k.trim().toLowerCase();
          if (!lk) return undefined;
          return (
            appsRef.current.find((a) => a.id.toLowerCase() === lk) ??
            onlineAppsRef.current.find((a) => a.id.toLowerCase() === lk) ??
            recentsRef.current.find((a) => a.id.toLowerCase() === lk)
          );
        };
        const healed = upsertTrendEnrichRichcard(detail, prevLookup);
        if (healed && (healed.dirtyFields.length > 0 || detailConfirmedEmpty)) {
          const richKeys = detailHealKeysFor(idClean, detail.owner, detail.repo);
          const extraKeys = new Set<string>([idClean, detail.id.toLowerCase()]);
          for (const k of extraKeys) {
            if (k && !richKeys.includes(k)) richKeys.push(k);
          }
          const payload: DetailRichcardHealPayload = {
            keys: richKeys,
            summary: healed.summary,
            dirtyFields: healed.dirtyFields,
            ...(detailPlatforms ? { platforms: [...detailPlatforms] } : null),
            ...(detailConfirmedEmpty ? { confirmedOther: true } : null),
          };
          window.dispatchEvent(new CustomEvent(DETAIL_RICHCARD_HEAL_EVENT, { detail: payload }));
        }
      } catch {
        // 富卡治愈失败不影响列表已落定的值
      }
    }

    if (patchedIcon) {
      invalidateIconCache(idClean);
      window.dispatchEvent(
        new CustomEvent('zstore:icon-changed', {
          detail: { appId: idClean, icon: patchedIcon },
        })
      );
    } else {
      // detail.icon 为空/avatar（如 oh-my-pi）：详情弹窗靠 getAppIconCycle 特供照常显示，
      // 但列表三段此前零 dispatch，在线段永不更新 → 此处用 iconCycle.url 直接回填落盘，不依赖事件。
      // （后端 iconCycle.selected_url 经 getAppIconCycle 收敛为前端 AppIconCycleResult.url；非 avatar 才用。）
      void api.getAppIconCycle(idClean).then((cycle) => {
        // 双落盘口径：url=data: 即时态（IPC临时、永不进盘），remote_url/remoteUrl=可持久化 URL；
        // 落盘/回填/dispatch 一律用 persistUrl（remote优先，url非data:才兜底，否则空即 L5/空不发）。
        const remote = typeof (cycle?.remote_url ?? cycle?.remoteUrl) === 'string'
          ? String(cycle?.remote_url ?? cycle?.remoteUrl).trim()
          : '';
        const fallbackUrl = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
        const persistUrl = remote !== '' ? remote : (!fallbackUrl.startsWith('data:') ? fallbackUrl : '');
        if (!persistUrl || isAvatarUrl(persistUrl)) return;
        const keyA = idClean.toLowerCase();
        // 预热文件：触发 Rust getOrFetchIcon 落盘副作用（icons/* 二进制 + catalog/cycle 行），失败不阻塞
        void api.getOrFetchIcon(idClean, persistUrl).catch(() => {});
        invalidateIconCache(keyA);
        preloadIcons([{ id: keyA, icon: persistUrl }]);
        setApps((prev) => patchIconBoth(prev, persistUrl));
        setOnlineApps((prev) => patchIconBoth(prev, persistUrl));
        setRecentlyViewedApps((prev) => patchIconBoth(prev, persistUrl));
        // 趋势内存级同步（单通道复用 `zstore:icon-changed` 监听，不直接碰 enrich L2，data: 禁入由 L2 侧保证）；
        // 此分支仅在 patchedIcon 为空时进入，与上分支 dispatch 天然互斥，不重复。
        window.dispatchEvent(
          new CustomEvent('zstore:icon-changed', {
            detail: { appId: idClean, icon: persistUrl },
          })
        );
      }).catch(() => {
        // 取不到轮换图标则保持占位，不阻塞
      });
    }
  }, []);

  // 打开应用详情弹窗（优先内存/数据库 0ms 瞬间秒开，且一个仓库生命周期内只拉取一次）
  // 经 useCallback + ref 稳定：搜索键入改 apps 时回调引用不变，memo 卡片不跟风重渲染
  const handleOpenDetail = useCallback(async (id: string, forceRefresh = false) => {
    const idClean = id.trim().toLowerCase();
    activeDetailIdRef.current = id;

    // 1. 若非主动强制刷新，优先检查前端内存级快照缓存，实现绝对零延迟 0ms 打开，无任何骨架屏闪烁
    if (!forceRefresh) {
      const cached = appDetailMemoryCache.current.get(idClean);
      if (cached) {
        // F1：缓存快照若为后端占位（旧缓存或富卡后到），即用富卡非占位治愈后再展，避免弹窗闪占位；
        // 富卡为空/占位则保持缓存原值（空走现有渲染逻辑，不引入新文案）。
        let cachedForShow = cached;
        if (isPlaceholderDescription(cached.description) || (typeof cached.description_en === 'string' && isPlaceholderDescription(cached.description_en))) {
          try {
            const snap = snapshotTrendEnrichCache();
            const cKeys: string[] = [idClean, (cached.id || '').toLowerCase()];
            if (cached.owner && cached.repo) cKeys.push(`${cached.owner}/${cached.repo}`.toLowerCase());
            for (const k of cKeys) {
              if (!k) continue;
              const hit = snap[k];
              if (!hit) continue;
              const useDesc =
                isPlaceholderDescription(cachedForShow.description) &&
                typeof hit.description === 'string' &&
                hit.description.trim() !== '' &&
                !isPlaceholderDescription(hit.description)
                  ? hit.description
                  : cachedForShow.description;
              const useDescEn =
                typeof cachedForShow.description_en === 'string' &&
                isPlaceholderDescription(cachedForShow.description_en) &&
                typeof hit.description_en === 'string' &&
                hit.description_en.trim() !== '' &&
                !isPlaceholderDescription(hit.description_en)
                  ? hit.description_en
                  : cachedForShow.description_en;
              if (useDesc !== cachedForShow.description || useDescEn !== cachedForShow.description_en) {
                cachedForShow = { ...cachedForShow, description: useDesc, description_en: useDescEn };
              }
              if (
                !isPlaceholderDescription(cachedForShow.description) &&
                (typeof cachedForShow.description_en !== 'string' || !isPlaceholderDescription(cachedForShow.description_en))
              ) {
                break;
              }
            }
          } catch {
            // 快照失败则直接展示缓存
          }
        }
        // 先以 0ms 瞬间展示内存快照，避免骨架屏闪烁
        setSelectedApp({ ...cachedForShow, isLoading: false, isRefreshing: false, loadError: undefined });
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
      const selectedSnapshot = selectedAppRef.current;
      if (selectedSnapshot && selectedSnapshot.owner && selectedSnapshot.repo) {
        const repoLower = `${selectedSnapshot.owner}/${selectedSnapshot.repo}`.toLowerCase();
        appDetailMemoryCache.current.delete(repoLower);
        appDetailMemoryCache.current.delete(`github.com/${repoLower}`);
      }
    }

    // 2. 内存未命中或主动刷新：若弹窗已打开则保持现有视图无感刷新，否则展示基础卡片信息
    const existing =
      appsRef.current.find((a) => a.id.toLowerCase() === idClean) ||
      onlineAppsRef.current.find((a) => a.id.toLowerCase() === idClean) ||
      recentsRef.current.find((a) => a.id.toLowerCase() === idClean);

    // F1：富卡真简介并入——existing 只覆盖三列表，未收录趋势行在此缺席；
    // 经 snapshotTrendEnrichCache() 取富卡非占位 description 作为初始值，
    // 避免 loading 阶段（“正在获取应用元数据...”）与后端占位覆盖弹窗。
    // 富卡为空/占位时保持现有逻辑（loading 文案或空简介渲染），不引入新占位文案。
    const pickRealDesc = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      if (t === '' || isPlaceholderDescription(t)) return undefined;
      return v;
    };
    let enrichInitialDesc: string | undefined;
    let enrichInitialDescEn: string | undefined;
    try {
      const snap = snapshotTrendEnrichCache();
      const enrichKeys: string[] = [idClean];
      if (existing?.owner && existing?.repo) {
        enrichKeys.push(`${existing.owner}/${existing.repo}`.toLowerCase());
      }
      if (existing?.id) {
        const eid = existing.id.toLowerCase();
        if (!enrichKeys.includes(eid)) enrichKeys.push(eid);
      }
      for (const k of enrichKeys) {
        if (!k) continue;
        const hit = snap[k];
        if (!hit) continue;
        if (enrichInitialDesc === undefined) {
          const cand = pickRealDesc(hit.description);
          if (cand !== undefined) enrichInitialDesc = cand;
        }
        if (enrichInitialDescEn === undefined) {
          const candEn = pickRealDesc(hit.description_en);
          if (candEn !== undefined) enrichInitialDescEn = candEn;
        }
        if (enrichInitialDesc !== undefined && enrichInitialDescEn !== undefined) break;
      }
    } catch {
      // 快照失败即无富卡兜底，保持原有初始逻辑
    }

    const selectedSnapshot = selectedAppRef.current;
    const initialDetail: AppDetailViewModel = selectedSnapshot && selectedSnapshot.id.toLowerCase() === idClean && forceRefresh
      ? { ...selectedSnapshot, isLoading: false, isRefreshing: true, loadError: undefined }
      : existing
      ? {
          id: existing.id,
          name: existing.name,
          description_en: pickRealDesc(existing.description_en) ?? enrichInitialDescEn ?? '',
          owner: existing.owner,
          repo: existing.repo,
          icon: existing.icon,
          icon_bg: existing.icon_bg,
          description: pickRealDesc(existing.description) ?? enrichInitialDesc ?? '',
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
          description: enrichInitialDesc ?? '正在获取应用元数据...',
          description_en: enrichInitialDescEn,
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
          platforms: [],
          isLoading: true,
          isRefreshing: forceRefresh,
        };

    // 0ms 同步打开弹窗或切换刷新态，主界面无任何阻塞感
    setSelectedApp(initialDetail);
    // 浏览记录先落盘不阻塞详情；recents 刷新延后到详情同步之后，避免后到的后端占位快照覆盖富卡治愈值（load 内自带富卡治愈）。
    void api.recordAppView(id).catch(() => {});

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
    await loadRecentViews();
  }, [loadRecentViews, syncDetailCacheAndAppLists]);

  // 深链调度分发器（功能 E）
  const {
    pendingDeepLinkInstall,
    setPendingDeepLinkInstall,
  } = useDeepLink({
    handleOpenDetail,
    handleSearchChange,
    setSelectedDeveloper,
    setCurrentView,
    showToast,
    t,
  });

  // Toggle Watch (FR-6.2: 关注 / 取消关注，后端未就绪时 Toast 提示且不崩溃)
  // useCallback + ref 稳定引用：搜索键入/图标升级时不连带卡片重渲染，仅选中态变化的那张经 isWatched 重渲染
  const handleToggleWatch = useCallback(async (id: string) => {
    const isWatched = watchedRef.current.has(id);
    try {
      if (isWatched) {
        await api.unwatchApp(id);
      } else {
        await api.watchApp(id);
      }
    } catch (e) {
      showToast(t('toast.watch_failed', { error: String(e) }), 'error');
      return;
    }
    setWatchedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast(t('toast.watch_unfollowed'), 'info');
      } else {
        next.add(id);
        showToast(t('toast.watch_followed'), 'success');
      }
      return next;
    });
    if (isWatched) {
      setWatchNotifications((prev) => prev.filter((n) => n.app_id !== id));
    }
  }, [showToast, t]);

  const handleDismissWatchNotification = useCallback((appId: string) => {
    setWatchNotifications((prev) => prev.filter((n) => n.app_id !== appId));
  }, []);

  // 切换收藏状态（稳定回调，供 memo 卡片复用）
  const handleToggleFavorite = useCallback(async (id: string) => {
    await api.toggleFavorite(id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast(t('toast.favorite_removed'), 'info');
      } else {
        next.add(id);
        showToast(t('toast.favorite_added'), 'success');
      }
      return next;
    });
  }, [showToast, t]);

  // 任务 3：设备平台切换。空选择是有效状态（代表空列表；页面渲染筛选为空的引导状态），
  // 因此对任何已知 ID 的切换均无条件提交。切换逻辑位于更新函数（函数式 updater）内部，
  // 保证始终基于最新提交的选择进行计算，同一 tick 内的双击顺序生效。
  // 未知 ID 会被静默忽略（侧栏仅发射已知 ID，无需 Toast 提示）。
  const handleTogglePlatform = useCallback((id: PlatformId) => {
    setSelectedPlatforms((prev) => togglePlatformSet(prev, id));
  }, []);

  // 应用单项更新
  const handleApplyUpdate = async (id: string) => {
    try {
      const updatedApp = await api.installApp(id);
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
    await api.setAppSkipVersion(id, target?.latest_version ?? null);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.skip_update', { id }), 'info');
  };

  // 跳过指定版本（功能 C）
  const handleSkipVersion = async (id: string, version: string) => {
    await api.setAppSkipVersion(id, version);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.skip_version', { id, version }), 'info');
  };

  // 锁定当前版本（功能 C）
  const handleFreezeVersion = async (id: string) => {
    await api.setAppFrozen(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    showToast(t('toast.lock_version', { id }), 'info');
  };

  // 隐藏应用（功能 C）
  const handleHideApp = async (id: string) => {
    await api.setAppHidden(id, true);
    setUpdates((prev) => prev.filter((u) => u.app_id !== id));
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const catalogApps = await api.searchApps(searchQuery);
    setApps(catalogApps);
    showToast(t('toast.hide_app', { id }), 'info');
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
    showToast(t('toast.clear_rules', { id: appId }), 'success');
  };

  // 清除跳过版本规则
  const handleClearRuleSkip = async (appId: string) => {
    await api.setAppSkipVersion(appId, null);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(t('toast.restore_rules', { id: appId }), 'success');
  };

  // 切换版本锁定状态
  const handleToggleRuleFrozen = async (appId: string, isFrozen: boolean) => {
    await api.setAppFrozen(appId, isFrozen);
    const rules = await api.getUpdateRules();
    setUpdateRules(rules);
    const freshUpdates = await api.checkForUpdates();
    setUpdates(freshUpdates);
    showToast(isFrozen ? t('toast.rule_locked', { id: appId }) : t('toast.rule_unlocked', { id: appId }), 'info');
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
      const freshUpdates = await api.checkForUpdates(true);
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

  // 扫描系统已安装的开源应用（FR-5.3）
  const handleScanSystemApps = () => {
    setIsImportModalOpen(true);
  };

  const handleImportSuccess = async (count: number) => {
    showToast(t('toast.batch_import_success', { count }), 'success');
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
  // 待确认行恒可见（不看 Other 勾选），落定后再走 matchPlatformSet。
  const platformFilteredApps = useMemo(
    () => apps.filter((a) => matchPlatformSetWithPending(a, selectedPlatforms, platformResolvedOtherIds)),
    [apps, selectedPlatforms, platformResolvedOtherIds]
  );
  // 搜索在线段同口径平台过滤：与本地段一致，待确认恒可见，落定后走正常过滤。
  const platformFilteredOnlineApps = useMemo(
    () => onlineApps.filter((a) => matchPlatformSetWithPending(a, selectedPlatforms, platformResolvedOtherIds)),
    [onlineApps, selectedPlatforms, platformResolvedOtherIds]
  );

  // 任务 4（设备平台全局过滤）：侧栏分组的各平台应用计数，
  // 基于全量 `apps` 数组（而非已过滤数组）计算，以便准确呈现“有多少应用支持该设备”。
  // 一次扫完 6 项：已确认 other 才计入虚拟 other 桶，待确认行暂不计数（首绘不闪 Other=23，
  // 落定后单次更新），大小写归一，同应用去重后各桶 +1（与 6×filter 语义一致）。
  const platformCounts = useMemo(() => {
    const counts = {} as Record<PlatformId, number>;
    for (const id of PLATFORM_IDS) {
      counts[id] = 0;
    }
    const known = new Set<string>(PLATFORM_IDS as readonly string[]);
    for (const a of apps) {
      if (!a.platforms || a.platforms.length === 0) {
        // 待确认：暂不计入任何桶；已确认 other：仅计 other 桶
        if (isPlatformPending(a, platformResolvedOtherIds)) continue;
        counts['other'] += 1;
        continue;
      }
      const seen = new Set<string>();
      for (const p of a.platforms) {
        const n = normalizePlatform(p);
        if (known.has(n) && !seen.has(n)) {
          seen.add(n);
          counts[n as PlatformId] += 1;
        }
      }
    }
    return counts;
  }, [apps, platformResolvedOtherIds]);

  // 目录 id（小写）→ AppSummary 索引，供已安装/更新列表 O(1) 查表，避免每行 apps.find 全扫
  const appsById = useMemo(() => {
    const map = new Map<string, AppSummary>();
    for (const a of apps) {
      const key = a.id.toLowerCase();
      if (!map.has(key)) map.set(key, a);
    }
    return map;
  }, [apps]);

  const filteredInstalledApps = useMemo(() => {
    return installedApps.filter((inst) => {
      const catalogEntry = appsById.get(inst.app_id.toLowerCase());
      return !catalogEntry || matchPlatformSetWithPending(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
    });
  }, [installedApps, appsById, selectedPlatforms, platformResolvedOtherIds]);

  const filteredUpdates = useMemo(() => {
    return updates.filter((u) => {
      const catalogEntry = appsById.get(u.app_id.toLowerCase());
      return !catalogEntry || matchPlatformSetWithPending(catalogEntry, selectedPlatforms, platformResolvedOtherIds);
    });
  }, [updates, appsById, selectedPlatforms, platformResolvedOtherIds]);

  const handleResetPlatformFilter = useCallback(() => {
    setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS));
  }, []);

  // 趋势榜单平台分布（TrendsView 上报其榜单行口径）：趋势页侧栏计数切到该口径，
  // 其余页面沿用收录库口径。null = 尚未上报（首绘沿用收录库，避免闪 0）。
  const [trendsPlatformCounts, setTrendsPlatformCounts] = useState<Record<PlatformId, number> | null>(null);
  const handleTrendsPlatformCounts = useCallback((counts: Record<PlatformId, number>) => {
    setTrendsPlatformCounts(counts);
  }, []);
  const sidebarPlatformCounts = currentView === 'trends' && trendsPlatformCounts ? trendsPlatformCounts : platformCounts;

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
      ? appsById.get(pendingDeepLinkInstall.toLowerCase()) ??
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
      {/* Frameless all-edge resize zones (Tauri-only, no-op in browser demo) */}
      <React.Suspense fallback={null}>
        <ResizeHandles />
      </React.Suspense>
      {/* 顶部标题栏 */}
      <TitleBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onSearchSubmit={handleSearchSubmit}
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
          onResetPlatforms={handleResetPlatformFilter}
          platformCounts={sidebarPlatformCounts}
        />

        {/* 主内容显示区域 */}
        <main className="content-area">
          {currentView === 'home' && (
            // 搜索双段空态：本地段与在线段都为空时才走整页空态（保留在线搜索入口）；
            // 任一段有结果即进 HomeView 上下分段展示（本地在上、在线在下）。
            searchQuery.trim() && platformFilteredApps.length === 0 && platformFilteredOnlineApps.length === 0 ? (
              <div className="search-empty-state" style={{ marginTop: '40px', textAlign: 'center' }}>
                <EmptyState
                  icon={<Search size={40} strokeWidth={1.5} />}
                  title={
                    isSearchingOnline
                      ? t('search.searching_online', '正在在线搜索...')
                      : onlineSearchPerformed
                        ? t('search.no_online_results', '未找到相关应用')
                        : t('search.no_local_results', '本地未找到匹配应用')
                  }
                  description={
                    isSearchingOnline
                      ? t('search.searching_online_desc', '正在向云端检索应用数据，请稍候...')
                      : onlineSearchPerformed
                        ? t('search.online_empty_desc', '在线搜索亦未检索到匹配结果，请尝试其他关键词或直接输入 owner/repo')
                        : t('search.press_enter_online_hint', '未在本地索引中找到相关应用，按回车在线搜索或点击下方按钮检索 GitHub')
                  }
                  action={
                    !isSearchingOnline && (
                      <button
                        type="button"
                        className="btn-fluent btn-primary"
                        onClick={() => handleSearchSubmit(searchQuery)}
                      >
                        {onlineSearchPerformed
                          ? t('search.retry_online', '重新在线搜索')
                          : t('search.search_online_btn', '在线搜索')}
                      </button>
                    )
                  }
                />
              </div>
            ) : (
              <HomeView
                apps={platformFilteredApps}
                platformResolvedOtherIds={platformResolvedOtherIds}
                installedIds={installedIds}
                installingIds={installingAppIds}
                favoriteIds={favoriteIds}
                watchedIds={watchedIds}
                recentlyViewedApps={searchQuery.trim() ? [] : recentlyViewedApps}
                searchQuery={searchQuery}
                onOpenDetail={handleOpenDetail}
                onQuickInstall={handleQuickInstall}
                onToggleFavorite={handleToggleFavorite}
                onToggleWatch={handleToggleWatch}
                onNavigateTrends={() => setCurrentView('trends')}
                onClearRecentViews={handleClearRecentViews}
                onResetPlatformFilter={handleResetPlatformFilter}
                isOnlineResults={isOnlineResultSet}
                onlineApps={platformFilteredOnlineApps}
                isSearchingOnline={isSearchingOnline}
                onlineSearchPerformed={onlineSearchPerformed}
                onlineHasMore={onlineHasMore}
                isLoadingOnlineMore={isLoadingOnlineMore}
                onOnlineLoadMore={handleOnlineLoadMore}
              />
            )
          )}

          {currentView === 'trends' && (
            <TrendsView
              apps={platformFilteredApps}
              allApps={apps}
              selectedPlatforms={selectedPlatforms}
              platformResolvedOtherIds={platformResolvedOtherIds}
              onDisplayPlatformCounts={handleTrendsPlatformCounts}
              favoriteIds={favoriteIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onResetPlatformFilter={handleResetPlatformFilter}
            />
          )}

          {currentView === 'categories' && (
            <CategoriesView
              apps={platformFilteredApps}
              platformResolvedOtherIds={platformResolvedOtherIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onResetPlatformFilter={handleResetPlatformFilter}
            />
          )}

          {currentView === 'favorites' && (
            <FavoritesView
              apps={platformFilteredApps}
              platformResolvedOtherIds={platformResolvedOtherIds}
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
              installedApps={filteredInstalledApps}
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
              updates={filteredUpdates}
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
        <InstallConfirmDialog
          intro="外部链接请求安装以下应用，请确认后再继续："
          appName={pendingDeepLinkDetail?.name ?? pendingDeepLinkSummary?.name ?? pendingDeepLinkInstall}
          repoLine={pendingDeepLinkDetail
            ? `${pendingDeepLinkDetail.owner}/${pendingDeepLinkDetail.repo}`
            : pendingDeepLinkSummary
              ? `${pendingDeepLinkSummary.owner}/${pendingDeepLinkSummary.repo}`
              : pendingDeepLinkInstall}
          source={pendingDeepLinkDetail?.forge_host ?? pendingDeepLinkSummary?.forge_host ?? '未知来源'}
          sha256={pendingDeepLinkSha256}
          onCancel={() => {
            setPendingDeepLinkInstall(null);
            showToast(t('toast.deeplink_cancelled'), 'info');
          }}
          onConfirm={() => {
            const id = pendingDeepLinkInstall;
            setPendingDeepLinkInstall(null);
            if (id !== null) {
              void handleInstallApp(id);
            }
          }}
        />
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
          platformPending={isPlatformPending(selectedApp, platformResolvedOtherIds)}
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
