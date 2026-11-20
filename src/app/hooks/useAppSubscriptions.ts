import { useEffect } from 'react';
import type { TFunction } from 'i18next';
import type { AppSummary, InstalledApp, OAuthUser, ViewType } from '../../types';
import { tauriApi } from '../../services/api';
import {
  ensureIconReadySubscription,
  preloadTop30Icons,
  subscribeIconWrites,
} from '../../services/iconStore';
import { patchSearchListCacheIcon } from '../../services/search/searchListCache';
import { annotateIsCataloged, buildCatalogIdSet, prepareRecentViews, restampLocalMarks } from '../selectors';
import { adoptEchoInWindow } from './useSearchState';
import type { CatalogListsStore } from './useCatalogLists';
import { listenWindowEvent, newMountCtx, releaseMountCtx, trackSubscription, useLatestRef } from './mountCtx';

interface UseAppSubscriptionsParams {
  catalogLists: Pick<
    CatalogListsStore,
    | 'appsRef'
    | 'fullCatalogAppsRef'
    | 'setApps'
    | 'setFullCatalogApps'
    | 'setRecentlyViewedApps'
    | 'patchIcons'
    | 'findById'
  >;
  searchContext: {
    currentSearchIdRef: React.MutableRefObject<string>;
    hasActiveQuery?: () => boolean;
  };
  currentView: ViewType;
  /** 本地收录合并行（含 source/status，供最近浏览黄标叠加；仅搬标记）。 */
  localApps?: readonly AppSummary[];
  library: {
    setInstalledApps: React.Dispatch<React.SetStateAction<InstalledApp[]>>;
    setFavoriteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    setOAuthUser: React.Dispatch<React.SetStateAction<OAuthUser | null>>;
    applyPersistedSettings: (persisted: Record<string, string>) => void;
  };
  notify: {
    showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    t: TFunction;
  };
}

/** 应用级订阅总线：负责目录同步、图标写入分发、库初始快照加载及 OAuth/导入刷新。 */
export function useAppSubscriptions({
  catalogLists,
  searchContext,
  currentView,
  localApps,
  library,
  notify,
}: UseAppSubscriptionsParams) {
  const {
    appsRef,
    fullCatalogAppsRef,
    setApps,
    setFullCatalogApps,
    setRecentlyViewedApps,
    patchIcons,
    findById,
  } = catalogLists;
  const { currentSearchIdRef, hasActiveQuery } = searchContext;
  const { setInstalledApps, setFavoriteIds, setOAuthUser, applyPersistedSettings } = library;

  const applyPersistedSettingsRef = useLatestRef(applyPersistedSettings);
  const showToastRef = useLatestRef(notify.showToast);
  const tRef = useLatestRef(notify.t);
  const localAppsRef = useLatestRef(localApps);
  const hasActiveQueryRef = useLatestRef(hasActiveQuery);

  // 初始加载 + 目录同步 + 唯一 `zstore://icon-ready` 订阅
  useEffect(() => {
    const startupCtx = newMountCtx();
    let catalogLoadSeq = 0;
    const reloadCatalogApps = (restampRecents: boolean) => {
      const seq = ++catalogLoadSeq;
      tauriApi.searchApps('').then((nextApps) => {
        if (!startupCtx.mounted || seq !== catalogLoadSeq) return;
        if (!hasActiveQueryRef.current?.()) {
          setApps(nextApps);
        }
        setFullCatalogApps(nextApps);
        if (restampRecents) {
          const catalogIds = buildCatalogIdSet(nextApps);
          const currentLocal = localAppsRef.current;
          setRecentlyViewedApps((prev) => {
            if (prev.length === 0) return prev;
            let changed = false;
            const next = prev.map((r) => {
              const n = annotateIsCataloged(r, catalogIds, currentLocal);
              if (n !== r) changed = true;
              return n;
            });
            return changed ? next : prev;
          });
        }
        preloadTop30Icons(
          nextApps
            .slice(0, 30)
            .filter((a) => a.icon)
            .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon })),
        );
      });
    };

    let liveSyncReceived = false;
    const dispatchCatalogSynced = () => {
      window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
      window.dispatchEvent(new CustomEvent('zstore:custom-apps-changed'));
    };

    reloadCatalogApps(false);
    const catalogSyncedReady = tauriApi.onCatalogSynced(() => {
      if (!startupCtx.mounted) return;
      liveSyncReceived = true;
      dispatchCatalogSynced();
    });
    trackSubscription(startupCtx, catalogSyncedReady);
    catalogSyncedReady
      .then(() => (startupCtx.mounted ? tauriApi.consumeStartupCatalogSynced() : false))
      .then((pending) => {
        if (pending && startupCtx.mounted && !liveSyncReceived) {
          dispatchCatalogSynced();
        }
      })
      .catch(() => {});

    tauriApi.getInstalledApps().then(setInstalledApps);
    tauriApi.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    tauriApi
      .getRecentlyViewedApps()
      .then((recents) => {
        const withLocal = prepareRecentViews(recents, fullCatalogAppsRef.current, appsRef.current, localApps);
        setRecentlyViewedApps(withLocal);
      })
      .catch(() => {});

    tauriApi.getSettings().then((persisted) => {
      applyPersistedSettingsRef.current(persisted);
    });

    const handleCatalogSynced = () => {
      reloadCatalogApps(true);
    };
    listenWindowEvent(startupCtx, 'zstore:catalog-synced', handleCatalogSynced);

    const unsubIconWrites = subscribeIconWrites(({ targets, icon }) => {
      for (const t of targets) {
        try {
          patchSearchListCacheIcon(t, icon);
        } catch {
          // 缓存写透失败不阻塞列表
        }
        patchIcons(t, icon);
      }
    });
    startupCtx.cleanups.push(unsubIconWrites);

    startupCtx.cleanups.push(
      ensureIconReadySubscription(tauriApi.onIconReady, {
        onBeforeAdmit: (payload) => {
          const raw = (payload ?? {}) as unknown as Record<string, unknown>;
          const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
          const ctx = (raw['context'] ?? null) as {
            kind?: string;
            search_id?: string;
          } | null;
          const incomingKind = (ctx && typeof ctx.kind === 'string' ? ctx.kind : '').trim().toLowerCase();
          const incomingSid =
            (ctx && typeof ctx.search_id === 'string' && ctx.search_id
              ? ctx.search_id
              : asStr(raw['search_id'])) ?? '';
          adoptEchoInWindow(currentSearchIdRef, incomingKind, incomingSid);
        },
        getCurrentSearchId: () => currentSearchIdRef.current,
        getCurrentIcon: (tid) => findById(tid)?.icon,
      }),
    );

    return () => {
      releaseMountCtx(startupCtx);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本地收录就绪/清空后重标已渲染的最近浏览行
  useEffect(() => {
    if (!localApps) return;
    const baseCatalog =
      fullCatalogAppsRef.current.length > 0 ? fullCatalogAppsRef.current : appsRef.current;
    const catalogIds = buildCatalogIdSet(baseCatalog);
    setRecentlyViewedApps((prev) => restampLocalMarks(prev, catalogIds, localApps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localApps]);

  // OAuth 登录态 + 备份导入刷新
  useEffect(() => {
    const ctx = newMountCtx();
    const loadOAuthUser = () => {
      tauriApi
        .getOAuthUser()
        .then((u) => {
          if (ctx.mounted) setOAuthUser(u);
        })
        .catch(() => {
          if (ctx.mounted) setOAuthUser(null);
        });
    };
    loadOAuthUser();
    const handleOAuthChanged = () => {
      loadOAuthUser();
    };
    trackSubscription(
      ctx,
      tauriApi.onOAuthExpired(() => {
        if (ctx.mounted) {
          showToastRef.current(tRef.current('toast.github_auth_expired'), 'warning');
          loadOAuthUser();
          window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
        }
      }),
    );

    const handleDataImported = async () => {
      try {
        const [persisted, favs] = await Promise.all([
          tauriApi.getSettings(),
          tauriApi.getFavorites(),
        ]);
        if (!ctx.mounted) return;
        applyPersistedSettingsRef.current(persisted);
        setFavoriteIds(new Set(favs));
      } catch {
        // 忽略：后端未就绪时保持现状
      }
    };
    listenWindowEvent(ctx, 'zstore:oauth-changed', handleOAuthChanged);
    listenWindowEvent(ctx, 'zstore:data-imported', handleDataImported);
    return () => {
      releaseMountCtx(ctx);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进「我的应用」页重读已装列表（零网络）
  useEffect(() => {
    if (currentView !== 'installed') return;
    tauriApi.getInstalledApps().then(setInstalledApps).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);
}
