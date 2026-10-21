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
import { tauriApi, DEFAULT_SETTINGS } from '../../services/api';
import { MANUAL_ONLY_NETWORK } from '../../lib/manualOnly';
import {
  admitIconHit,
  patchAppIconList,
  preloadTop30Icons,
} from '../../services/iconStore';
import { matchPlatformSetWithLoading } from '../../lib/platformFilter';
import { annotateIsCataloged, buildCatalogIdSet, restampLocalMarks } from '../selectors';
import { type PlatformId } from '../../lib/platformFilter';
import { zlogInfo } from '../../lib/z-log';
import { adoptEchoInWindow } from './useSearchState';

interface UseAppSubscriptionsParams {
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setOnlineApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setRecentlyViewedApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setUncatalogedExtraApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setInstalledApps: React.Dispatch<React.SetStateAction<InstalledApp[]>>;
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
  uncatalogedExtraAppsRef: React.MutableRefObject<AppSummary[]>;
  currentSearchIdRef: React.MutableRefObject<string>;
  selectedPlatforms: Set<PlatformId>;
  platformResolvedOtherIds: Set<string>;
  applyPersistedSettings: (persisted: Record<string, string>) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
  currentView: ViewType;
  updatesCount: number;
  /** 本地收录合并行（含 source/status，供最近浏览黄标叠加；仅搬标记）。 */
  localApps?: readonly AppSummary[];
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
 * 挂载订阅守卫（C3 统一口径）：`tauriApi.onX` 一律经此登记——挂载期收 unlisten
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
 * - 初始拉取 + `zstore:catalog-synced` +
 *   `onIconReady`（回声窗内首个回声立期望，`admitIconHit` sole 写；双订阅正交门控，
 *   此处不做 kind 硬过滤，search/trend 经店内世代门控正交判定，图标全局共享）；
 * - 关注加载 + `onWatchUpdated` 应用内提醒；
 * - 更新流：`onUpdateItemFound` 逐条跳出 + `onUpdateCheckProgress` +
 *   `onUpdateCheckFinished`；
 * - OAuth 登录态 + `onOAuthExpired` + `zstore:data-imported` 刷新。
 */
export function useAppSubscriptions({
  setApps,
  setOnlineApps,
  setRecentlyViewedApps,
  setUncatalogedExtraApps,
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
  uncatalogedExtraAppsRef,
  currentSearchIdRef,
  selectedPlatforms,
  platformResolvedOtherIds,
  applyPersistedSettings,
  showToast,
  t,
  currentView,
  // 更新徽标计数由调用方持有；更新 tab 在本总线内只读 DB 快照。
  updatesCount: _updatesCount,
  localApps,
}: UseAppSubscriptionsParams) {
  // 首挂载过滤快照：初始 recents 过滤沿用挂载时刻的选择
  // （启动时全选 + 空已确认集，恒为恒等过滤）。
  const initialFilterRef = useRef({ selectedPlatforms, platformResolvedOtherIds });
  const applyPersistedSettingsRef = useRef(applyPersistedSettings);
  applyPersistedSettingsRef.current = applyPersistedSettings;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;
  // 本地收录就绪后重标最近浏览（首刷 customApps null→[] 时首渲染无标，加载后补标；不改排序/去重，仅搬标记）。
  const localAppsRef = useRef(localApps);
  localAppsRef.current = localApps;

  // 初始加载
  useEffect(() => {
    const initialFilter = initialFilterRef.current;
    // 初始数据拉取（DB/local 直读，保持自动）
    tauriApi.searchApps('').then((loadedApps) => {
      setApps(loadedApps);
      // 预解码热门应用图标，若本地配置目录已缓存则秒读，未缓存则后台下载并缓存
      preloadTop30Icons(
        loadedApps
          .slice(0, 30)
          .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon }))
      );
    });
    tauriApi.getInstalledApps().then(setInstalledApps);
    tauriApi.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    tauriApi.getUpdateRules().then(setUpdateRules);
    // 更新中心首屏读 DB 快照（get_cached_updates，零网络；空快照即空列表，等手动 Refresh）。
    tauriApi.getCachedUpdates().then((rows) => {
      if (Array.isArray(rows)) setUpdates(rows);
    }).catch(() => {});
    tauriApi.getRecentlyViewedApps().then((recents) => {
      // 最近浏览黄标：后端无 source/status，此处叠加本地标记（蓝优先），再按平台过滤。
      const catalogIds = buildCatalogIdSet(appsRef.current);
      const withLocal = recents.map((r) => annotateIsCataloged(r, catalogIds, localApps));
      setRecentlyViewedApps(
        withLocal.filter((a) =>
          matchPlatformSetWithLoading(a, initialFilter.selectedPlatforms, initialFilter.platformResolvedOtherIds),
        ),
      );
    }).catch(() => {});
    tauriApi.registerDeepLinkScheme().catch(() => {});

    // 加载持久化设置（DB/local，保持自动；更新检查仅手动触发检查更新按钮）
    tauriApi.getSettings().then((persisted) => {
      applyPersistedSettingsRef.current(persisted);
      // 更新中心属资产区：启动时不自动检查（忽略 update_frequency startup 自动项）；
      // 用户经更新中心检查更新按钮手动触发。
      if (MANUAL_ONLY_NETWORK) return;
      // 仅启动时自动检查更新——`daily`（每日）更新频率选项目前在“设置”中刻意禁用（未开发功能，暂无调度器），
      // 因此此处仅对 `startup`（启动时）触发自动检查；`daily`/`manual` 用户可通过“更新中心”标签页手动检查。
      if ((persisted.update_frequency || DEFAULT_SETTINGS.update_frequency) === 'startup') {
        tauriApi.checkForUpdates(false).then(setUpdates).catch(() => {});
      }
    });

    const handleCatalogSynced = () => {
      tauriApi.searchApps('').then((updatedApps) => {
        setApps(updatedApps);
        // 目录后到即重标最近浏览（蓝优先、不改排序；图标经店内写口，不在此拉取）。
        const currentLocal = localAppsRef.current;
        if (currentLocal && currentLocal.length > 0) {
          const catalogIds = buildCatalogIdSet(updatedApps);
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
          updatedApps
            .slice(0, 30)
            .filter((a) => a.icon)
            .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon }))
        );
      });
    };
    window.addEventListener('zstore:catalog-synced', handleCatalogSynced);

    let unlistenSearchIcons: (() => void) | null = null;
    tauriApi
      .onIconReady((payload) => {
        // 回调体委托 `services/iconStore.admitIconHit`（世代门控 + 写透守卫 +
        // 别名双写 + `invalidate→queue` 时机均在店内；此处仅做载荷适配
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
        admitIconHit({
          id: asStr(raw['id']),
          icon: asStr(raw['icon']),
          level: typeof raw['level'] === 'number' ? (raw['level'] as number) : undefined,
          via: asStr(raw['via']),
          context: ctx,
          currentSearchId: currentSearchIdRef.current,
          getCurrentIcon: (tid) => {
            const lk = tid.toLowerCase();
            return (
              appsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              onlineAppsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              recentsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon ??
              uncatalogedExtraAppsRef.current.find((a) => a.id.toLowerCase() === lk)?.icon
            );
          },
          patch: (tid, icon) => {
            setApps((prevApps) => patchAppIconList(prevApps, tid, icon));
            setOnlineApps((prev) => patchAppIconList(prev, tid, icon));
            setRecentlyViewedApps((prevRecents) => patchAppIconList(prevRecents, tid, icon));
            setUncatalogedExtraApps((prevExtras) => patchAppIconList(prevExtras, tid, icon));
          },
        });
      })
      .then((unlisten) => {
        unlistenSearchIcons = unlisten;
      });

    return () => {
      window.removeEventListener('zstore:catalog-synced', handleCatalogSynced);
      if (unlistenSearchIcons) unlistenSearchIcons();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本地收录就绪/清空后重标已渲染的最近浏览行：
  // undefined（customApps 未加载）原样透传；空集合即「确知无收录」，须清掉退回/删除后的陈旧黄标。
  useEffect(() => {
    if (!localApps) return;
    const catalogIds = buildCatalogIdSet(appsRef.current);
    setRecentlyViewedApps((prev) => restampLocalMarks(prev, catalogIds, localApps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localApps]);

  // FR-6.2: 加载关注列表 + 订阅 `zstore://watch-updated` 应用内提醒
  useEffect(() => {
    const ctx = newMountCtx();
    tauriApi.getWatchedApps().then((entries) => {
      if (ctx.mounted) {
        const ids = (Array.isArray(entries) ? entries : []).map((e) => e.app_id);
        setWatchedIds(new Set(ids));
      }
    }).catch(() => {});
    trackSubscription(ctx, tauriApi.onWatchUpdated((payload) => {
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

    trackSubscription(ctx, tauriApi.onUpdateItemFound((item) => {
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

    trackSubscription(ctx, tauriApi.onUpdateCheckProgress((payload) => {
      if (!ctx.mounted) return;
      setUpdateCheckProgress(payload);
    }));

    trackSubscription(ctx, tauriApi.onUpdateCheckFinished(() => {
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
      tauriApi.getOAuthUser().then((u) => {
        if (ctx.mounted) setOAuthUser(u);
      }).catch(() => {
        if (ctx.mounted) setOAuthUser(null);
      });
    };
    loadOAuthUser();
    const handleOAuthChanged = () => {
      loadOAuthUser();
      // 登录态切换后更新中心读 DB 快照（零网络；写仅手动 Refresh）。
      tauriApi.getCachedUpdates().then((rows) => {
        if (ctx.mounted && Array.isArray(rows)) setUpdates(rows);
      }).catch(() => {});
    };
    trackSubscription(ctx, tauriApi.onOAuthExpired(() => {
      if (ctx.mounted) {
        showToastRef.current(tRef.current('toast.github_auth_expired'), 'warning');
        loadOAuthUser();
        window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
      }
    }));

    const handleDataImported = async () => {
      try {
        const [persisted, favs, watchedEntries] = await Promise.all([
          tauriApi.getSettings(),
          tauriApi.getFavorites(),
          tauriApi.getWatchedApps().catch(() => [] as { app_id: string }[]),
        ]);
        if (!ctx.mounted) return;
        applyPersistedSettingsRef.current(persisted);
        setFavoriteIds(new Set(favs));
        const watchedIds = (Array.isArray(watchedEntries) ? watchedEntries : []).map((w) => w.app_id);
        setWatchedIds(new Set(watchedIds));
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

  // 更新中心属资产区：进 tab 只读 DB 快照（getCachedUpdates，零网络），不自动检查更新。
  // 网络仅经检查更新按钮手动触发（handleCheckUpdates：force 写库后重读快照）；进度监听保持被动。
  useEffect(() => {
    if (currentView !== 'updates') return;
    tauriApi.getCachedUpdates().then((rows) => {
      if (Array.isArray(rows)) setUpdates(rows);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  const isFirstViewRender = useRef(true);
  const prevViewRef = useRef<ViewType>('home');
  useEffect(() => {
    if (isFirstViewRender.current) {
      isFirstViewRender.current = false;
      prevViewRef.current = currentView;
      return;
    }
    // 视图切换永带 from + params（杜绝裸 switch），sid 由 z-log 自动关联行为链。
    const from = prevViewRef.current;
    prevViewRef.current = currentView;
    zlogInfo(`switch view='${currentView}' from='${from}' params={}`);
  }, [currentView]);
}
