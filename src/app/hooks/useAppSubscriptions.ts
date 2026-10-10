import { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type {
  AppSummary,
  InstalledApp,
  OAuthUser,
  UpdateCheckProgressPayload,
  UpdateItem,
  UpdateRule,
  ViewType,
  WatchUpdatedPayload,
} from '../../types';
import { api, DEFAULT_SETTINGS } from '../../services/api';
import { applyHit, patchAppIconList } from '../../services/iconStore';
import { preloadIcons } from '../../components/AppIcon';
import { matchPlatformSetWithPending, type PlatformId } from '../../lib/platformFilter';
import { zlogInfo } from '../../lib/z-log';
import { adoptEchoInWindow } from './useSearchState';

export interface UseAppSubscriptionsParams {
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setOnlineApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setRecentlyViewedApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setFavoriteExtraApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setInstalledApps: React.Dispatch<React.SetStateAction<InstalledApp[]>>;
  setDetectedAppIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setFavoriteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setUpdateRules: React.Dispatch<React.SetStateAction<UpdateRule[]>>;
  setWatchedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setWatchNotifications: React.Dispatch<React.SetStateAction<WatchUpdatedPayload[]>>;
  setUpdates: React.Dispatch<React.SetStateAction<UpdateItem[]>>;
  setOAuthUser: React.Dispatch<React.SetStateAction<OAuthUser | null>>;
  setIsCheckingUpdates: React.Dispatch<React.SetStateAction<boolean>>;
  setUpdateCheckProgress: React.Dispatch<React.SetStateAction<UpdateCheckProgressPayload | null>>;
  appsRef: React.MutableRefObject<AppSummary[]>;
  onlineAppsRef: React.MutableRefObject<AppSummary[]>;
  recentsRef: React.MutableRefObject<AppSummary[]>;
  favoriteExtraAppsRef: React.MutableRefObject<AppSummary[]>;
  currentSearchIdRef: React.MutableRefObject<string>;
  selectedPlatforms: Set<PlatformId>;
  platformResolvedOtherIds: Set<string>;
  applyPersistedSettings: (persisted: Record<string, string>) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
  currentView: ViewType;
  updatesCount: number;
}

interface MountCtx {
  mounted: boolean;
  cleanups: Array<() => void>;
}

function newMountCtx(): MountCtx {
  return { mounted: true, cleanups: [] };
}

function releaseMountCtx(ctx: MountCtx): void {
  ctx.mounted = false;
  for (const fn of ctx.cleanups) {
    try {
      fn();
    } catch {
      // 清理幂等，忽略二次解绑异常
    }
  }
  ctx.cleanups.length = 0;
}

/**
 * 挂载订阅守卫（C3 统一口径）：`api.onX` 一律经此登记——挂载期收 unlisten
 * 入清理表，迟到（已卸载）即时解绑，订阅失败静默吞掉。消除 4 处
 * `isMounted/unlistenFn` 重复样板，语义与原内联代码一致。
 */
function trackSubscription(ctx: MountCtx, promise: Promise<() => void>): void {
  promise.then((unlisten) => {
    if (ctx.mounted) {
      ctx.cleanups.push(unlisten);
    } else {
      try {
        unlisten();
      } catch {
        // 迟到解绑忽略异常
      }
    }
  }).catch(() => {});
}

/**
 * 应用级订阅总线（C3 自 App.tsx 抽出，原 L193-305 + L316-438，以及
 * 更新中心切签检查 L440-450 与视图切换日志 L452-464）。
 *
 * - 初始拉取 + `zstore:catalog-synced` + `zstore:icon-changed` +
 *   `onSearchIconUpgraded`（回声窗内首个回声立期望，`applyHit`  sole 写）；
 * - 关注加载 + `onWatchUpdated` 应用内提醒；
 * - 更新流：`onUpdateItemFound` 逐条跳出 + `onUpdateCheckProgress` +
 *   `onUpdateCheckFinished`；
 * - OAuth 登录态 + `onOAuthExpired` + `zstore:data-imported` 刷新。
 */
export function useAppSubscriptions({
  setApps,
  setOnlineApps,
  setRecentlyViewedApps,
  setFavoriteExtraApps,
  setInstalledApps,
  setDetectedAppIds,
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
  updatesCount,
}: UseAppSubscriptionsParams) {
  // 首挂载过滤快照：初始 recents 过滤沿用挂载时刻的选择（与原 [] effect
  // 闭包语义一致——启动时全选 + 空已确认集，恒为恒等过滤）。
  const initialFilterRef = useRef({ selectedPlatforms, platformResolvedOtherIds });
  const applyPersistedSettingsRef = useRef(applyPersistedSettings);
  applyPersistedSettingsRef.current = applyPersistedSettings;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;

  // 初始加载
  useEffect(() => {
    const initialFilter = initialFilterRef.current;
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
    api.getRecentlyViewedApps().then((recents) => setRecentlyViewedApps(recents.filter((a) => matchPlatformSetWithPending(a, initialFilter.selectedPlatforms, initialFilter.platformResolvedOtherIds)))).catch(() => {});
    api.registerDeepLinkScheme().catch(() => {});

    // 加载持久化设置
    api.getSettings().then((persisted) => {
      applyPersistedSettingsRef.current(persisted);
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
      const targetId = appId.toLowerCase();
      setApps((prevApps) => patchAppIconList(prevApps, targetId, icon));
      setOnlineApps((prev) => patchAppIconList(prev, targetId, icon));
      setRecentlyViewedApps((prevRecents) => patchAppIconList(prevRecents, targetId, icon));
      setFavoriteExtraApps((prevExtras) => patchAppIconList(prevExtras, targetId, icon));
    };
    window.addEventListener('zstore:icon-changed', handleIconChanged);

    let unlistenSearchIcons: (() => void) | null = null;
    api
      .onSearchIconUpgraded((payload) => {
        // 回调体委托 `services/iconStore.applyHit`（世代门控 + 写透守卫 +
        // 别名双写 + `invalidate→preload` 时机均在店内；此处仅做载荷适配
        // 与 React 四列表 `patch` 注入，`via`透传，`level`纯L单调）。
        const raw = (payload ?? {}) as unknown as Record<string, unknown>;
        const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        const ctx = (raw['context'] ?? null) as {
          kind: string;
          search_id?: string;
          board?: string;
          gen?: number;
        } | null;
        // 回声为唯一真源：窗内（期望空）首个搜索回声即立期望；已立期望后异 sid 由店内门控判 stale。
        const incomingKind = (ctx && typeof ctx.kind === 'string' ? ctx.kind : '').trim().toLowerCase();
        const incomingSid =
          (ctx && typeof ctx.search_id === 'string' && ctx.search_id
            ? ctx.search_id
            : asStr(raw['search_id'])) ?? '';
        adoptEchoInWindow(currentSearchIdRef, incomingKind, incomingSid);
        applyHit({
          key: asStr(raw['key']),
          id: asStr(raw['id']) ?? asStr(raw['app_id']),
          app_id: asStr(raw['app_id']),
          icon: asStr(raw['icon']),
          level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
          via: asStr(raw['via']),
          context: ctx,
          search_id: asStr(raw['search_id']),
          currentSearchId: currentSearchIdRef.current,
          getCurrentIcon: (tid) => {
            const lk = tid.toLowerCase();
            return (
              appsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              onlineAppsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              recentsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              favoriteExtraAppsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon
            );
          },
          patch: (tid, icon) => {
            setApps((prevApps) => patchAppIconList(prevApps, tid, icon));
            setOnlineApps((prev) => patchAppIconList(prev, tid, icon));
            setRecentlyViewedApps((prevRecents) => patchAppIconList(prevRecents, tid, icon));
            setFavoriteExtraApps((prevExtras) => patchAppIconList(prevExtras, tid, icon));
          },
        });
      })
      .then((unlisten) => {
        unlistenSearchIcons = unlisten;
      });

    return () => {
      window.removeEventListener('zstore:catalog-synced', handleCatalogSynced);
      window.removeEventListener('zstore:icon-changed', handleIconChanged);
      if (unlistenSearchIcons) unlistenSearchIcons();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-6.2: 加载关注列表 + 订阅 `zstore://watch-updated` 应用内提醒
  useEffect(() => {
    const ctx = newMountCtx();
    api.getWatchedApps().then((ids) => {
      if (ctx.mounted) setWatchedIds(new Set(ids));
    }).catch(() => {});
    trackSubscription(ctx, api.onWatchUpdated((payload) => {
      if (!ctx.mounted) return;
      const label = payload.app_name || payload.app_id;
      showToastRef.current(tRef.current('toast.watch_update_released', { name: label, version: payload.version }), 'info');
      setWatchNotifications((prev) => {
        const next = prev.filter((n) => n.app_id !== payload.app_id);
        return [...next, payload];
      });
    }));
    return () => {
      releaseMountCtx(ctx);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅更新项逐条跳出事件与流式进度通知（检测出一项立即跳出一项）
  useEffect(() => {
    const ctx = newMountCtx();

    trackSubscription(ctx, api.onUpdateItemFound((item) => {
      if (!ctx.mounted) return;
      setUpdates((prev) => {
        const idx = prev.findIndex((u) => u.app_id.toLowerCase() === item.app_id.toLowerCase());
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = item;
          return next;
        }
        return [...prev, item];
      });
    }));

    trackSubscription(ctx, api.onUpdateCheckProgress((payload) => {
      if (!ctx.mounted) return;
      setUpdateCheckProgress(payload);
    }));

    trackSubscription(ctx, api.onUpdateCheckFinished(() => {
      if (!ctx.mounted) return;
      setIsCheckingUpdates(false);
      setUpdateCheckProgress(null);
    }));

    return () => {
      releaseMountCtx(ctx);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-7 / FR-6.3-manual: OAuth 登录态 + 备份导入刷新
  useEffect(() => {
    const ctx = newMountCtx();
    const loadOAuthUser = () => {
      api.getOAuthUser().then((u) => {
        if (ctx.mounted) setOAuthUser(u);
      }).catch(() => {
        if (ctx.mounted) setOAuthUser(null);
      });
    };
    loadOAuthUser();
    const handleOAuthChanged = () => loadOAuthUser();
    trackSubscription(ctx, api.onOAuthExpired(() => {
      if (ctx.mounted) {
        showToastRef.current(tRef.current('toast.github_auth_expired'), 'warning');
        loadOAuthUser();
        window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
      }
    }));

    const handleDataImported = async () => {
      try {
        const [persisted, favs, watched] = await Promise.all([
          api.getSettings(),
          api.getFavorites(),
          api.getWatchedApps().catch(() => [] as string[]),
        ]);
        if (!ctx.mounted) return;
        applyPersistedSettingsRef.current(persisted);
        setFavoriteIds(new Set(favs));
        setWatchedIds(new Set(watched));
      } catch {
        // 忽略：后端未就绪时保持现状
      }
    };
    window.addEventListener('zstore:oauth-changed', handleOAuthChanged);
    window.addEventListener('zstore:data-imported', handleDataImported);
    return () => {
      releaseMountCtx(ctx);
      window.removeEventListener('zstore:oauth-changed', handleOAuthChanged);
      window.removeEventListener('zstore:data-imported', handleDataImported);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仅在用户主动进入“更新中心”标签页时才执行轻量检查（30 秒防抖冷却，避免频繁切标签重复消耗配额）
  const lastTabUpdateCheckRef = useRef<number>(0);
  useEffect(() => {
    if (currentView === 'updates' && updatesCount === 0) {
      const now = Date.now();
      if (now - lastTabUpdateCheckRef.current > 30_000) {
        lastTabUpdateCheckRef.current = now;
        api.checkForUpdates(false).then(setUpdates).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, updatesCount]);

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
}
