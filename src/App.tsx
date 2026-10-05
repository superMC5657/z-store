import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { EmptyState } from './components/EmptyState';
import { Search } from 'lucide-react';
import { AppDetail, AppDetailViewModel, AppSummary, InstalledApp, OAuthUser, UpdateItem, UpdateCheckProgressPayload, UpdateRule, ViewType, WatchUpdatedPayload } from './types';
import { api, DEFAULT_SETTINGS, ONLINE_SEARCH_PER_PAGE } from './services/api';
import { preloadIcons, invalidateIconCache, isAvatarUrl } from './components/AppIcon';
import { zlogInfo, zlogWarn } from './lib/z-log';
import { PLATFORM_IDS, PENDING_SETTLE_MS, isPlatformPending, matchPlatformSetWithPending, normalizePlatform, resolvePendingPlatformsLite, togglePlatformSet, type PlatformId } from './lib/platformFilter';
import {
  DETAIL_PLATFORMS_HEAL_EVENT,
  appSummaryFromDetail,
  detailHealKeysFor,
  evictTrendEnrichCachesForDetail,
  upsertTrendEnrichFromDetail,
  type DetailPlatformsHealPayload,
} from './services/trends';
import { useToasts } from './useToasts';
import { useAppSettings } from './useAppSettings';
import { useTranslation } from 'react-i18next';
import './i18n';

export const PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v2';
/** 5-ID 旧世界的遗留键：仅用于一次性升级读取，绝不回写。 */
const LEGACY_PLATFORM_FILTER_STORAGE_KEY = 'zstore:platform-filter:v1';
/** 旧世界 5 端 ID：遗留全选（= 展示全部意图）升级为 6 端全选，避免静默隐藏类库。 */
const LEGACY_OS_PLATFORM_IDS: readonly string[] = ['windows', 'macos', 'linux', 'ios', 'android'];

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
 *
 * v1 → v2 一次性升级：v2 缺席时读取遗留 v1 键。任何遗留 v1 集合一律补上虚拟 other
 * （发现性默认，与新用户全 6 端一致；用户可自行取消勾选）。
 * v2 集合原样沿用，绝不触碰。
 */
export function loadSelectedPlatforms(): Set<PlatformId> {
  const full = new Set<PlatformId>(PLATFORM_IDS);
  try {
    if (typeof window === 'undefined' || !window.localStorage) return full;
    const current = window.localStorage.getItem(PLATFORM_FILTER_STORAGE_KEY);
    if (current !== null) return parseSelectedPlatforms(current);
    const legacy = window.localStorage.getItem(LEGACY_PLATFORM_FILTER_STORAGE_KEY);
    if (!legacy) return full;
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacy);
    } catch {
      return full;
    }
    if (!Array.isArray(parsed)) return full;
    const migrated = parseSelectedPlatforms(JSON.stringify(parsed));
    // 旧世界 5 端 ID 全集即“展示全部”意图；子集亦补 other，保证类库默认可见。
    void LEGACY_OS_PLATFORM_IDS;
    migrated.add('other');
    return migrated;
  } catch {
    return full;
  }
}

/**
 * 深链安装确认弹窗（P0-1 显式用户授权门禁）：展示外部链接来源说明，
 * 应用名 / 仓库 / 来源 / SHA-256（若有）+ 取消 / 确认安装。
 * 文案保持既有硬编码风格。
 */
const InstallConfirmDialog: React.FC<{
  intro: string;
  appName: string;
  repoLine: string;
  source: string;
  sha256?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ intro, appName, repoLine, source, sha256, onCancel, onConfirm }) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 置顶弹窗的焦点管理：打开即聚焦自身；Tab 限制在两个按钮内循环（简易焦点陷阱）；
  // Esc 仅关闭本层（关闭时详情弹窗仍在底下，保持无感返回）。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const buttons = Array.from(dialogRef.current.querySelectorAll('button:not([disabled])'));
    if (buttons.length === 0) return;
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop modal-confirm-above" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="detail-modal"
        style={{ maxWidth: '480px', width: '92%', padding: '24px 28px', outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="确认安装"
        tabIndex={-1}
      >
        <div className="modal-header" style={{ position: 'relative', padding: 0, marginBottom: '12px' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-xl)' }}>确认安装</h2>
        </div>
        <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
          {intro}
        </p>
        <div style={{ margin: '0 0 8px', lineHeight: 1.8 }}>
          <div>
            应用：{appName}
          </div>
          <div>
            仓库：{repoLine}
          </div>
          <div>
            来源：{source}
          </div>
          {sha256 && (
            <div className="text-mono" style={{ wordBreak: 'break-all' }}>
              SHA-256：{sha256}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ borderTop: 'none', background: 'transparent', padding: '16px 0 0 0', marginTop: '16px' }}>
          <button
            className="btn-fluent btn-secondary"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="btn-fluent btn-primary"
            onClick={onConfirm}
          >
            确认安装
          </button>
        </div>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchSeqRef = useRef(0);
  const currentSearchIdRef = useRef<string>('');
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const [onlineSearchPerformed, setOnlineSearchPerformed] = useState(false);
  // 在线搜索翻页状态：提交即在线调第 1 页，触底且满页/has_more 时 page+1 追加到在线段。
  // 上下分段：apps 永远是本地结果，在线结果单独存 onlineApps（HomeView 本地在上、在线在下两段展示）。
  const [isOnlineResultSet, setIsOnlineResultSet] = useState(false);
  const [onlineApps, setOnlineApps] = useState<AppSummary[]>([]);
  const [, setOnlinePage] = useState(1);
  const [onlineHasMore, setOnlineHasMore] = useState(false);
  const [isLoadingOnlineMore, setIsLoadingOnlineMore] = useState(false);
  const onlinePageRef = useRef(1);
  const onlineHasMoreRef = useRef(false);
  const isOnlineResultSetRef = useRef(false);
  const onlineQueryRef = useRef('');
  const isLoadingOnlineMoreRef = useRef(false);
  const onlineAppsRef = useRef<AppSummary[]>([]);
  onlineAppsRef.current = onlineApps;
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
  // 任务 3（设备平台全局过滤）：App 级别多选平台状态，默认选中全部 6 种 PLATFORM_IDS（含虚拟 other），
  // 仅持久化至 localStorage——刻意不接入 api.getSettings()/UserDataBackup（仅为本地界面偏好，非备份数据）。
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(() => loadSelectedPlatforms());
  // 平台待确认追踪：summary 为空但详情尚未落定的行保持 pending（不展示 Other、不计入 other 桶、不过滤），
  // 详情取回仍为空才记入已确认 other（展示徽标、计入统计、参与过滤）。后端一律 `[]`，other 纯前端虚拟。
  const [platformResolvedOtherIds, setPlatformResolvedOtherIds] = useState<Set<string>>(() => new Set<string>());
  const platformBackfillInflightRef = useRef<Set<string>>(new Set());
  const platformResolvedOtherRef = useRef<Set<string>>(new Set());
  platformResolvedOtherRef.current = platformResolvedOtherIds;
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
  // 安装/关注集合经 ref 读取，回调引用在搜索、图标升级时保持稳定，仅语言变化时更新
  const installingRef = useRef<Set<string>>(installingAppIds);
  installingRef.current = installingAppIds;
  const watchedRef = useRef<Set<string>>(watchedIds);
  watchedRef.current = watchedIds;

  // 应用内通知（FR-6.2 关注提醒 / FR-4.4 自更新 / FR-7 OAuth / FR-6.3 导入导出经此通道呈现）
  const { toasts, showToast, handleDismissToast } = useToasts();
  const { t } = useTranslation();

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

  // 搜索 stale 守卫 + 错误回退合一：seq 过期返回 true（调用方直接 return）；
  // 否则若传入 err 则记录日志并执行 fallback，返回 false。日志内容与回退行为与原内联代码保持一致。
  const guardFreshSearch = (seq: number, err?: unknown, logPrefix?: string, fallback?: () => void): boolean => {
    if (seq !== searchSeqRef.current) return true;
    if (err !== undefined && logPrefix !== undefined) {
      zlogWarn(`${logPrefix}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      fallback?.();
    }
    return false;
  };

  // 搜索逻辑（本地内存搜索，防抖触发）
  const handleSearchChange = async (q: string) => {
    const trimmed = q.trim();
    // 同词且已是该词的在线结果集 → 保持在线结果，不回退本地。
    // （TitleBar 回车会连调 onSearchChange + onSearchSubmit；此处若清掉在线态，
    // 提交侧的同词去重守卫将失效，导致重复在线请求。）
    if (
      trimmed &&
      trimmed === searchQuery.trim() &&
      trimmed === onlineQueryRef.current &&
      isOnlineResultSetRef.current
    ) {
      return;
    }
    setSearchQuery(q);
    setOnlineSearchPerformed(false);
    // 新搜索词切回本地结果集：清掉上一轮在线翻页状态，搜索态回到首屏 20（HomeView 负责）。
    setIsOnlineResultSet(false);
    isOnlineResultSetRef.current = false;
    setOnlineApps([]);
    setOnlineHasMore(false);
    onlineHasMoreRef.current = false;
    setOnlinePage(1);
    onlinePageRef.current = 1;
    onlineQueryRef.current = '';
    setIsLoadingOnlineMore(false);
    isLoadingOnlineMoreRef.current = false;
    const seq = ++searchSeqRef.current;
    try {
      const results = await api.searchApps(q);
      if (guardFreshSearch(seq)) return;
      setApps(results);
      if (q && currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
        setCurrentView('home');
      }
    } catch (err) {
      if (guardFreshSearch(seq, err, 'searchApps error')) return;
    }
  };

  // 平台懒回填（三态）：首绘 pending 行不展示 Other 徽标、不计入 other 桶、恒可见；
  // 对可见行（前 20）经共享 `resolvePendingPlatformsLite`（分批 5）走 getPlatformsLite 轻量通道
  // 补 deduced platforms（单次 releases/latest 条件请求，无 README/图标探测/checksum 开销）；
  // 轻量取回仍为空（且非 stale 离线缓存）才记为已确认 other（单次落定更新），
  // 详情不可达或 stale 一律保持 pending 交由 settle 超时兜底，不报错。后端一律 `[]`，other 纯前端虚拟。
  // seq 过期则整批丢弃，绝不阻塞列表首绘。
  const lazyBackfillPlatforms = useCallback((summaries: AppSummary[], seq: number) => {
    const resolved = platformResolvedOtherRef.current;
    const inflight = platformBackfillInflightRef.current;
    const targets = summaries.filter((s) => {
      if (s.platforms && s.platforms.length > 0) return false;
      const key = s.id.toLowerCase();
      if (resolved.has(key) || inflight.has(key)) return false;
      return true;
    }).slice(0, 20);
    if (targets.length === 0) return;
    for (const t of targets) inflight.add(t.id.toLowerCase());
    void (async () => {
      try {
        const { patched, confirmedEmpty } = await resolvePendingPlatformsLite(
          targets.map((s) => ({ key: s.id.toLowerCase(), liteId: s.id })),
          (liteId) => api.getPlatformsLite(liteId),
          () => seq !== searchSeqRef.current,
        );
        if (seq !== searchSeqRef.current) return;
        if (patched.size > 0) {
          setApps((prev) => {
            let changed = false;
            const next = prev.map((a) => {
              const p = patched.get(a.id.toLowerCase());
              if (p && (!a.platforms || a.platforms.length === 0)) {
                changed = true;
                return { ...a, platforms: p };
              }
              return a;
            });
            return changed ? next : prev;
          });
          // 在线段同口径回填：卡片共用同一 pending 语义，在线段不闪 Other。
          setOnlineApps((prev) => {
            let changed = false;
            const next = prev.map((a) => {
              const p = patched.get(a.id.toLowerCase());
              if (p && (!a.platforms || a.platforms.length === 0)) {
                changed = true;
                return { ...a, platforms: p };
              }
              return a;
            });
            return changed ? next : prev;
          });
          setRecentlyViewedApps((prev) => {
            let changed = false;
            const next = prev.map((a) => {
              const p = patched.get(a.id.toLowerCase());
              if (p && (!a.platforms || a.platforms.length === 0)) {
                changed = true;
                return { ...a, platforms: p };
              }
              return a;
            });
            return changed ? next : prev;
          });
        }
        if (confirmedEmpty.length > 0) {
          setPlatformResolvedOtherIds((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const k of confirmedEmpty) {
              if (!next.has(k)) {
                next.add(k);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } finally {
        for (const t of targets) inflight.delete(t.id.toLowerCase());
      }
    })();
  }, []);

  // 首绘回填：本地收录（含初始全量/搜索/目录同步）的 pending 行同样走轻量确认，
  // 首绘不闪 Other，落定后单次更新。重复调用经在途/已确认集合去重。
  useEffect(() => {
    if (apps.length === 0) return;
    lazyBackfillPlatforms(apps, searchSeqRef.current);
  }, [apps, lazyBackfillPlatforms]);

  // 主列表 pending settle 超时（Home/分类/收藏共用，与 Trends 榜单同口径）：
  // lite 失败/stale 的 pending 行至多等待 PENDING_SETTLE_MS 后降级为已确认 Other
  // （徽标 + 计数 + 可过滤），而非无限 shimmer。超时前恒可见，落定后走正常 Other 过滤。
  // 治愈（具真实平台）的行永不被确认；定时器随列表/回填变化重置，落稳后一次触发。
  useEffect(() => {
    if (apps.length === 0 && onlineApps.length === 0 && recentlyViewedApps.length === 0) return;
    const pendingSnapshot: string[] = [];
    const seen = new Set<string>();
    for (const s of [...apps, ...onlineApps, ...recentlyViewedApps]) {
      if (s.platforms && s.platforms.length > 0) continue;
      const key = (s.id || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (platformResolvedOtherIds.has(key)) continue;
      pendingSnapshot.push(key);
    }
    if (pendingSnapshot.length === 0) return;
    const timer = setTimeout(() => {
      const stillPending: string[] = [];
      const currentById = new Map<string, AppSummary>();
      for (const s of [...appsRef.current, ...onlineAppsRef.current, ...recentsRef.current]) {
        const k = (s.id || '').trim().toLowerCase();
        if (k && !currentById.has(k)) currentById.set(k, s);
      }
      const resolved = platformResolvedOtherRef.current;
      for (const key of pendingSnapshot) {
        const cur = currentById.get(key);
        if (cur?.platforms && cur.platforms.length > 0) continue;
        if (resolved.has(key)) continue;
        stillPending.push(key);
      }
      if (stillPending.length === 0) return;
      setPlatformResolvedOtherIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const k of stillPending) {
          if (!next.has(k)) {
            next.add(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, PENDING_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [apps, onlineApps, recentlyViewedApps, platformResolvedOtherIds]);

  // 在线搜索提交逻辑（按回车或点击“在线搜索”按钮：即使本地有结果也发起在线搜索）
  const handleSearchSubmit = async (queryToSubmit?: string) => {
    const q = (queryToSubmit !== undefined ? queryToSubmit : searchQuery).trim();
    if (!q) return;

    // 同词且已是该词的在线结果集 → 直接返回，避免重复请求；
    // 本地结果集（isOnlineResultSet 为 false）则必须允许转在线。
    if (
      q === searchQuery.trim() &&
      q === onlineQueryRef.current &&
      isOnlineResultSetRef.current
    ) {
      return;
    }

    const seq = ++searchSeqRef.current;

    // 若本地搜索尚未完成或搜索词变更，先查一次本地并展示（异词先本地后在线）
    if (q !== searchQuery.trim()) {
      setSearchQuery(q);
      setOnlineSearchPerformed(false);
      setIsOnlineResultSet(false);
      isOnlineResultSetRef.current = false;
      setOnlineApps([]);
      setOnlineHasMore(false);
      onlineHasMoreRef.current = false;
      setOnlinePage(1);
      onlinePageRef.current = 1;
      onlineQueryRef.current = '';
      try {
        const freshLocal = await api.searchApps(q);
        if (guardFreshSearch(seq)) return;
        setApps(freshLocal);
        if (currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories') {
          setCurrentView('home');
        }
      } catch (err) {
        // 本地失败不阻塞：照常转在线（apps 保持原样，在线无结果/失败则提示）。
        if (guardFreshSearch(seq, err, 'searchApps error')) return;
      }
    }

    // 提交即在线：不再以本地零结果为 gate（第 1 页，per_page 与后端默认 12 对齐）；
    // 上下分段：本地结果保留在 apps，在线结果单独存 onlineApps（HomeView 本地在上、在线在下）。
    // 在线无结果/失败则保持本地结果 + 提示（内部分支处理）。
    {
      setIsSearchingOnline(true);
      const searchId = `search-${seq}-${Date.now()}`;
      currentSearchIdRef.current = searchId;
      try {
        const onlineResults = await api.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE);
        if (guardFreshSearch(seq)) return;
        setOnlineSearchPerformed(true);
        if (onlineResults && onlineResults.length > 0) {
          // 同词在线集去重（按 id 小写）：后端偶发重复时在线段不出现重复卡片。
          const seen = new Set<string>();
          const deduped: AppSummary[] = [];
          for (const m of onlineResults) {
            const k = (m.id || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            deduped.push(m);
          }
          setOnlineApps(deduped);
          lazyBackfillPlatforms(onlineResults, seq);
          setIsOnlineResultSet(true);
          isOnlineResultSetRef.current = true;
          setOnlinePage(1);
          onlinePageRef.current = 1;
          onlineQueryRef.current = q;
          // 满页即视为还有下一页（后端仍回数组，无 has_more 字段）；单条直查只回 1 条，天然到底。
          const hasMore = onlineResults.length >= ONLINE_SEARCH_PER_PAGE;
          setOnlineHasMore(hasMore);
          onlineHasMoreRef.current = hasMore;
          showToast(t('search.online_success', '已找到在线应用'), 'success');
        } else {
          setOnlineApps([]);
          setIsOnlineResultSet(false);
          isOnlineResultSetRef.current = false;
          setOnlineHasMore(false);
          onlineHasMoreRef.current = false;
          // 调不到或无结果就保持本地结果+提示，不报错
          showToast(t('search.online_no_results', '未找到相关在线应用，已保持本地结果'), 'info');
        }
      } catch (err) {
        if (guardFreshSearch(seq, err, 'searchAppsOnline error', () => {
          setOnlineSearchPerformed(true);
          setOnlineApps([]);
          setIsOnlineResultSet(false);
          isOnlineResultSetRef.current = false;
          setOnlineHasMore(false);
          onlineHasMoreRef.current = false;
          showToast(t('search.online_failed', '在线搜索暂不可用，已保持本地结果'), 'info');
        })) return;
      } finally {
        if (seq === searchSeqRef.current) {
          setIsSearchingOnline(false);
        }
      }
    }
  };

  // 在线结果触底翻页：后端满页/has_more 时自动要下一页（page+1），追加到在线段；
  // 限流/失败 toast 与首屏保持原样（info 级，不抛错阻塞列表）。
  const handleOnlineLoadMore = useCallback(async () => {
    if (isLoadingOnlineMoreRef.current || isSearchingOnline) return;
    if (!isOnlineResultSetRef.current || !onlineHasMoreRef.current) return;
    const q = (onlineQueryRef.current || searchQuery.trim()).trim();
    if (!q) return;
    const seq = searchSeqRef.current;
    const nextPage = onlinePageRef.current + 1;
    setIsLoadingOnlineMore(true);
    isLoadingOnlineMoreRef.current = true;
    try {
      const more = await api.searchAppsOnline(
        q,
        currentSearchIdRef.current || undefined,
        nextPage,
        ONLINE_SEARCH_PER_PAGE,
      );
      if (seq !== searchSeqRef.current) return;
      if (more && more.length > 0) {
        // 按 id 去重后追加到在线段（跳过在线段已有项；本地段不动）。
        setOnlineApps((prev) => {
          const seen = new Set(prev.map((a) => (a.id || '').toLowerCase()));
          const fresh: AppSummary[] = [];
          for (const m of more) {
            const k = (m.id || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            fresh.push(m);
          }
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        lazyBackfillPlatforms(more, seq);
        const hasMore = more.length >= ONLINE_SEARCH_PER_PAGE;
        setOnlinePage(nextPage);
        onlinePageRef.current = nextPage;
        setOnlineHasMore(hasMore);
        onlineHasMoreRef.current = hasMore;
      } else {
        setOnlineHasMore(false);
        onlineHasMoreRef.current = false;
      }
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      zlogWarn(`searchAppsOnline more error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      showToast(t('search.online_failed', '在线搜索暂不可用，已保持本地结果'), 'info');
    } finally {
      if (seq === searchSeqRef.current) {
        setIsLoadingOnlineMore(false);
        isLoadingOnlineMoreRef.current = false;
      }
    }
  }, [isSearchingOnline, searchQuery, showToast, t, lazyBackfillPlatforms]);

  const loadRecentViews = useCallback(async () => {
    try {
      const recents = await api.getRecentlyViewedApps();
      setRecentlyViewedApps(recents);
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
    appDetailMemoryCache.current.set(idClean, detail);
    if (detail.id.toLowerCase() !== idClean) {
      appDetailMemoryCache.current.set(detail.id.toLowerCase(), detail);
    }
    if (detail.owner && detail.repo) {
      const repoLower = `${detail.owner}/${detail.repo}`.toLowerCase();
      appDetailMemoryCache.current.set(repoLower, detail);
      appDetailMemoryCache.current.set(`github.com/${repoLower}`, detail);
    }

    if (activeDetailIdRef.current?.toLowerCase() === detail.id.toLowerCase() || activeDetailIdRef.current?.toLowerCase() === idClean) {
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
      if (
        app.stars === detail.stars &&
        app.forks === detail.forks &&
        app.latest_version === detail.latest_version &&
        app.icon === nextIcon &&
        app.platforms === nextPlatforms
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
    setApps(patchList);
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

    if (patchedIcon) {
      invalidateIconCache(idClean);
      window.dispatchEvent(
        new CustomEvent('zstore:icon-changed', {
          detail: { appId: idClean, icon: patchedIcon },
        })
      );
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
      recentsRef.current.find((a) => a.id.toLowerCase() === idClean);

    const selectedSnapshot = selectedAppRef.current;
    const initialDetail: AppDetailViewModel = selectedSnapshot && selectedSnapshot.id.toLowerCase() === idClean && forceRefresh
      ? { ...selectedSnapshot, isLoading: false, isRefreshing: true, loadError: undefined }
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
          platforms: [],
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
  }, [loadRecentViews, syncDetailCacheAndAppLists]);

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
        showToast(t('toast.deeplink_confirm_notice', { id: action.payload.app_id }), 'warning');
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
      showToast(t('toast.deeplink_responded', { url: rawUrl }), 'info');
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

  // 安装应用（稳定回调：经 ref 读 installing，搜索键入/图标升级时引用不变）
  const handleInstallApp = useCallback(async (id: string, assetName?: string, customInstallDir?: string): Promise<void> => {
    if (installingRef.current.has(id)) return;
    zlogInfo(`click install id=${id} asset=${assetName || 'auto'}`);
    setInstallingAppIds((prev) => new Set(prev).add(id));
    try {
      const installed = await api.installApp(id, assetName, customInstallDir);
      setInstalledApps((prev) => [...prev.filter((a) => a.app_id.toLowerCase() !== id.toLowerCase()), installed]);
      setDetectedAppIds((prev) => new Set(prev).add(id).add(id.toLowerCase()));
      showToast(t('toast.install_success', { name: installed.app_name }), 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('1602')) {
        showToast(t('toast.install_cancelled', { error: errStr }), 'info');
      } else {
        showToast(t('toast.install_failed', { error: errStr }), 'error');
      }
      throw err;
    } finally {
      setInstallingAppIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [showToast, t]);

  // 快捷安装（稳定回调，供 memo 卡片复用）
  const handleQuickInstall = useCallback(async (id: string) => {
    await handleInstallApp(id);
  }, [handleInstallApp]);

  // 启动应用
  const handleLaunchApp = async (id: string) => {
    zlogInfo(`click launch id=${id}`);
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app ? app.app_name : id;
    try {
      await api.launchApp(id);
      showToast(t('toast.launch_success', { name: appName }), 'success');
    } catch (err) {
      showToast(t('toast.launch_failed', { error: String(err) }), 'error');
    }
  };

  // 取消管理应用（从 Z-Store 列表中移除，保留本地文件完好）
  const handleUnmanageApp = async (id: string) => {
    const app = installedApps.find((a) => a.app_id === id);
    const appName = app?.app_name || id;
    await api.unmanageApp(id);
    setInstalledApps((prev) => prev.filter((a) => a.app_id !== id));
    showToast(t('toast.unmanage_success', { name: appName }), 'info');
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
      showToast(t('toast.refresh_installed_success'), 'success');
    } catch (err) {
      showToast(t('toast.refresh_installed_failed', { error: String(err) }), 'error');
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
      showToast(t('toast.import_success'), 'success');
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
      showToast(t('toast.uninstall_success', { name: appName }), 'success');
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('取消') || errStr.includes('中止') || errStr.includes('保留') || errStr.includes('1602')) {
        showToast(t('toast.uninstall_cancelled'), 'info');
      } else {
        showToast(t('toast.uninstall_failed', { error: errStr }), 'error');
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
