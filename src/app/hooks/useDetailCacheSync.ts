import { useCallback, useEffect, useRef } from 'react';
import type { AppDetail, AppDetailViewModel, AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import { admitIconHit, getBufferedIcon } from '../../services/iconStore';
import type { CatalogListsStore } from './useCatalogLists';
import { annotateIsCataloged, buildCatalogIdSet, prepareRecentViews, selectCatalogBase } from '../selectors';
import { DEFAULT_ICON_BG } from '../../styles/tokens';
import { resolveRemoteIconUrl } from '../../services/custom';
import { arePlatformsEqual, buildAppRepoUrl, resolveExternalHomepageUrl } from '../../utils/appHelper';
import { findInSearchListCache, patchSearchListCacheRows } from '../../services/search/searchListCache';
import { unmaskRecentViewApp } from '../../services/recentViewsMask';
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

interface UseDetailCacheSyncParams {
  catalogLists: Pick<
    CatalogListsStore,
    | 'appsRef'
    | 'fullCatalogAppsRef'
    | 'onlineAppsRef'
    | 'recentsRef'
    | 'setRecentlyViewedApps'
    | 'patchAllLists'
    | 'patchIcons'
    | 'findById'
  >;
  selectedApp: AppDetailViewModel | null;
  setSelectedApp: React.Dispatch<React.SetStateAction<AppDetailViewModel | null>>;
  setPlatformResolvedOtherIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** 本地收录合并行（含 source='local'/status，供详情 Header 黄标判定；不改排序/去重）。 */
  localApps?: readonly AppSummary[];
}

/** 过滤占位/空白简介，仅返回实质文本。 */
function pickRealDescription(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '' || isPlaceholderDescription(t)) return undefined;
  return v;
}

function nonBlankString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function isConcreteLicense(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const lower = v.trim().toLowerCase();
  return lower !== '' && lower !== '...' && lower !== 'unknown' && lower !== 'opensource';
}

/** 选取收录库行：远端目录优先，本地收录在远端缺席时补位。 */
function findCuratedEntry(
  idClean: string,
  fullCatalogApps: readonly AppSummary[] | undefined,
  apps: readonly AppSummary[],
  localApps: readonly AppSummary[] | undefined,
): AppSummary | undefined {
  const matches = (a: AppSummary) => a.id.toLowerCase() === idClean;
  return fullCatalogApps?.find(matches) ?? apps.find(matches) ?? localApps?.find(matches);
}

/** 管理详情内存快照、后台 ETag 条件探查及卡片列表/趋势富卡同步。 */
export function useDetailCacheSync({
  catalogLists,
  selectedApp,
  setSelectedApp,
  setPlatformResolvedOtherIds,
  localApps,
}: UseDetailCacheSyncParams) {
  const {
    appsRef,
    fullCatalogAppsRef,
    onlineAppsRef,
    recentsRef,
    setRecentlyViewedApps,
    patchAllLists,
    patchIcons,
    findById,
  } = catalogLists;
  const appDetailMemoryCache = useRef<Map<string, AppDetail>>(new Map());
  const activeDetailIdRef = useRef<string | null>(null);
  const selectedAppRef = useRef<AppDetailViewModel | null>(null);
  selectedAppRef.current = selectedApp;
  const localAppsRef = useRef<readonly AppSummary[] | undefined>(localApps);
  localAppsRef.current = localApps;

  // 收录库变更时清空详情内存快照，避免再次打开展示过期收录字段
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const clearCache = () => {
      appDetailMemoryCache.current.clear();
    };
    window.addEventListener('zstore:custom-apps-changed', clearCache);
    window.addEventListener('zstore:catalog-synced', clearCache);
    return () => {
      window.removeEventListener('zstore:custom-apps-changed', clearCache);
      window.removeEventListener('zstore:catalog-synced', clearCache);
    };
  }, []);

  // 按当前目录与本地收录集合标注 `is_cataloged` 与本地标记
  const annotateEntry = useCallback(
    <T extends AppSummary>(row: T): T => {
      const baseCatalog = selectCatalogBase(fullCatalogAppsRef?.current, appsRef.current);
      return annotateIsCataloged(row, buildCatalogIdSet(baseCatalog), localApps);
    },
    [appsRef, fullCatalogAppsRef, localApps],
  );

  const loadRecentViews = useCallback(async () => {
    try {
      const recents = await tauriApi.getRecentlyViewedApps();
      // 叠加本地标记并使用趋势富卡非占位简介治愈最近浏览行
      const withLocal = prepareRecentViews(recents, fullCatalogAppsRef?.current, appsRef.current, localApps);
      try {
        const snap = snapshotTrendEnrichCache();
        if (Object.keys(snap).length === 0) {
          setRecentlyViewedApps(withLocal);
          return;
        }
        const healed = withLocal.map((r) => {
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
        setRecentlyViewedApps(withLocal);
      }
    } catch {
      // 忽略错误
    }
  }, [setRecentlyViewedApps, appsRef, fullCatalogAppsRef, localApps]);

  // 同步详情快照缓存与各卡片列表（字段无变化时保留原引用，避免全网格重渲染）
  const patchDetailMemoryAndLists = useCallback((idClean: string, rawDetail: AppDetail, isBackgroundSilent = false) => {
    const detail = annotateEntry(rawDetail);
    // 用趋势富卡非占位简介兜底，避免占位文案进入内存快照
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
      // 快照读取失败时回退为无富卡兜底
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
        // 详情无主页时保留首帧已展示的主页（来自列表行/富卡，后端未必可见），避免入口闪现后消失
        const nextHomepage = nonBlankString(detail.homepage) ?? nonBlankString(prev?.homepage) ?? detail.homepage ?? null;
        const healed = {
          ...detail,
          description: nextDesc,
          description_en: nextDescEn,
          homepage: nextHomepage,
          isLoading: false,
          isRefreshing: false,
        };
        if (!prev) return healed;
        if (
          !isBackgroundSilent ||
          prev.name !== detail.name ||
          prev.latest_version !== detail.latest_version ||
          prev.releases.length !== detail.releases.length ||
          prev.stars !== detail.stars ||
          prev.license !== detail.license ||
          prev.category !== detail.category ||
          prev.icon !== detail.icon ||
          prev.description !== nextDesc ||
          (prev.description_en ?? undefined) !== (nextDescEn ?? undefined) ||
          (prev.homepage ?? null) !== nextHomepage ||
          !arePlatformsEqual(prev.platforms, detail.platforms) ||
          detailDescIsPlaceholder ||
          detailDescEnIsPlaceholder
        ) {
          return healed;
        }
        return prev;
      });
    }

    const rawDetailIcon = typeof detail.icon === 'string' ? detail.icon.trim() : '';
    // data: URL 仅用于即时展示，不写回列表或持久化缓存
    const patchedIcon =
      rawDetailIcon !== '' && !rawDetailIcon.startsWith('data:') ? rawDetailIcon : undefined;
    // stale 离线详情不具权威性，不触发平台确认或治愈
    const isStaleDetail = Boolean(detail.is_stale);
    const detailPlatforms = !isStaleDetail && detail.platforms && detail.platforms.length > 0 ? detail.platforms : undefined;
    const detailConfirmedEmpty = !isStaleDetail && !detailPlatforms;

    const patchSummary = (app: AppSummary): AppSummary => {
      const isTarget =
        app.id.toLowerCase() === idClean ||
        (detail.id && app.id.toLowerCase() === detail.id.toLowerCase());
      if (!isTarget) return app;
      const nextIcon = patchedIcon ? patchedIcon : app.icon;
      const nextPlatforms = detailPlatforms
        ? (arePlatformsEqual(app.platforms, detailPlatforms) ? app.platforms : detailPlatforms)
        : app.platforms;
      // 占位简介优先用富卡非占位值替换，否则保留列表现有值
      const nextDescription = isPlaceholderDescription(detail.description)
        ? (enrichDesc ?? app.description)
        : detail.description;
      const nextDescriptionEnRaw = detail.description_en;
      const nextDescriptionEn =
        typeof nextDescriptionEnRaw === 'string' && isPlaceholderDescription(nextDescriptionEnRaw)
          ? (enrichDescEn ?? app.description_en)
          : nextDescriptionEnRaw;
      // 详情无主页时保留列表行已有主页，供下次内存命中治愈首帧
      const nextHomepage = nonBlankString(detail.homepage) ?? app.homepage;
      // 未收录(false) 恒写透，已收录(true) 仅纠正已有显式位以减少目录行重绘；本地行同步 source/status
      const nextCataloged = (detail as unknown as { is_cataloged?: unknown }).is_cataloged;
      const rowCataloged = (app as unknown as { is_cataloged?: unknown }).is_cataloged;
      const shouldSyncCataloged =
        typeof nextCataloged === 'boolean' &&
        (nextCataloged === false || typeof rowCataloged === 'boolean') &&
        rowCataloged !== nextCataloged;
      const detailSource = (detail as unknown as { source?: unknown }).source;
      const detailStatus = (detail as unknown as { status?: unknown }).status;
      const rowSource = (app as unknown as { source?: unknown }).source;
      const shouldSyncLocal =
        detailSource === 'local' &&
        rowSource !== 'local' &&
        rowSource !== 'custom' &&
        app.is_verified !== true;
      const wantStatus = typeof detailStatus === 'string' && detailStatus ? detailStatus : 'collected';
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
        app.name === detail.name &&
        !shouldSyncCataloged &&
        !shouldSyncLocal
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
        ...(shouldSyncCataloged ? { is_cataloged: nextCataloged } : null),
        ...(shouldSyncLocal ? { source: 'local', status: wantStatus, is_cataloged: true } : null),
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
    // 图标写口唯一经店内 `admitIconHit`（经 catalogLists.patchIcons 写透全部列表 + 文件预热 + M1 缓冲）。
    patchAllLists(patchList);
    // 搜索列表 M1 缓存全字段写透：翻页/重搜回访时立即呈现详情更新后的最新数据
    patchSearchListCacheRows(patchList);
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
    // 详情带回真实平台：解除已确认 other、驱逐榜单空缓存并广播平台治愈事件
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
    // 非 stale 时同步更新趋势富卡缓存并广播变更字段
    if (!isStaleDetail) {
      try {
        const healed = upsertTrendEnrichRichcard(detail, findById);
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
      admitIconHit({ id: idClean, icon: patchedIcon, patch: patchIcons });
    } else {
      // 已有缓冲图标或列表远端实图时跳过重复 IPC（详情 Header 会自行触发轮换加载）
      const bufferedHit = getBufferedIcon(idClean);
      if (typeof bufferedHit === 'string' && bufferedHit.trim() !== '') {
        return;
      }
      const cardIcon = findById(idClean)?.icon;
      if (
        typeof cardIcon === 'string' &&
        (cardIcon.trim().startsWith('http://') || cardIcon.trim().startsWith('https://'))
      ) {
        return;
      }
      // 列表回填仅使用可持久化的远端 URL，忽略 data: 即时态
      void tauriApi.restoreOrFetchIconCycle(idClean).then((cycle) => {
        const remote = resolveRemoteIconUrl(cycle);
        const fallbackUrl = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
        const persistUrl = remote !== '' ? remote : (!fallbackUrl.startsWith('data:') ? fallbackUrl : '');
        if(!persistUrl){
          // L5 显式空态需经写口广播以定格徽章，普通空值丢弃保留占位
          const emptyLevel = typeof cycle?.level === 'number' && cycle.level === 5 ? 5 : undefined;
          if (emptyLevel === 5) {
            admitIconHit({ id: idClean, icon: '', level: 5, patch: patchIcons });
          }
          return;
        }
        const cycleLevel = typeof cycle?.level === 'number' ? cycle.level : undefined;
        admitIconHit({ id: idClean, icon: persistUrl, level: cycleLevel, patch: patchIcons });
      }).catch(() => {
        // 取不到轮换图标则保持占位，不阻塞
      });
    }
  }, [annotateEntry, findById, patchAllLists, patchIcons, setPlatformResolvedOtherIds, setSelectedApp]);

  // 打开应用详情弹窗（命中内存快照时零延迟展示并后台条件探查）
  const handleOpenDetail = useCallback(async (id: string, forceRefresh = false) => {
    const idClean = id.trim().toLowerCase();
    activeDetailIdRef.current = id;

    if (!forceRefresh) {
      const cached = appDetailMemoryCache.current.get(idClean);
      if (cached) {
        // 若缓存简介仍为占位文案，用富卡缓存的非占位值先行替换
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
        // 收录库行优先；未收录再回退在线/最近/搜缓存
        const curatedCatalogHit = findCuratedEntry(
          idClean,
          fullCatalogAppsRef?.current,
          appsRef.current,
          localAppsRef.current,
        );
        const catalogHit =
          curatedCatalogHit ??
          onlineAppsRef.current.find((a) => a.id.toLowerCase() === idClean) ??
          recentsRef.current.find((a) => a.id.toLowerCase() === idClean) ??
          findInSearchListCache(idClean);
        if (curatedCatalogHit && nonBlankString(curatedCatalogHit.name) && cachedForShow.name !== curatedCatalogHit.name) {
          cachedForShow = { ...cachedForShow, name: curatedCatalogHit.name };
        }
        if (
          catalogHit?.description &&
          catalogHit.description.trim() !== '' &&
          !isPlaceholderDescription(catalogHit.description) &&
          cachedForShow.description !== catalogHit.description
        ) {
          cachedForShow = { ...cachedForShow, description: catalogHit.description };
        }
        if (
          catalogHit?.description_en &&
          catalogHit.description_en.trim() !== '' &&
          !isPlaceholderDescription(catalogHit.description_en) &&
          cachedForShow.description_en !== catalogHit.description_en
        ) {
          cachedForShow = { ...cachedForShow, description_en: catalogHit.description_en };
        }
        const curatedExternalHomepage = curatedCatalogHit
          ? resolveExternalHomepageUrl(curatedCatalogHit.homepage, buildAppRepoUrl(curatedCatalogHit))
          : null;
        if (curatedExternalHomepage && cachedForShow.homepage !== curatedExternalHomepage) {
          cachedForShow = { ...cachedForShow, homepage: curatedExternalHomepage };
        } else {
          const catalogHomepage = nonBlankString(catalogHit?.homepage);
          if (!nonBlankString(cachedForShow.homepage) && catalogHomepage) {
            cachedForShow = { ...cachedForShow, homepage: catalogHomepage };
          }
        }
        if (catalogHit?.icon && catalogHit.icon.trim() !== '' && cachedForShow.icon !== catalogHit.icon) {
          cachedForShow = { ...cachedForShow, icon: catalogHit.icon };
        }
        if (catalogHit?.icon_bg && catalogHit.icon_bg.trim() !== '' && cachedForShow.icon_bg !== catalogHit.icon_bg) {
          cachedForShow = { ...cachedForShow, icon_bg: catalogHit.icon_bg };
        }
        if (catalogHit?.category && cachedForShow.category !== catalogHit.category) {
          cachedForShow = {
            ...cachedForShow,
            category: catalogHit.category,
            category_name: catalogHit.category_name ?? cachedForShow.category_name,
          };
        }
        if (curatedCatalogHit && isConcreteLicense(curatedCatalogHit.license) && cachedForShow.license !== curatedCatalogHit.license) {
          cachedForShow = { ...cachedForShow, license: curatedCatalogHit.license };
        }
        if (curatedCatalogHit) {
          if (cachedForShow.is_verified !== curatedCatalogHit.is_verified) {
            cachedForShow = { ...cachedForShow, is_verified: curatedCatalogHit.is_verified };
          }
          if (curatedCatalogHit.added_at !== undefined && cachedForShow.added_at !== curatedCatalogHit.added_at) {
            cachedForShow = { ...cachedForShow, added_at: curatedCatalogHit.added_at };
          }
        }
        if (
          curatedCatalogHit?.platforms &&
          curatedCatalogHit.platforms.length > 0 &&
          !arePlatformsEqual(cachedForShow.platforms, curatedCatalogHit.platforms)
        ) {
          cachedForShow = { ...cachedForShow, platforms: [...curatedCatalogHit.platforms] };
        }
        appDetailMemoryCache.current.set(idClean, cachedForShow);

        // 先以 0ms 瞬间展示内存快照，避免骨架屏闪烁
        // 内存快照按当前目录重标注收录位（目录后到即纠正旧快照缺位，fail-closed）。
        setSelectedApp({
          ...annotateEntry(cachedForShow),
          isLoading: false,
          isRefreshing: false,
          loadError: undefined,
        });
        // recordAppView 本地写保留（DB/local）；后台 ETag 条件探查自动跟进（缓存优先，命中 short-circuit）。
        unmaskRecentViewApp(id);
        tauriApi.recordAppView(id).then(loadRecentViews).catch(() => {});

        // 后台静默发起 ETag 条件探查：版本未变（304）后端毫秒级短路，版本变化则静默平滑更新
        tauriApi.getAppDetails(id, false).then((updatedDetail) => {
          patchDetailMemoryAndLists(idClean, updatedDetail, true);
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

    // 内存未命中或强制刷新：先用现有卡片或富卡快照即时渲染初始态，再请求完整详情
    const existing =
      findCuratedEntry(idClean, fullCatalogAppsRef?.current, appsRef.current, localAppsRef.current) ||
      onlineAppsRef.current.find((a) => a.id.toLowerCase() === idClean) ||
      recentsRef.current.find((a) => a.id.toLowerCase() === idClean) ||
      findInSearchListCache(idClean);

    // 取富卡缓存非占位简介作为 loading 阶段的初始值
    let enrichInitialDesc: string | undefined;
    let enrichInitialDescEn: string | undefined;
    let enrichInitialHomepage: string | undefined;
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
        if (enrichInitialHomepage === undefined) enrichInitialHomepage = nonBlankString(hit.homepage);
        if (
          enrichInitialDesc !== undefined &&
          enrichInitialDescEn !== undefined &&
          enrichInitialHomepage !== undefined
        ) {
          break;
        }
      }
    } catch {
      // 快照失败时使用默认初始值
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
          homepage: nonBlankString(existing.homepage) ?? enrichInitialHomepage ?? null,
          platforms: existing.platforms,
          added_at: existing.added_at,
          isLoading: true,
          isRefreshing: forceRefresh,
        }
      : {
          id,
          name: id,
          owner: id.includes('/') ? id.split('/')[0] : '',
          repo: id.includes('/') ? id.split('/')[1] : id,
          icon: '📦',
          icon_bg: DEFAULT_ICON_BG,
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
          homepage: enrichInitialHomepage ?? null,
          platforms: [],
          isLoading: true,
          isRefreshing: forceRefresh,
        };

    // 即时打开弹窗并落盘浏览记录；recents 列表刷新延后至详情拉取之后，避免被占位快照覆盖
    setSelectedApp(
      annotateEntry(initialDetail),
    );
    unmaskRecentViewApp(id);
    void tauriApi.recordAppView(id).catch(() => {});

    try {
      const fullDetail = await tauriApi.getAppDetails(id, forceRefresh);
      patchDetailMemoryAndLists(idClean, fullDetail, false);
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
  }, [annotateEntry, appsRef, loadRecentViews, onlineAppsRef, recentsRef, setSelectedApp, patchDetailMemoryAndLists]);

  return {
    appDetailMemoryCache,
    activeDetailIdRef,
    loadRecentViews,
    patchDetailMemoryAndLists,
    handleOpenDetail,
  };
}
