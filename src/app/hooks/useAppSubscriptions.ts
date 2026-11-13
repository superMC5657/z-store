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
import { tauriApi } from '../../services/api';
import {
  admitIconHit,
  patchAppIconList,
  preloadTop30Icons,
  subscribeIconWrites,
} from '../../services/iconStore';
import { patchSearchListCacheIcon } from '../../services/search/searchListCache';
import { annotateIsCataloged, buildCatalogIdSet, prepareRecentViews, restampLocalMarks } from '../selectors';
import { type PlatformId } from '../../lib/platformFilter';
import { adoptEchoInWindow } from './useSearchState';

interface UseAppSubscriptionsParams {
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setFullCatalogApps?: React.Dispatch<React.SetStateAction<AppSummary[]>>;
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
  fullCatalogAppsRef?: React.MutableRefObject<AppSummary[]>;
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
 * 进入「我的应用」读更新快照与视图切换日志，见文件末尾两个 effect）。
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
  setFullCatalogApps,
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
  fullCatalogAppsRef,
  onlineAppsRef,
  recentsRef,
  uncatalogedExtraAppsRef,
  currentSearchIdRef,
  selectedPlatforms: _selectedPlatforms,
  platformResolvedOtherIds: _platformResolvedOtherIds,
  applyPersistedSettings,
  showToast,
  t,
  currentView,
  // 更新徽标计数由调用方持有；更新 tab 在本总线内只读 DB 快照。
  updatesCount: _updatesCount,
  localApps,
}: UseAppSubscriptionsParams) {
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
    const startupCtx = newMountCtx();
    // 单调代际计数：防止初始 searchApps('') 晚于 zstore:catalog-synced 返回时用旧列表覆盖新目录。
    let catalogLoadSeq = 0;
    const reloadCatalogApps = (restampRecents: boolean) => {
      const seq = ++catalogLoadSeq;
      tauriApi.searchApps('').then((nextApps) => {
        if (!startupCtx.mounted || seq !== catalogLoadSeq) return;
        setApps(nextApps);
        setFullCatalogApps?.(nextApps);
        if (restampRecents) {
          // 目录后到即重标最近浏览（蓝优先、不改排序；无论 localApps 为空[]还是非空均校准转正/收录态）。
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
        // 预解码热门应用图标，若本地配置目录已缓存则秒读，未缓存则后台下载并缓存
        preloadTop30Icons(
          nextApps
            .slice(0, 30)
            .filter((a) => a.icon)
            .map((a) => ({ id: a.id, owner: a.owner, repo: a.repo, icon: a.icon }))
        );
      });
    };

    // 初始数据拉取（DB/local 直读，保持自动）
    reloadCatalogApps(false);
    // 启动后台按北京时间下午 14:00（06:00 UTC）切日静默增量同步远端收录清单：同周期内跳过网络，跨边界后走 ETag 条件请求，有更新才覆盖 catalog_apps 并通知视图刷新
    tauriApi.syncCatalog(false).then((res) => {
      if (!startupCtx.mounted) return;
      if (res?.updated) {
        window.dispatchEvent(new CustomEvent('zstore:catalog-synced'));
        window.dispatchEvent(new CustomEvent('zstore:custom-apps-changed'));
      }
    }).catch(() => {
      // 启动静默同步失败（如离线/超时）不提示错误，保留本地 catalog_apps 既有数据
    });
    tauriApi.getInstalledApps().then(setInstalledApps);
    tauriApi.getFavorites().then((favs) => setFavoriteIds(new Set(favs)));
    tauriApi.getUpdateRules().then(setUpdateRules);
    // 可用更新首屏读 DB 快照（get_cached_updates，零网络；空快照即空列表，等手动检查更新）。
    tauriApi.getCachedUpdates().then((rows) => {
      if (Array.isArray(rows)) setUpdates(rows);
    }).catch(() => {});
    tauriApi.getRecentlyViewedApps().then((recents) => {
      // 最近浏览黄标：后端无 source/status，此处叠加遮罩与本地标记（蓝优先）；平台过滤由 selectors 动态派生。
      const withLocal = prepareRecentViews(recents, fullCatalogAppsRef?.current, appsRef.current, localApps);
      setRecentlyViewedApps(withLocal);
    }).catch(() => {});
    tauriApi.registerDeepLinkScheme().catch(() => {});

    // 加载持久化设置（DB/local，保持自动；更新检查仅手动触发检查更新按钮）
    tauriApi.getSettings().then((persisted) => {
      applyPersistedSettingsRef.current(persisted);
      // 「我的应用」属资产区：启动时不自动检查（忽略 update_frequency startup 自动项）；
      // 用户经「我的应用」顶栏的检查更新按钮手动触发。
    });

    const handleCatalogSynced = () => {
      reloadCatalogApps(true);
    };
    window.addEventListener('zstore:catalog-synced', handleCatalogSynced);

    const listSetters = [
      setApps,
      setOnlineApps,
      setRecentlyViewedApps,
      setUncatalogedExtraApps,
    ];
    const unsubIconWrites = subscribeIconWrites(({ targets, icon }) => {
      // 05 翻页一致性：图标就绪同时写透搜索列表缓存行与四列表状态。
      for (const t of targets) {
        try {
          patchSearchListCacheIcon(t, icon);
        } catch {
          // 缓存写透失败不阻塞列表
        }
        for (const setter of listSetters) {
          try {
            setter((prev) => patchAppIconList(prev, t, icon));
          } catch {
            // 单列表失败不阻塞其余
          }
        }
      }
    });

    let unlistenSearchIcons: (() => void) | null = null;
    tauriApi
      .onIconReady((payload) => {
        // 回调体委托 `services/iconStore.admitIconHit`（世代门控 + 写透守卫 +
        // 别名双写 + `invalidate→queue` 时机均在店内；四列表更新统一由上方
        // `subscribeIconWrites` 单点扇出，避免重复 setState）。
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
        });
      })
      .then((unlisten) => {
        unlistenSearchIcons = unlisten;
      });

    return () => {
      releaseMountCtx(startupCtx);
      window.removeEventListener('zstore:catalog-synced', handleCatalogSynced);
      unsubIconWrites();
      if (unlistenSearchIcons) unlistenSearchIcons();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本地收录就绪/清空后重标已渲染的最近浏览行：
  // undefined（customApps 未加载）原样透传；空集合即「确知无收录」，须清掉退回/删除后的陈旧黄标。
  useEffect(() => {
    if (!localApps) return;
    const baseCatalog =
      fullCatalogAppsRef?.current && fullCatalogAppsRef.current.length > 0
        ? fullCatalogAppsRef.current
        : appsRef.current;
    const catalogIds = buildCatalogIdSet(baseCatalog);
    setRecentlyViewedApps((prev) => restampLocalMarks(prev, catalogIds, localApps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localApps]);

  // 加载关注列表与持久化的待处理提醒 + 订阅 `zstore://watch-updated` 实时提醒
  useEffect(() => {
    const ctx = newMountCtx();
    tauriApi.getWatchedApps().then((entries) => {
      if (ctx.mounted) {
        const ids = (Array.isArray(entries) ? entries : []).map((e) => e.app_id);
        setWatchedIds(new Set(ids));
      }
    }).catch(() => {});
    tauriApi.getWatchNotifications().then((pending) => {
      if (!ctx.mounted || !Array.isArray(pending)) return;
      // 读回期间已到达的实时提醒优先（同应用取较新的一条）
      setWatchNotifications((prev) => {
        const live = new Set(prev.map((n) => n.app_id));
        return [...prev, ...pending.filter((n) => !live.has(n.app_id))];
      });
    }).catch(() => {});
    trackSubscription(ctx, tauriApi.onWatchUpdated((payload) => {
      if (!ctx.mounted) return;
      const label = payload.app_name || payload.app_id;
      showToastRef.current(tRef.current('toast.watch_update_released', { name: label, version: payload.version }), 'info');
      setWatchNotifications((prev) => [payload, ...prev.filter((n) => n.app_id !== payload.app_id)]);
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

  // OAuth 登录态 + 备份导入刷新
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
      // 登录态切换后重读可用更新 DB 快照（零网络；写仅手动检查更新）。
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

  // 「我的应用」属资产区：进页重读已装列表（含系统导入应用的本地版本更正）与更新 DB 快照，
  // 零网络，不自动检查更新。网络仅经检查更新按钮手动触发（handleCheckUpdates：force 写库后重读快照）。
  useEffect(() => {
    if (currentView !== 'installed') return;
    tauriApi.getInstalledApps().then(setInstalledApps).catch(() => {});
    tauriApi.getCachedUpdates().then((rows) => {
      if (Array.isArray(rows)) setUpdates(rows);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);
}
