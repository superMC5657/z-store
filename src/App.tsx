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
import { PendingView, type PendingDraftItem } from './views/PendingView';
import { InstalledView } from './views/InstalledView';
import { UpdatesView } from './views/UpdatesView';
import { SettingsView } from './views/SettingsView';
import { FavoritesView } from './views/FavoritesView';
import { EmptyState } from './components/EmptyState';
import { Search } from 'lucide-react';
import { AppDetailViewModel, AppSummary, OAuthUser, UpdateItem, UpdateCheckProgressPayload, UpdateRule, ViewType, WatchUpdatedPayload } from './types';
import { tauriApi } from './services/api';
import { entryFromWire, entryToCollectedSummary, itemToWire } from './services/custom/mappers';
import type { DraftEntry } from './services/custom/types';
import { togglePlatformSet, type PlatformId } from './lib/platformFilter';
import { isPlatformLoading } from './lib/platformFilter';
import { normalizeId } from './services/normalizeId';
import { patchAppIconList, subscribeIconWrites } from './services/iconStore';
import { patchSearchListCacheIcon } from './services/search/searchListCache';

import {
  PLATFORM_FILTER_STORAGE_KEY,
  loadSelectedPlatforms,
} from './app/platformStorage';
import { InstallConfirmDialog } from './app/InstallConfirmDialog';
import { usePlatformBackfill } from './app/hooks/usePlatformBackfill';
import { useSearchState } from './app/hooks/useSearchState';
import { useInstallState } from './app/hooks/useInstallState';
import { useDeepLink } from './app/hooks/useDeepLink';
import { useDetailCacheSync } from './app/hooks/useDetailCacheSync';
import { useUncatalogedJoin } from './app/favoritesUncataloged';
import { useAppSubscriptions } from './app/hooks/useAppSubscriptions';
import { useAppSelectors } from './app/selectors';
import { selectMergedCatalogApps } from './app/selectors';
import { isInstalled as selectIsInstalled, isManaged as selectIsManaged } from './app/selectors';
import { useUpdateActions } from './app/hooks/useUpdateActions';
import { useToasts } from './useToasts';
import { useAppSettings } from './useAppSettings';
import { useTranslation } from 'react-i18next';
import './i18n';

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateCheckProgress, setUpdateCheckProgress] = useState<UpdateCheckProgressPayload | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<AppDetailViewModel | null>(null);
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
  // 待收录草稿后端列表（null = 未加载/非 Tauri 预览，
  // 此时 PendingView 缺 entries 走内部本地态；备份/转正语义不受影响）。
  const [customApps, setCustomApps] = useState<DraftEntry[] | null>(null);
  // 任务 3（设备平台全局过滤）：App 级别多选平台状态，默认选中全部 6 种 PLATFORM_IDS（含虚拟 other），
  // 仅持久化至 localStorage——刻意不接入 tauriApi.getSettings()/UserDataBackup（仅为本地界面偏好，非备份数据）。
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(() => loadSelectedPlatforms());
  // FR-7 OAuth 登录态（详情弹窗标星门控）
  const [oauthUser, setOAuthUser] = useState<OAuthUser | null>(null);
  // 卡片 memo 稳定回调支撑：经 ref 读取最新列表/详情，避免 handleOpenDetail 依赖 apps 而每搜必变
  const appsRef = useRef<AppSummary[]>([]);
  appsRef.current = apps;
  const recentsRef = useRef<AppSummary[]>([]);
  recentsRef.current = recentlyViewedApps;
  const watchedRef = useRef<Set<string>>(watchedIds);
  watchedRef.current = watchedIds;

  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const { toasts, showToast, handleDismissToast } = useToasts();
  const { t } = useTranslation();

  // 待收录草稿透传（list/save/delete/markSubmitted 经 tauriApi）。
  const reloadCustomApps = useCallback(async () => {
    try {
      const wires = await tauriApi.listCustomApps(true);
      setCustomApps(wires.map(entryFromWire));
    } catch {
      // 非 Tauri 预览/后端未就绪：保持 null，PendingView 走内部本地态
      setCustomApps(null);
    }
  }, []);

  // 待收录变更跟随（移入收录/备份导入后刷新）+ 挂载即拉取：
  // 本地收录需首页/分类同展，挂载拉取保证首刷补黄（缺席无标，就绪重标），跨视图变更全局跟随。
  useEffect(() => {
    void reloadCustomApps();
    const onChanged = () => {
      void reloadCustomApps();
    };
    window.addEventListener('zstore:custom-apps-changed', onChanged);
    return () => {
      window.removeEventListener('zstore:custom-apps-changed', onChanged);
    };
  }, [reloadCustomApps]);

  const pendingEntries = useMemo(() => customApps ?? undefined, [customApps]);
  const pendingCount = useMemo(
    () => customApps?.filter((e) => !e.archived).length ?? 0,
    [customApps],
  );

  // 移入收录入口抑制集：后端 customApps 全量 id + 本地乐观移入 id（归一小写），
  // 即 `selectMergedCatalogApps` 会命中 custom 行的 id 集合；富卡内部入口据此隐藏已存在项。
  // customApps 懒加载（进待收录页才拉），乐观集保证移入当刻即隐藏，不依赖后端往返。
  const [movedInIds, setMovedInIds] = useState<Set<string>>(() => new Set<string>());
  useEffect(() => {
    const onMoved = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
      const key = normalizeId(id);
      if (!key) return;
      setMovedInIds((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    };
    window.addEventListener('zstore:custom-apps-changed', onMoved);
    return () => {
      window.removeEventListener('zstore:custom-apps-changed', onMoved);
    };
  }, []);
  const customIds = useMemo(() => {
    const out = new Set<string>(movedInIds);
    for (const e of customApps ?? []) {
      const key = normalizeId(e.id);
      if (key) out.add(key);
    }
    return out;
  }, [customApps, movedInIds]);

  const handleSaveCustomApp = async (draft: PendingDraftItem) => {
    const existing = customApps?.find((e) => e.id === draft.id);
    await tauriApi.saveCustomApp(itemToWire(draft, existing?.item));
    await reloadCustomApps();
  };
  const handleDeleteCustomApp = async (id: string) => {
    await tauriApi.deleteCustomApp(id);
    await reloadCustomApps();
  };
  const handleMarkCustomSubmitted = async (id: string, prUrl: string) => {
    await tauriApi.markCustomSubmitted(id, prUrl);
    await reloadCustomApps();
  };
  const handleCollectLocalApp = async (id: string) => {
    await tauriApi.collectLocalApp(id);
    await reloadCustomApps();
  };
  const handleRevertCollectedApp = async (id: string) => {
    try {
      await tauriApi.revertCollectedApp(id);
      await reloadCustomApps();
    } catch (e) {
      // 落盘失败必须报错并向上传递（PendingView 侧同样 toast），禁止静默本地翻 draft
      // 否则当次停留收录退出、重启又因 DB 仍 collected 而重现。
      const detail = e instanceof Error ? e.message : String(e);
      showToast(
        t('pending.revert_failed', {
          id,
          error: detail,
          defaultValue: `退回草稿失败：${id}：${detail}`,
        }),
        'error',
      );
      throw e;
    }
  };

  // 本地收录合并流：仅 collected 系且未归档进入首页/分类（可搜可装，橘黄 local 徽标）。
  const collectedSummaries = useMemo(() => {
    const out: Array<AppSummary & { status: string; archived: boolean }> = [];
    for (const e of customApps ?? []) {
      if (e.archived || e.status !== 'collected') continue;
      out.push(entryToCollectedSummary(e));
    }
    return out;
  }, [customApps]);

  // 1. 安装管理 Hook
  const {
    installedApps,
    setInstalledApps,
    installingAppIds,
    uninstallingAppIds,
    isRefreshingInstalled,
    handleInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleRefreshInstalledApps,
    handleUninstallApp,
  } = useInstallState({
    currentView,
    apps,
    showToast,
    t,
  });

  // 2. 平台回填与搜索解耦
  const lazyBackfillRef = useRef<(summaries: AppSummary[], seq: number, forceRefresh?: boolean) => void>(() => {});

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
    lazyBackfillPlatforms: (summaries, seq, forceRefresh) => lazyBackfillRef.current(summaries, seq, forceRefresh),
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

  // 合并后全量（含本地，远端优先去重语义不动）：收藏 join/详情标注共用此口径，
  // 本地行保留 source='local'/status 供黄标判定。
  const mergedAppsForJoins = useMemo(
    () => selectMergedCatalogApps(apps, collectedSummaries, true),
    [apps, collectedSummaries],
  );

  // 3. 收藏/关注未收录占位行 left-join（深 join 模块 `useUncatalogedJoin`；
  // 仅收藏页消费，不进 apps/计数/其它视图）
  const {
    favoriteExtraApps,
    setFavoriteExtraApps,
    favoriteExtraAppsRef,
    loadUncatalogedDetail,
  } = useUncatalogedJoin({ favoriteIds, watchedIds, apps: mergedAppsForJoins });

  // 4. 详情快照缓存与卡片列表同步（内存 0ms 秒开 + ETag 后台探查 + 富卡/平台治愈）
  const {
    activeDetailIdRef,
    handleOpenDetail,
  } = useDetailCacheSync({
    selectedApp,
    appsRef,
    onlineAppsRef,
    recentsRef,
    setApps,
    setOnlineApps,
    setRecentlyViewedApps,
    setFavoriteExtraApps,
    setSelectedApp,
    setPlatformResolvedOtherIds,
    // customApps 未加载（null）即本地 lookup 未知：后端盖章行原样透传，避免误清本地标注。
    localApps: customApps === null ? undefined : collectedSummaries,
  });

  // 深链调度分发器（功能 E）
  const {
    stagedDeepLinkInstall,
    setStagedDeepLinkInstall,
  } = useDeepLink({
    handleOpenDetail,
    handleSearchChange,
    setSelectedDeveloper,
    setCurrentView,
    showToast,
    t,
  });

  // 5. 应用级订阅总线（初始拉取/catalog-synced/icon-ready +
  // 关注/更新流/OAuth + 更新中心切签检查 + 视图切换日志）
  // 图标写扇出订阅：店内唯一写口受理后四列表跟进（无 patch 的本地写如详情轮转亦经此落定；
  // patch 幂等，显式 patch 与扇出重复落定无闪烁；卸载即退订）。
  useEffect(() => {
    return subscribeIconWrites(({ targets, icon }) => {
      // 05 翻页一致性：图标就绪同时写透搜索列表缓存行（翻页回访/重搜命中即新图，不续 TTL）。
      for (const t of targets) {
        try {
          patchSearchListCacheIcon(t, icon);
        } catch {
          // 缓存写透失败不阻塞列表
        }
      }
      for (const t of targets) {
        try {
          setApps((prev) => patchAppIconList(prev, t, icon));
        } catch {
          // 单列表失败不阻塞其余
        }
        try {
          setOnlineApps((prev) => patchAppIconList(prev, t, icon));
        } catch {
          // 同上
        }
        try {
          setRecentlyViewedApps((prev) => patchAppIconList(prev, t, icon));
        } catch {
          // 同上
        }
        try {
          setFavoriteExtraApps((prev) => patchAppIconList(prev, t, icon));
        } catch {
          // 同上
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useAppSubscriptions({
    setApps,
    setOnlineApps,
    setRecentlyViewedApps,
    setFavoriteExtraApps,
    setInstalledApps,
    setFavoriteIds,
    setUpdateRules,
    setWatchedIds,
    setWatchNotifications,
    setUpdates,
    setOAuthUser,
    setIsCheckingUpdates,
    setUpdateCheckProgress,
    appsRef,
    onlineAppsRef,
    recentsRef,
    favoriteExtraAppsRef,
    currentSearchIdRef,
    selectedPlatforms,
    platformResolvedOtherIds,
    applyPersistedSettings,
    showToast,
    t,
    currentView,
    updatesCount: updates.length,
    localApps: collectedSummaries,
  });

  // 6. 派生选择器（平台过滤/计数/收藏 left-join 供给/已安装-更新过滤/深链确认解析）
  const {
    platformFilteredApps,
    platformFilteredOnlineApps,
    favoritesViewApps,
    filteredInstalledApps,
    filteredUpdates,
    handleResetPlatformFilter,
    handleTrendsPlatformCounts,
    sidebarPlatformCounts,
    installedIds,
    managedIds,
    managedLoaded,
    stagedDeepLinkDetail,
    stagedDeepLinkSummary,
    stagedDeepLinkSha256,
  } = useAppSelectors({
    apps,
    onlineApps,
    favoriteExtraApps,
    installedApps,
    updates,
    selectedPlatforms,
    setSelectedPlatforms,
    platformResolvedOtherIds,
    selectedApp,
    recentlyViewedApps,
    currentView,
    stagedDeepLinkInstall,
    customApps: collectedSummaries,
  });

  // 7. 更新规则动作簇（单项更新/忽略/跳过/锁定/隐藏/规则管理/批量升级/手动检查）
  const {
    handleApplyUpdate,
    handleIgnoreUpdate,
    handleSkipVersion,
    handleFreezeVersion,
    handleHideApp,
    handleRemoveRule,
    handleClearRuleSkip,
    handleToggleRuleFrozen,
    handleToggleRuleHidden,
    handleBatchUpdateAll,
    handleCheckUpdates,
  } = useUpdateActions({
    updates,
    setUpdates,
    setInstalledApps,
    setUpdateRules,
    setApps,
    setIsCheckingUpdates,
    setUpdateCheckProgress,
    searchQuery,
    showToast,
    t,
  });

  // 任务 3：平台选择变更时将其回写至 localStorage。
  useEffect(() => {
    try {
      window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([...selectedPlatforms]));
    } catch {
      // 忽略：无痕模式/配额满/存储抛错时保持内存选择状态
    }
  }, [selectedPlatforms]);

  // 导出软件资产 JSON 备份
  const handleExportAppsJson = () => {
    if (installedApps.length === 0) {
      showToast(t('toast.no_installed_to_export'), 'warning');
      return;
    }
    const data = {
      app: 'ZStore',
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

  const handleClearRecentViews = async () => {
    try {
      await tauriApi.clearViewHistory();
      setRecentlyViewedApps([]);
      showToast(t('toast.clear_history_success'), 'info');
    } catch {
      // 忽略错误
    }
  };

  // Toggle Watch (FR-6.2: 关注 / 取消关注，后端未就绪时 Toast 提示且不崩溃)
  // useCallback + ref 稳定引用：搜索键入/图标升级时不连带卡片重渲染，仅选中态变化的那张经 isWatched 重渲染
  const handleToggleWatch = useCallback(async (id: string) => {
    // 读写归一：读态经 normalizeId 查 watchedIds，写入口同样归一后再 has/watch/unwatch，
    // 大小写/空格变体（Owner/Repo vs owner/repo）点后可翻转。
    const key = normalizeId(id);
    if (!key) return;
    const isWatched = watchedRef.current.has(key);
    try {
      if (isWatched) {
        await tauriApi.unwatchApp(key);
      } else {
        await tauriApi.watchApp(key);
      }
    } catch (e) {
      showToast(t('toast.watch_failed', { error: String(e) }), 'error');
      return;
    }
    setWatchedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        showToast(t('toast.watch_unfollowed'), 'info');
      } else {
        next.add(key);
        showToast(t('toast.watch_followed'), 'success');
      }
      return next;
    });
    if (isWatched) {
      setWatchNotifications((prev) => prev.filter((n) => normalizeId(n.app_id) !== key));
    }
  }, [showToast, t]);

  const handleDismissWatchNotification = useCallback((appId: string) => {
    setWatchNotifications((prev) => prev.filter((n) => n.app_id !== appId));
  }, []);

  // 切换收藏状态（稳定回调，供 memo 卡片复用；入口归一，读写一致）
  const handleToggleFavorite = useCallback(async (id: string) => {
    const key = normalizeId(id);
    if (!key) return;
    await tauriApi.toggleFavorite(key);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        showToast(t('toast.favorite_removed'), 'info');
      } else {
        next.add(key);
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

  // 扫描系统已安装的开源应用（FR-5.3）
  const handleScanSystemApps = () => {
    setIsImportModalOpen(true);
  };

  const handleImportSuccess = async (count: number) => {
    showToast(t('toast.batch_import_success', { count }), 'success');
    try {
      const loadedInstalled = await tauriApi.getInstalledApps();
      setInstalledApps(loadedInstalled);
    } catch {
      /* Toast 提示后刷新静默失败 */
    }

    // 导入成功后刷新已安装列表，并后台复核更新（DB-only 合成读，不阻塞界面交互）
    tauriApi
      .checkForUpdates(false)
      .then((loadedUpdates) => {
        if (Array.isArray(loadedUpdates)) setUpdates(loadedUpdates);
      })
      .catch(() => undefined);
  };

  // 更新中心切签/挂载读 DB 快照（零网络；写仅手动 Refresh）。
  const handleEnterUpdatesTab = useCallback(() => {
    tauriApi
      .getCachedUpdates()
      .then((rows) => {
        if (Array.isArray(rows)) setUpdates(rows);
      })
      .catch(() => undefined);
  }, []);

  const handleSelectMirror = async (mirrorId: string) => {
    await tauriApi.switchMirror(mirrorId);
  };

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
          pendingCount={pendingCount}
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
                managedIds={managedLoaded ? managedIds : null}
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
                customIds={customIds}
                localApps={collectedSummaries}
              />
            )
          )}

          {currentView === 'trends' && (
            <TrendsView
              apps={platformFilteredApps}
              allApps={mergedAppsForJoins}
              selectedPlatforms={selectedPlatforms}
              platformResolvedOtherIds={platformResolvedOtherIds}
              onDisplayPlatformCounts={handleTrendsPlatformCounts}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              managedIds={managedLoaded ? managedIds : null}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onResetPlatformFilter={handleResetPlatformFilter}
              customIds={customIds}
            />
          )}

          {currentView === 'categories' && (
            <CategoriesView
              apps={platformFilteredApps}
              platformResolvedOtherIds={platformResolvedOtherIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              managedIds={managedLoaded ? managedIds : null}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onResetPlatformFilter={handleResetPlatformFilter}
            />
          )}

          {currentView === 'pending' && (
            <PendingView
              entries={pendingEntries}
              onSave={(draft) => handleSaveCustomApp(draft)}
              onDelete={(id) => handleDeleteCustomApp(id)}
              onMarkSubmitted={(id, prUrl) => handleMarkCustomSubmitted(id, prUrl)}
              onCollectLocal={(id) => handleCollectLocalApp(id)}
              onRevertToDraft={(id) => handleRevertCollectedApp(id)}
              onGetPrUrl={(id) => tauriApi.getCustomAppPrUrl(id)}
              onGetBatchPrUrl={(ids) => tauriApi.getCustomAppsBatchPrUrl(ids)}
              onNotify={(message, type) => showToast(message, type ?? 'info')}
            />
          )}

          {currentView === 'favorites' && (
            <FavoritesView
              apps={favoritesViewApps}
              platformResolvedOtherIds={platformResolvedOtherIds}
              favoriteIds={favoriteIds}
              watchedIds={watchedIds}
              installedIds={installedIds}
              installingIds={installingAppIds}
              managedIds={managedLoaded ? managedIds : null}
              oauthUser={oauthUser}
              onOpenDetail={handleOpenDetail}
              onQuickInstall={handleQuickInstall}
              onToggleFavorite={handleToggleFavorite}
              onToggleWatch={handleToggleWatch}
              onLoadUncatalogedDetail={loadUncatalogedDetail}
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
              onEnterUpdatesTab={handleEnterUpdatesTab}
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

      {/* 深度链接安装确认弹窗（显式用户授权门禁） */}
      {stagedDeepLinkInstall !== null && (
        <InstallConfirmDialog
          intro="外部链接请求安装以下应用，请确认后再继续："
          appName={stagedDeepLinkDetail?.name ?? stagedDeepLinkSummary?.name ?? stagedDeepLinkInstall}
          repoLine={stagedDeepLinkDetail
            ? `${stagedDeepLinkDetail.owner}/${stagedDeepLinkDetail.repo}`
            : stagedDeepLinkSummary
              ? `${stagedDeepLinkSummary.owner}/${stagedDeepLinkSummary.repo}`
              : stagedDeepLinkInstall}
          source={stagedDeepLinkDetail?.forge_host ?? stagedDeepLinkSummary?.forge_host ?? '未知来源'}
          sha256={stagedDeepLinkSha256}
          onCancel={() => {
            setStagedDeepLinkInstall(null);
            showToast(t('toast.deeplink_cancelled'), 'info');
          }}
          onConfirm={() => {
            const id = stagedDeepLinkInstall;
            setStagedDeepLinkInstall(null);
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
          isInstalled={selectIsInstalled(selectedApp.id, installedIds)}
          isManaged={managedLoaded ? selectIsManaged(selectedApp.id, managedIds) : null}
          isExploreMode={currentView === 'home' || currentView === 'trends' || currentView === 'categories'}
          isFavorite={favoriteIds.has(selectedApp.id)}
          isWatched={watchedIds.has(selectedApp.id)}
          isInstallingGlobal={installingAppIds.has(selectedApp.id)}
          isUninstallingGlobal={uninstallingAppIds.has(selectedApp.id)}
          platformLoading={isPlatformLoading(selectedApp, platformResolvedOtherIds)}
          oauthUser={oauthUser}
          onClose={() => {
            activeDetailIdRef.current = null;
            setSelectedApp(null);
          }}
          onInstall={handleInstallApp}
          onLaunch={handleLaunchApp}
          onUninstall={handleUninstallApp}
          onUnmanage={handleUnmanageApp}
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
        managedIds={managedLoaded ? managedIds : null}
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
