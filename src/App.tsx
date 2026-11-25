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
import { FeaturedView } from './views/FeaturedView';
import { SearchResultsView } from './views/SearchResultsView';
import { LatestView } from './views/LatestView';
import { TrendsView } from './views/TrendsView';
import { LaunchpadView } from './views/LaunchpadView';
import { CategoriesView } from './views/CategoriesView';
import { InstalledView } from './views/InstalledView';
import { FavoritesView } from './views/FavoritesView';
import { EmptyState } from './components/EmptyState';
import { FilterEmptyState } from './views/ViewShell';
import { Search } from 'lucide-react';
import { AppDetailViewModel, CollectionModalData, OAuthUser, ViewType, createNavigate } from './types';
import { maskRecentViews } from './services/recentViewsMask';
import { tauriApi } from './services/api';
import { isPlatformLoading } from './lib/platformFilter';
import { normalizeId } from './services/normalizeId';

import { InstallConfirmDialog } from './app/InstallConfirmDialog';
import { useCatalogLists } from './app/hooks/useCatalogLists';
import { usePlatformFilter, useSidebarPlatformCounts } from './app/hooks/usePlatformFilter';
import { useSearchState } from './app/hooks/useSearchState';
import { useMyAppsState } from './app/hooks/useMyAppsState';
import { useDeepLink } from './app/hooks/useDeepLink';
import { useCustomApps } from './app/hooks/useCustomApps';
import { useDetailCacheSync } from './app/hooks/useDetailCacheSync';
import { useUncatalogedJoin } from './app/favoritesUncataloged';
import { useAppSubscriptions } from './app/hooks/useAppSubscriptions';
import { useAppSelectors, selectMergedCatalogApps } from './app/selectors';
import { isInstalled as selectIsInstalled, isManaged as selectIsManaged } from './app/selectors';
import { useWatchState } from './app/hooks/useWatchState';
import { useViewScrollMemory } from './app/hooks/useViewScrollMemory';
import { AppContextProvider, type AppActions, type LibraryState } from './app/AppContext';
import { useToasts } from './useToasts';
import { useAppSettings } from './useAppSettings';
import { noteStarredLogin } from './services/starred/starredMemory';
import { useTranslation } from 'react-i18next';
import { lazyNamed, whenIdle } from './lib/lazyNamed';
import { scrollBehavior } from './lib/motion';
import './i18n';

// 非首屏页面与弹窗按需分块：设置、待收录与各类弹窗不参与冷启动解析。
const SettingsView = lazyNamed(() => import('./views/SettingsView'), 'SettingsView');
const PendingView = lazyNamed(() => import('./views/PendingView'), 'PendingView');
const AppDetailModal = lazyNamed(() => import('./components/AppDetailModal'), 'AppDetailModal');
const DeveloperProfileModal = lazyNamed(() => import('./components/DeveloperProfileModal'), 'DeveloperProfileModal');
const AppImportModal = lazyNamed(() => import('./components/AppImportModal'), 'AppImportModal');
const RulesManagerModal = lazyNamed(() => import('./components/RulesManagerModal'), 'RulesManagerModal');
const CollectionPreviewModal = lazyNamed(() => import('./components/CollectionPreviewModal'), 'CollectionPreviewModal');

/** 安装请求：无校验资产警示弹窗确认后需携原上下文重试。 */
interface InstallAppRequest {
  id: string;
  assetName?: string;
  customInstallDir?: string;
  /** 用户在无校验资产警示弹窗中显式放行。 */
  allowUnverified?: boolean;
}

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  // 集中导航入口：全部视图切换（Sidebar/搜索回跳/深链 open_view/账号设置/趋势跳转）唯一收口，
  // 合法 ViewType 校验收口于 types（非法视图拒绝，不回落 home）。
  const navigate = useMemo(() => createNavigate(setCurrentView), [setCurrentView]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const catalogLists = useCatalogLists();
  const {
    apps,
    fullCatalogApps,
    onlineApps,
    recentlyViewedApps,
    uncatalogedExtraApps,
    uncatalogedExtraAppsRef,
    setRecentlyViewedApps,
    setUncatalogedExtraApps,
  } = catalogLists;
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<AppDetailViewModel | null>(null);
  const [selectedDeveloper, setSelectedDeveloper] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [activeCollection, setActiveCollection] = useState<CollectionModalData | null>(null);
  // 一次性落点请求：深链要求「我的应用」落在「有更新」签；InstalledView 消费后复位
  const [focusMyAppsUpdates, setFocusMyAppsUpdates] = useState(false);
  // 开源广场深链定位目标（`zstore://launchpad/{id}`），视图高亮后清除。
  const [launchpadFocusId, setLaunchpadFocusId] = useState<string | null>(null);
  const clearLaunchpadFocus = useCallback(() => setLaunchpadFocusId(null), []);
  const {
    theme,
    settings,
    applyPersistedSettings,
    handleToggleTheme,
    handleSetTheme,
    handleToggleLanguage,
    handleUpdateSetting,
  } = useAppSettings();
  // OAuth 登录态（详情弹窗标星门控）
  const [oauthUser, setOAuthUser] = useState<OAuthUser | null>(null);
  // 登出/401 失效/换账号即清内存里的 `@me:` 私有 Star 缓存，不论收藏页是否挂载。
  const oauthLogin = oauthUser && !oauthUser.is_expired ? oauthUser.login || undefined : undefined;
  useEffect(() => {
    noteStarredLogin(oauthLogin);
  }, [oauthLogin]);

  // 应用内通知通道（关注提醒 / 自更新 / OAuth / 导入导出共用）
  const { toasts, showToast, handleDismissToast } = useToasts();
  const { t } = useTranslation();

  // 关注订阅域（Watch）
  const {
    watchedIds,
    watchNotifications,
    activeDismissedWatches,
    handleToggleWatch,
    handleEnterWatchedTab,
    handleDismissWatchNotification,
    handleRestoreWatchNotification,
  } = useWatchState({ isRulesModalOpen, showToast, t });

  // 详情弹窗几乎必开：首屏空闲时预取其分块，首次点卡片无需等待。
  useEffect(() => whenIdle(() => void AppDetailModal.preload().catch(() => undefined)), []);

  // 待收录草稿域
  const customAppsStore = useCustomApps();
  const { customApps, customAppEntries, customIds, localLibrarySummaries } = customAppsStore;

  // 设备平台过滤域：全局平台勾选、已确认 other、列表平台懒回填、搜索世代与视图级侧栏分布槽位
  const platformFilter = usePlatformFilter({ currentView, catalogLists });
  const {
    selectedPlatforms,
    platformResolvedOtherIds,
    setPlatformResolvedOtherIds,
    confirmPlatformOtherIds,
  } = platformFilter;

  const {
    searchQuery,
    currentSearchIdRef,
    isSearchingLocal,
    isSearchingOnline,
    onlineSearchPerformed,
    isOnlineResultSet,
    onlineHasMore,
    isLoadingOnlineMore,
    handleSearchDraft,
    handleSearchChange,
    handleSearchSubmit,
    handleOnlineLoadMore,
  } = useSearchState({
    currentView,
    navigate,
    catalogLists,
    lazyBackfillPlatforms: platformFilter.lazyBackfillPlatforms,
    searchSeqRef: platformFilter.searchSeqRef,
    showToast,
    t,
  });

  // 主内容区按视图记忆滚动位置；首页搜索结果是临时状态，不记忆。
  const contentRef = useRef<HTMLElement>(null);
  const isHomeSearching = currentView === 'home' && searchQuery.trim() !== '';
  useViewScrollMemory(contentRef, isHomeSearching ? null : currentView);

  // 合并后全量（含本地，远端优先去重语义不动）：收藏 join/详情标注/趋势/Star 共用此未裁剪全量口径，
  // 本地行保留 source='local'/status 供黄标判定。
  const catalogSourceApps = fullCatalogApps.length > 0 ? fullCatalogApps : apps;
  const mergedAppsForJoins = useMemo(
    () => selectMergedCatalogApps(catalogSourceApps, localLibrarySummaries, true),
    [catalogSourceApps, localLibrarySummaries],
  );

  // 收藏/关注未收录占位行 left-join（仅收藏页消费）
  const { loadUncatalogedDetail } = useUncatalogedJoin({
    favoriteIds,
    watchedIds,
    apps: mergedAppsForJoins,
    extraSlot: {
      items: uncatalogedExtraApps,
      setItems: setUncatalogedExtraApps,
      ref: uncatalogedExtraAppsRef,
    },
  });

  // 详情快照缓存与卡片列表同步
  const {
    activeDetailIdRef,
    handleOpenDetail,
  } = useDetailCacheSync({
    catalogLists,
    selectedApp,
    setSelectedApp,
    setPlatformResolvedOtherIds,
    // customApps 未加载（null）即本地 lookup 未知：后端盖章行原样透传，避免误清本地标注。
    localApps: customApps === null ? undefined : localLibrarySummaries,
  });

  // 深链调度分发器
  const {
    stagedDeepLinkInstall,
    setStagedDeepLinkInstall,
  } = useDeepLink({
    routes: {
      navigate,
      openDetail: handleOpenDetail,
      search: handleSearchChange,
      selectDeveloper: setSelectedDeveloper,
      focusView: (focus) => {
        if (focus === 'updates') setFocusMyAppsUpdates(true);
      },
      focusLaunchpadApp: setLaunchpadFocusId,
      openCollection: setActiveCollection,
    },
    showToast,
    t,
  });

  // 应用级订阅总线
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const resolvedLocalApps = customApps === null ? undefined : localLibrarySummaries;

  useAppSubscriptions({
    catalogLists,
    searchContext: {
      currentSearchIdRef,
      hasActiveQuery: () => Boolean(searchQueryRef.current.trim()),
    },
    localApps: resolvedLocalApps,
    library: {
      setFavoriteIds,
      setOAuthUser,
      applyPersistedSettings,
    },
    notify: { showToast, t },
  });

  // 派生选择器（纯计算）
  const {
    catalogPlatformFilteredApps,
    fullMergedCatalogApps,
    searchPlatformFilteredApps,
    platformFilteredOnlineApps,
    hasRawSearchResults,
    platformFilteredRecentApps,
    allFavoritesPoolApps,
    favoritesViewApps,
    platformFilteredFavoriteCount,
    pendingFilteredCount,
    platformCounts,
    searchPlatformCounts,
    appsById,
    stagedDeepLinkDetail,
    stagedDeepLinkSummary,
    stagedDeepLinkSha256,
  } = useAppSelectors({
    apps,
    onlineApps,
    isOnlineResults: isOnlineResultSet,
    uncatalogedExtraApps,
    selectedPlatforms,
    platformResolvedOtherIds,
    selectedApp,
    recentlyViewedApps,
    currentView,
    stagedDeepLinkInstall,
    customApps: localLibrarySummaries,
    searchQuery,
    fullCatalogApps,
    favoriteIds,
    pendingEntries: customAppEntries,
  });

  const sidebarPlatformCounts = useSidebarPlatformCounts({
    currentView,
    viewPlatformCounts: platformFilter.viewPlatformCounts,
    searchCounts: searchPlatformCounts,
    catalogCounts: platformCounts,
  });

  // 「我的应用」状态域：已装、安装/卸载、更新与规则、检查进度、无校验确认与平台过滤后的已装/更新视图
  const myApps = useMyAppsState({
    currentView,
    catalogLists,
    searchQuery,
    appsById,
    selectedPlatforms,
    platformResolvedOtherIds,
    showToast,
    t,
  });
  const {
    installedApps,
    installedIds,
    managedIds,
    managedLoaded,
    installingAppIds,
    uninstallingAppIds,
    handleInstallApp,
    handleBatchInstallApp,
    handleQuickInstall,
    handleLaunchApp,
    handleUnmanageApp,
    handleUninstallApp,
    updateRules,
    handleSkipVersion,
    handleClearRuleSkip,
    handleToggleRuleFrozen,
    handleToggleRuleHidden,
  } = myApps;

  // 安装请求收口：以选项对象承接弹窗上下文（确认无校验资产后原样重试），避免位置参数膨胀。
  const handleInstallRequest = useCallback(
    (request: InstallAppRequest) =>
      handleInstallApp(request.id, request.assetName, request.customInstallDir, request.allowUnverified),
    [handleInstallApp],
  );

  const handleClearRecentViews = () => {
    maskRecentViews(recentlyViewedApps);
    setRecentlyViewedApps([]);
    showToast(t('toast.clear_history_success'), 'info');
  };

  // 切换收藏状态（稳定回调，供 memo 卡片复用；入口归一，读写一致；批量调用可传 silent 静默并凭返回值汇总）
  // 后端 reject 时保持原态：收藏集合仅在成功后更新，失败无乐观态可回滚
  const handleToggleFavorite = useCallback(async (id: string, options?: { silent?: boolean }): Promise<boolean> => {
    const key = normalizeId(id);
    if (!key) return false;
    try {
      await tauriApi.toggleFavorite(key);
    } catch (e) {
      if (!options?.silent) {
        showToast(t('toast.favorite_failed', { error: String(e) }), 'error');
      }
      return false;
    }
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        if (!options?.silent) {
          showToast(t('toast.favorite_removed'), 'info');
        }
      } else {
        next.add(key);
        if (!options?.silent) {
          showToast(t('toast.favorite_added'), 'success');
        }
      }
      return next;
    });
    return true;
  }, [showToast, t]);

  // 扫描系统已安装的开源应用
  const handleScanSystemApps = () => {
    setIsImportModalOpen(true);
  };

  const handleImportSuccess = async (count: number) => {
    showToast(t('toast.batch_import_success', { count }), 'success');
    await myApps.refreshAfterImport();
  };

  // 镜像切换失败向上抛，由设置页统一 toast `settings.proxy_save_failed`（单点呈现，App 侧不弹）；
  // 后端以返回 false 表示拒绝生效（不抛错，如非 https / 非法域名），同样按失败处理。
  const handleSelectMirror = async (mirrorId: string) => {
    const applied = await tauriApi.switchMirror(mirrorId);
    if (!applied) {
      throw new Error(`switchMirror rejected: ${mirrorId}`);
    }
  };

  // 精选页「进入分类」：带着分类进入分类浏览；离开分类视图后清空，侧栏再进时停在大厅。
  const [categoryFocus, setCategoryFocus] = useState<string | null>(null);
  useEffect(() => {
    if (currentView !== 'categories') setCategoryFocus(null);
  }, [currentView]);
  const handleOpenCategory = (category: string) => {
    setCategoryFocus(category);
    navigate('categories');
  };
  const handleOpenAffinitySettings = () => {
    navigate('settings');
    setTimeout(() => {
      document.getElementById('settings-affinity')?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    }, 120);
  };

  const handleOpenAccountSettings = useCallback(() => {
    navigate('settings');
    setTimeout(() => {
      document.getElementById('settings-account')?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    }, 120);
  }, [navigate]);

  // 视图共享的库状态与动作：经上下文下发，视图只接收各自裁剪后的数据与专属回调。
  const visibleManagedIds = managedLoaded ? managedIds : null;
  const library = useMemo<LibraryState>(
    () => ({
      installedIds,
      installingIds: installingAppIds,
      managedIds: visibleManagedIds,
      favoriteIds,
      watchedIds,
      customIds,
      localApps: localLibrarySummaries,
      platformResolvedOtherIds,
      selectedPlatforms,
      oauthUser,
    }),
    [
      installedIds,
      installingAppIds,
      visibleManagedIds,
      favoriteIds,
      watchedIds,
      customIds,
      localLibrarySummaries,
      platformResolvedOtherIds,
      selectedPlatforms,
      oauthUser,
    ],
  );
  const appActions = useMemo<AppActions>(
    () => ({
      onOpenDetail: handleOpenDetail,
      onQuickInstall: handleQuickInstall,
      onToggleFavorite: handleToggleFavorite,
      onToggleWatch: handleToggleWatch,
      onResetPlatformFilter: platformFilter.resetPlatformFilter,
      onOpenDeveloper: setSelectedDeveloper,
      onOpenAccount: handleOpenAccountSettings,
    }),
    [
      handleOpenDetail,
      handleQuickInstall,
      handleToggleFavorite,
      handleToggleWatch,
      platformFilter.resetPlatformFilter,
      handleOpenAccountSettings,
    ],
  );

  return (
    <div className="app-window">
      {/* Frameless all-edge resize zones (Tauri-only, no-op in browser demo) */}
      <React.Suspense fallback={null}>
        <ResizeHandles />
      </React.Suspense>
      {/* 顶部标题栏 */}
      <TitleBar
        searchQuery={searchQuery}
        onSearchDraft={handleSearchDraft}
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
          onSelectView={navigate}
          updatesCount={myApps.updatableInstalledCount}
          favoritesCount={platformFilteredFavoriteCount}
          onOpenAccount={handleOpenAccountSettings}
          isCollapsed={isSidebarCollapsed}
          selectedPlatforms={selectedPlatforms}
          onTogglePlatform={platformFilter.togglePlatform}
          onResetPlatforms={platformFilter.resetPlatformFilter}
          platformCounts={sidebarPlatformCounts}
          pendingCount={pendingFilteredCount}
        />

        {/* 主内容显示区域 */}
        <AppContextProvider
          library={library}
          actions={appActions}
          reportPlatformCounts={platformFilter.reportViewPlatformCounts}
        >
          <main ref={contentRef} className="content-area">
            {currentView === 'home' && (
              // 搜索双段空态：平台未选或原始搜索命中全被平台筛空时呈带重置入口的 FilterEmptyState；
              // 否则本地段与在线段都为空时走整页空态（保留在线搜索入口）；任一段有结果即进 SearchResultsView。
              searchQuery.trim() && searchPlatformFilteredApps.length === 0 && platformFilteredOnlineApps.length === 0 ? (
                selectedPlatforms.size === 0 || (!isSearchingLocal && !isSearchingOnline && hasRawSearchResults) ? (
                  <div className="search-empty-state" style={{ marginTop: '40px', textAlign: 'center' }}>
                    <FilterEmptyState
                      icon={<Search size={40} strokeWidth={1.5} />}
                      title={t('featured.empty_title')}
                      description={t('featured.empty_desc')}
                      resetLabel={t('featured.reset_device_filter')}
                      onReset={platformFilter.resetPlatformFilter}
                    />
                  </div>
                ) : (
                  <div className="search-empty-state" style={{ marginTop: '40px', textAlign: 'center' }}>
                    <EmptyState
                      icon={<Search size={40} strokeWidth={1.5} />}
                      title={
                        isSearchingLocal || isSearchingOnline
                          ? t('search.searching_online')
                          : onlineSearchPerformed
                            ? t('search.no_online_results')
                            : t('search.no_local_results')
                      }
                      description={
                        isSearchingLocal || isSearchingOnline
                          ? t('search.searching_online_desc')
                          : onlineSearchPerformed
                            ? t('search.online_empty_desc')
                            : t('search.local_empty_online_hint')
                      }
                      action={
                        !isSearchingLocal && !isSearchingOnline && (
                          <button
                            type="button"
                            className="btn-fluent btn-primary"
                            onClick={() =>
                              handleSearchSubmit(searchQuery, { forceRefresh: onlineSearchPerformed })
                            }
                          >
                            {onlineSearchPerformed
                              ? t('search.retry_online')
                              : t('search.search_online_btn')}
                          </button>
                        )
                      }
                    />
                  </div>
                )
              ) : searchQuery.trim() ? (
                <SearchResultsView
                  apps={searchPlatformFilteredApps}
                  catalogApps={fullMergedCatalogApps}
                  searchQuery={searchQuery}
                  isOnlineResults={isOnlineResultSet}
                  onlineApps={platformFilteredOnlineApps}
                  isSearchingLocal={isSearchingLocal}
                  isSearchingOnline={isSearchingOnline}
                  onlineSearchPerformed={onlineSearchPerformed}
                  onlineHasMore={onlineHasMore}
                  isLoadingOnlineMore={isLoadingOnlineMore}
                  onOnlineLoadMore={handleOnlineLoadMore}
                  onSearchOnline={(opts) => handleSearchSubmit(searchQuery, opts)}
                />
              ) : (
                <FeaturedView
                  apps={catalogPlatformFilteredApps}
                  recentlyViewedApps={platformFilteredRecentApps}
                  onClearRecentViews={handleClearRecentViews}
                  onOpenCategory={handleOpenCategory}
                  onNavigateLatest={() => navigate('latest')}
                  onOpenAffinitySettings={handleOpenAffinitySettings}
                />
              )
            )}

            {currentView === 'trends' && (
              <TrendsView
                apps={catalogPlatformFilteredApps}
                allApps={mergedAppsForJoins}
              />
            )}

            {currentView === 'launchpad' && (
              <LaunchpadView
                focusAppId={launchpadFocusId}
                onFocusConsumed={clearLaunchpadFocus}
              />
            )}

            {currentView === 'latest' && (
              <LatestView
                apps={catalogPlatformFilteredApps}
                onNavigateCategories={() => navigate('categories')}
                allApps={fullMergedCatalogApps}
              />
            )}

            {currentView === 'categories' && (
              <CategoriesView
                apps={catalogPlatformFilteredApps}
                initialCategory={categoryFocus}
                allApps={fullMergedCatalogApps}
              />
            )}

            {currentView === 'pending' && (
              <React.Suspense fallback={null}>
                <PendingView
                  customApps={customAppsStore}
                  onNotify={(message, type) => showToast(message, type ?? 'info')}
                />
              </React.Suspense>
            )}

            {currentView === 'favorites' && (
              <FavoritesView
                apps={favoritesViewApps}
                allApps={allFavoritesPoolApps}
                onConfirmPlatformOtherIds={confirmPlatformOtherIds}
                catalogApps={mergedAppsForJoins}
                onLoadUncatalogedDetail={loadUncatalogedDetail}
                watchNotifications={watchNotifications}
                onDismissWatch={handleDismissWatchNotification}
                onEnterWatchedTab={handleEnterWatchedTab}
              />
            )}

            {currentView === 'installed' && (
              <InstalledView
                myApps={myApps}
                focusUpdates={focusMyAppsUpdates}
                onFocusConsumed={() => setFocusMyAppsUpdates(false)}
                apps={catalogPlatformFilteredApps}
                onScanSystemApps={handleScanSystemApps}
                updateRulesCount={updateRules.length + activeDismissedWatches.length}
                onOpenRules={() => setIsRulesModalOpen(true)}
              />
            )}

            {currentView === 'settings' && (
              <React.Suspense fallback={null}>
                <SettingsView
                  onSelectMirror={handleSelectMirror}
                  theme={settings.theme}
                  onSetTheme={handleSetTheme}
                  settings={settings}
                  onUpdateSetting={handleUpdateSetting}
                  installedCount={installedApps.length}
                  updateRulesCount={updateRules.length + activeDismissedWatches.length}
                  onOpenRules={() => setIsRulesModalOpen(true)}
                />
              </React.Suspense>
            )}
          </main>
        </AppContextProvider>
      </div>

      {/* 深度链接安装确认弹窗（显式用户授权门禁） */}
      {stagedDeepLinkInstall !== null && (
        <InstallConfirmDialog
          intro={t('install_confirm.deeplink_intro')}
          appName={stagedDeepLinkDetail?.name ?? stagedDeepLinkSummary?.name ?? stagedDeepLinkInstall}
          repoLine={stagedDeepLinkDetail
            ? `${stagedDeepLinkDetail.owner}/${stagedDeepLinkDetail.repo}`
            : stagedDeepLinkSummary
              ? `${stagedDeepLinkSummary.owner}/${stagedDeepLinkSummary.repo}`
              : stagedDeepLinkInstall}
          source={stagedDeepLinkDetail?.forge_host ?? stagedDeepLinkSummary?.forge_host ?? t('install_confirm.unknown_source')}
          sha256={stagedDeepLinkSha256}
          onCancel={() => {
            setStagedDeepLinkInstall(null);
            showToast(t('toast.deeplink_cancelled'), 'info');
          }}
          onConfirm={() => {
            const id = stagedDeepLinkInstall;
            setStagedDeepLinkInstall(null);
            if (id !== null) {
              void handleInstallRequest({ id });
            }
          }}
        />
      )}

      {/* 无校验资产警示弹窗（后端默认拒绝安装，仅显式确认后放行） */}
      {myApps.unverifiedInstallPrompt !== null && (
        <InstallConfirmDialog
          intro={t('install_confirm.unverified_intro')}
          appName={myApps.unverifiedInstallPrompt.id}
          repoLine={myApps.unverifiedInstallPrompt.id}
          source={t('install_confirm.unverified_source')}
          onCancel={() => {
            myApps.dismissUnverifiedInstall();
            showToast(t('toast.unverified_install_cancelled'), 'info');
          }}
          onConfirm={myApps.confirmUnverifiedInstall}
        />
      )}

      {/* 合集预览与批量安装弹窗（zstore://collection 深链唤起） */}
      {activeCollection && (
        <React.Suspense fallback={null}>
          <CollectionPreviewModal
            collection={activeCollection}
            installedIds={installedIds}
            favoriteIds={favoriteIds}
            onClose={() => setActiveCollection(null)}
            onOpenDetail={(id) => handleOpenDetail(id)}
            onLoadUncatalogedDetail={loadUncatalogedDetail}
            onInstallApp={handleBatchInstallApp}
            onToggleFavorite={(id) => handleToggleFavorite(id, { silent: true })}
            showToast={showToast}
          />
        </React.Suspense>
      )}

      {/* 应用详情弹窗 */}
      {selectedApp && (
        <React.Suspense fallback={null}>
          <AppDetailModal
            app={selectedApp}
            isInstalled={selectIsInstalled(selectedApp.id, installedIds)}
            isManaged={managedLoaded ? selectIsManaged(selectedApp.id, managedIds) : null}
            isExploreMode={currentView === 'home' || currentView === 'trends' || currentView === 'categories'}
            isFavorite={favoriteIds.has(normalizeId(selectedApp.id))}
            isWatched={watchedIds.has(normalizeId(selectedApp.id))}
            isInstallingGlobal={installingAppIds.has(normalizeId(selectedApp.id))}
            isUninstallingGlobal={uninstallingAppIds.has(normalizeId(selectedApp.id))}
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
            onOpenDetail={(detailId) => handleOpenDetail(detailId)}
          />
        </React.Suspense>
      )}

      {/* 开发者主页弹窗 */}
      {selectedDeveloper && (
        <React.Suspense fallback={null}>
          <DeveloperProfileModal
            developer={selectedDeveloper}
            isOpen
            onClose={() => setSelectedDeveloper(null)}
            onOpenAppDetail={(id) => handleOpenDetail(id)}
            onInstallApp={handleInstallApp}
            installedIds={installedIds}
            managedIds={visibleManagedIds}
          />
        </React.Suspense>
      )}

      {/* 系统已安装应用导入弹窗 */}
      {isImportModalOpen && (
        <React.Suspense fallback={null}>
          <AppImportModal
            isOpen
            onClose={() => setIsImportModalOpen(false)}
            onImportSuccess={handleImportSuccess}
          />
        </React.Suspense>
      )}

      {/* 更新规则管理弹窗 */}
      {isRulesModalOpen && (
        <React.Suspense fallback={null}>
          <RulesManagerModal
            isOpen
            onClose={() => setIsRulesModalOpen(false)}
            updateRules={updateRules}
            installedApps={installedApps}
            apps={mergedAppsForJoins}
            updatesById={myApps.allUpdatesById}
            onClearRuleSkip={handleClearRuleSkip}
            onToggleRuleFrozen={handleToggleRuleFrozen}
            onToggleRuleHidden={handleToggleRuleHidden}
            onSkipVersion={handleSkipVersion}
            dismissedWatches={activeDismissedWatches}
            onRestoreWatch={handleRestoreWatchNotification}
          />
        </React.Suspense>
      )}

      {/* 应用内通知 Toast */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
};
