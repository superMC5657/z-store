/**
 * 设备平台过滤（`Bi-dimensional Filter` 的平台维）状态域：
 * 全局平台勾选（localStorage 持久化）、已确认 other 集与列表平台懒回填、搜索世代，
 * 以及各视图上报的侧栏平台分布槽位与侧栏最终计数决议。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewType } from '../../types';
import {
  PLATFORM_FILTER_STORAGE_KEY,
  PLATFORM_IDS,
  loadSelectedPlatforms,
  togglePlatformSet,
  type PlatformId,
} from '../../lib/platformFilter';
import type { PlatformCounts } from '../selectors';
import type { CatalogListsStore } from './useCatalogLists';
import { usePlatformBackfill } from './usePlatformBackfill';

/** 只统计自身内容的视图：未上报前侧栏沿用上次稳定计数，上报 null 即清槽（回落全库口径）。 */
const VIEW_SCOPED_PLATFORM_VIEWS: ReadonlySet<ViewType> = new Set<ViewType>([
  'trends',
  'launchpad',
  'latest',
  'pending',
  'installed',
  'favorites',
]);

export type ViewPlatformCountSlots = Partial<Record<ViewType, PlatformCounts | null>>;
export type ReportViewPlatformCounts = (view: ViewType, counts: PlatformCounts | null) => void;

/**
 * 视图级平台分布槽位：各视图按自身 view 键上报；分类大厅离开即清槽（再进停在大厅时回落全库）。
 */
export function useViewPlatformCountSlots(currentView: ViewType) {
  const [viewPlatformCounts, setSlots] = useState<ViewPlatformCountSlots>({});
  const reportViewPlatformCounts = useCallback<ReportViewPlatformCounts>((view, counts) => {
    setSlots((prev) => {
      if (counts === null) {
        if (VIEW_SCOPED_PLATFORM_VIEWS.has(view)) {
          if (!(view in prev)) return prev;
          const next = { ...prev };
          delete next[view];
          return next;
        }
        if (prev[view] === null) return prev;
        return { ...prev, [view]: null };
      }
      if (prev[view] === counts) return prev;
      return { ...prev, [view]: counts };
    });
  }, []);

  const prevViewRef = useRef(currentView);
  useLayoutEffect(() => {
    const left = prevViewRef.current;
    prevViewRef.current = currentView;
    if (left !== currentView && left === 'categories') {
      setSlots((prev) => {
        if (!('categories' in prev)) return prev;
        const next = { ...prev };
        delete next.categories;
        return next;
      });
    }
  }, [currentView]);

  return { viewPlatformCounts, reportViewPlatformCounts };
}

/**
 * 侧栏平台计数决议：当前视图上报值 >（全库作用域或显式回退 null 时：home 搜索态分布 > 全库分布）
 * > 上次稳定计数（异步视图首次上报前不闪空）。
 */
export function useSidebarPlatformCounts({
  currentView,
  viewPlatformCounts,
  searchCounts,
  catalogCounts,
}: {
  currentView: ViewType;
  viewPlatformCounts: ViewPlatformCountSlots;
  /** home 搜索态分布；非 home 搜索态为 null。 */
  searchCounts: PlatformCounts | null;
  /** 全库分布（侧栏默认口径）。 */
  catalogCounts: PlatformCounts;
}): PlatformCounts | undefined {
  const reported = viewPlatformCounts[currentView];
  const resolved: PlatformCounts | undefined =
    reported !== undefined
      ? reported ?? searchCounts ?? catalogCounts
      : VIEW_SCOPED_PLATFORM_VIEWS.has(currentView)
        ? undefined
        : searchCounts ?? catalogCounts;
  const lastStableRef = useRef<PlatformCounts | undefined>(undefined);
  if (resolved !== undefined) lastStableRef.current = resolved;
  return resolved ?? lastStableRef.current;
}

interface UsePlatformFilterParams {
  currentView: ViewType;
  catalogLists: Parameters<typeof usePlatformBackfill>[0]['catalogLists'] & Pick<CatalogListsStore, 'apps'>;
}

export function usePlatformFilter({ currentView, catalogLists }: UsePlatformFilterParams) {
  // 默认选中全部 PLATFORM_IDS（含虚拟 other）；仅持久化至 localStorage（本地界面偏好，不进备份）。
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(() => loadSelectedPlatforms());
  useEffect(() => {
    try {
      window.localStorage.setItem(PLATFORM_FILTER_STORAGE_KEY, JSON.stringify([...selectedPlatforms]));
    } catch {
      // 无痕模式/配额满/存储抛错时保持内存选择状态
    }
  }, [selectedPlatforms]);

  // 空选择为有效状态（页面渲染空筛选引导）；函数式 updater 保证连续点击顺序生效。
  const togglePlatform = useCallback((id: PlatformId) => {
    setSelectedPlatforms((prev) => togglePlatformSet(prev, id));
  }, []);
  const resetPlatformFilter = useCallback(() => {
    setSelectedPlatforms(new Set<PlatformId>(PLATFORM_IDS));
  }, []);

  // 搜索世代：搜索链路每次发起自增，平台回填据此丢弃过期批次。
  const searchSeqRef = useRef(0);
  const backfill = usePlatformBackfill({ catalogLists, searchSeqRef });

  const { viewPlatformCounts, reportViewPlatformCounts } = useViewPlatformCountSlots(currentView);

  return {
    selectedPlatforms,
    togglePlatform,
    resetPlatformFilter,
    searchSeqRef,
    platformResolvedOtherIds: backfill.platformResolvedOtherIds,
    setPlatformResolvedOtherIds: backfill.setPlatformResolvedOtherIds,
    confirmPlatformOtherIds: backfill.confirmPlatformOtherIds,
    lazyBackfillPlatforms: backfill.lazyBackfillPlatforms,
    viewPlatformCounts,
    reportViewPlatformCounts,
  };
}
