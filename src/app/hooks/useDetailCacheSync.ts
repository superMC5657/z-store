import { useCallback, useRef } from 'react';
import type { AppDetail, AppDetailViewModel, AppSummary } from '../../types';
import { api } from '../../services/api';
import { applyHit, getBufferedIcon, patchAppIconList } from '../../services/iconStore';
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
} from '../../services/trends';

export interface UseDetailCacheSyncParams {
  selectedApp: AppDetailViewModel | null;
  appsRef: React.MutableRefObject<AppSummary[]>;
  onlineAppsRef: React.MutableRefObject<AppSummary[]>;
  recentsRef: React.MutableRefObject<AppSummary[]>;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setOnlineApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setRecentlyViewedApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setFavoriteExtraApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setSelectedApp: React.Dispatch<React.SetStateAction<AppDetailViewModel | null>>;
  setPlatformResolvedOtherIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * 详情快照缓存与卡片列表同步（C3 自 App.tsx 抽出，原 L489-1046）。
 *
 * - 内存快照 0ms 秒开 + 后台 ETag 条件探查静默更新；
 * - 后端占位简介永不污染内存快照/列表（富卡非占位兜底，无富卡即存 ''/保留旧值）；
 * - stale 离线详情不碰平台（不确认、不治愈、不碰榜单缓存）；
 * - 图标回填唯一经店内 `applyHit`（`invalidate→preload→patch` 写透四列表，不走窗口总线；data: 永不进盘）。
 */
function pickRealDescription(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '' || isPlaceholderDescription(t)) return undefined;
  return v;
}

export function useDetailCacheSync({
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
}: UseDetailCacheSyncParams) {
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());
  const activeDetailIdRef = useRef<string | null>(null);
  const selectedAppRef = useRef<AppDetailViewModel | null>(null);
  selectedAppRef.current = selectedApp;

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
              const cand = pickRealDescription(hit.description);
              if (cand !== undefined) enrichDesc = cand;
            }
            if (needDescEn && enrichDescEn === undefined) {
              const candEn = pickRealDescription(hit.description_en);
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
  }, [setRecentlyViewedApps]);

  // 同步详情快照缓存与卡片列表数据（消除后台条件探查与主动刷新之间的重复逻辑）
  // 列表 patch 仅在目标命中且字段确变时生成新对象并返回新数组，否则原引用返回，避免无谓全网格重渲染
  const syncDetailCacheAndAppLists = useCallback((idClean: string, detail: AppDetail, isBackgroundSilent = false) => {
    // F1：后端占位简介不污染内存快照——先算富卡兜底，落盘即存治愈值，
    // 后续 handleOpenDetail 命中缓存直接展现实简介，不再闪占位。
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

    const rawDetailIcon = typeof detail.icon === 'string' ? detail.icon.trim() : '';
    // patchedIcon 先分流 data:：data: 仅即时看（Header 经 iconOverride 直显），永不进 patch/applyHit/盘；
    // 列表回填只用转正 http，data:/空一律按缺席走 cycle 兜底（L5 显式空除外，经 cycle level 5 显式写）。
    const patchedIcon =
      rawDetailIcon !== '' && !rawDetailIcon.startsWith('data:') ? rawDetailIcon : undefined;
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
    // 双键（idClean + detail.id，大小写不敏感）：与 patchSummary 同目标口径，覆盖两者不一致
    // 图标写口唯一经店内 `applyHit`（写透四列表 + 文件预热 + M1 缓冲，不走窗口总线）。
    const iconPatch = (tid: string, icon: string): void => {
      setApps((prev) => patchAppIconList(prev, tid, icon));
      setOnlineApps((prev) => patchAppIconList(prev, tid, icon));
      setRecentlyViewedApps((prev) => patchAppIconList(prev, tid, icon));
      setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
    };
    setApps(patchList);
    // 在线段与本地段上下分段展示：详情回填直接落盘 onlineApps（店内 `applyHit` 写透，不走窗口总线）
    setOnlineApps(patchList);
    setRecentlyViewedApps(patchList);
    // 收藏占位行同步治愈：`favoriteIds ∖ apps` 合成行也在详情回填口径内（标记保持不动）
    setFavoriteExtraApps(patchList);
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
      // detail.id 与 idClean 不一致时的双键兜底
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
      // 详情实图：经店内唯一写口（buffer + 文件预热 + 四列表写透）。
      // patchedIcon 已剥 data:（上分流），此处恒为转正 http，直送安全。
      applyHit({ key: idClean, id: idClean, icon: patchedIcon, patch: iconPatch });
    } else {
      // 卡有 http 实图 + M1 命中即跳过 getAppIconCycle（省 IPC，所见即存）：
      // 列表已有转正 http 直接画，缓冲已有实图首绘即对；仅双空才走 cycle 兜底。
      // data: 不触发此处（已分流，Header 经 iconOverride 即时看）。
      // 安全说明：每次进详情 Header 必挂载并无条件调 getAppIconCycle（Header.tsx），
      // 同一结果经店内唯一写口扇出到四列表，故此处跳过只是省掉重复 IPC，不丢加载。
      const bufferedHit = getBufferedIcon(idClean);
      if (typeof bufferedHit === 'string' && bufferedHit.trim() !== '') {
        return;
      }
      const cardIcon =
        appsRef.current.find((a) => a.id.toLowerCase() === idClean)?.icon ??
        onlineAppsRef.current.find((a) => a.id.toLowerCase() === idClean)?.icon ??
        recentsRef.current.find((a) => a.id.toLowerCase() === idClean)?.icon;
      if (
        typeof cardIcon === 'string' &&
        (cardIcon.trim().startsWith('http://') || cardIcon.trim().startsWith('https://'))
      ) {
        return;
      }
      // detail.icon 为空：详情弹窗靠 Header 轮换态照常显示，列表三段用 iconCycle.url 经店内写口回填落盘。
      void api.getAppIconCycle(idClean).then((cycle) => {
        // 双落盘口径：url=data: 即时态（IPC临时、永不进盘），remote_url/remoteUrl=可持久化 URL；
        // 落盘/回填一律用 persistUrl（remote优先，url非data:才兜底，否则空即 L5/空不发）。
        const remote = typeof (cycle?.remote_url ?? cycle?.remoteUrl) === 'string'
          ? String(cycle?.remote_url ?? cycle?.remoteUrl).trim()
          : '';
        const fallbackUrl = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
        const persistUrl = remote !== '' ? remote : (!fallbackUrl.startsWith('data:') ? fallbackUrl : '');
        if(!persistUrl){
          // L5/空：显式徽章走唯一写口（`level:5` 显式才扇出列表/镜像；
          // cycle 空但非 L5 时按下 `applyHit` 空守卫自然丢弃，保持占位）。
          const emptyLevel = typeof cycle?.level === 'number' && cycle.level === 5 ? 5 : undefined;
          if (emptyLevel === 5) {
            applyHit({ key: idClean, id: idClean, icon: '', level: 5, patch: iconPatch });
          }
          return;
        }
        const cycleLevel = typeof cycle?.level === 'number' ? cycle.level : undefined;
        applyHit({ key: idClean, id: idClean, icon: persistUrl, level: cycleLevel, patch: iconPatch });
      }).catch(() => {
        // 取不到轮换图标则保持占位，不阻塞
      });
    }
  }, [appsRef, onlineAppsRef, recentsRef, setApps, setFavoriteExtraApps, setOnlineApps, setPlatformResolvedOtherIds, setRecentlyViewedApps, setSelectedApp]);

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
          const cand = pickRealDescription(hit.description);
          if (cand !== undefined) enrichInitialDesc = cand;
        }
        if (enrichInitialDescEn === undefined) {
          const candEn = pickRealDescription(hit.description_en);
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
          description_en: pickRealDescription(existing.description_en) ?? enrichInitialDescEn ?? '',
          owner: existing.owner,
          repo: existing.repo,
          icon: existing.icon,
          icon_bg: existing.icon_bg,
          description: pickRealDescription(existing.description) ?? enrichInitialDesc ?? '',
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
  }, [appsRef, loadRecentViews, onlineAppsRef, recentsRef, setSelectedApp, syncDetailCacheAndAppLists]);

  return {
    appDetailMemoryCache,
    activeDetailIdRef,
    loadRecentViews,
    syncDetailCacheAndAppLists,
    handleOpenDetail,
  };
}
