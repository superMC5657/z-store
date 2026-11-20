import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import { patchRowsPlatforms } from '../../services/search/onlineRows';
import { patchSearchListCacheRows } from '../../services/search/searchListCache';
import {
  isSharedRepoConfirmedOther,
  recordSharedConfirmedOthers,
  recordSharedRepoPlatforms,
} from '../../services/repoEnrichCache';
import {
  collectListLoadingKeys,
  createInflightGuard,
  createSeqGuard,
  normalizeLoadingKey,
  runLiteBatch,
  scheduleSettleConfirm,
  selectListLiteTargets,
  unionConfirmedSets,
  type InflightGuard,
  type SeqGuard,
} from '../../lib/platformFilter';

import type { CatalogListsStore } from './useCatalogLists';

interface UsePlatformBackfillParams {
  catalogLists: Pick<
    CatalogListsStore,
    'apps' | 'onlineApps' | 'recentlyViewedApps' | 'appsRef' | 'onlineAppsRef' | 'recentsRef' | 'patchPlatforms'
  >;
  searchSeqRef: React.MutableRefObject<number>;
}

function mergeConfirmedIds(prev: Set<string>, ids: readonly string[]): Set<string> {
  let changed = false;
  const next = new Set(prev);
  for (const raw of ids) {
    const k = normalizeLoadingKey(raw);
    if (k && !next.has(k)) {
      next.add(k);
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** 未收录行（只有这些行进三链路共享富卡池；收录行平台以收录库为准）。 */
function isUncatalogedRow(s: AppSummary): boolean {
  return s.is_cataloged !== true;
}

/**
 * 列表平台轻量回填共享执行器（主列表/在线搜索/Star 列表共用）：
 * 共享富卡池里已确认 Other 的未收录行（非强刷）直接落定，不发 IPC；
 * 其余分批走 `getPlatformsLite`（经 `runLiteBatch`），成功将真实平台写透目标列表、`searchListCache`
 * 与共享富卡池，空且非 stale 的写入已确认 other（同步写回共享池）；
 * stale/失败保持 loading 交由 `scheduleSettleConfirm` 兜底。
 */
async function executeLiteBackfillBatch(opts: {
  summaries: readonly AppSummary[];
  seq: number;
  forceRefresh: boolean;
  inflight: InflightGuard;
  seqGuard: SeqGuard;
  resolvedOther: ReadonlySet<string>;
  attempted?: Set<string>;
  onPatched: (patched: Map<string, string[]>) => void;
  onConfirmedEmpty: (confirmedEmpty: string[]) => void;
  onSettled?: () => void;
}): Promise<void> {
  const candidates = opts.attempted
    ? opts.summaries.filter((s) => {
        const k = normalizeLoadingKey(s.id);
        return k !== '' && !opts.attempted!.has(k);
      })
    : opts.summaries;
  const preConfirmedEmpty: string[] = [];
  const preConfirmedSet = new Set<string>();
  if (!opts.forceRefresh) {
    for (const s of candidates) {
      if (s.platforms && s.platforms.length > 0) continue;
      if (!isUncatalogedRow(s)) continue;
      const k = normalizeLoadingKey(s.id);
      if (!k || opts.resolvedOther.has(k) || preConfirmedSet.has(k)) continue;
      if (isSharedRepoConfirmedOther(k)) {
        preConfirmedSet.add(k);
        preConfirmedEmpty.push(k);
      }
    }
  }
  if (preConfirmedEmpty.length > 0) {
    opts.onConfirmedEmpty(preConfirmedEmpty);
  }
  const liteCandidates =
    preConfirmedSet.size > 0
      ? candidates.filter((s) => !preConfirmedSet.has(normalizeLoadingKey(s.id)))
      : candidates;
  const targets = selectListLiteTargets(liteCandidates, {
    resolved: opts.resolvedOther,
    inflight: opts.inflight,
  });
  if (targets.length === 0) return;
  const claimed = new Set(opts.inflight.take(targets.map((t) => t.key)));
  const runTargets = targets.filter((t) => claimed.has(t.key));
  if (runTargets.length === 0) return;
  if (opts.attempted) {
    for (const t of runTargets) opts.attempted.add(t.key);
  }
  try {
    const { patched, confirmedEmpty } = await runLiteBatch(
      runTargets,
      (liteId) => tauriApi.getPlatformsLite(liteId, opts.forceRefresh),
      () => opts.seqGuard.isStale(opts.seq),
    );
    if (opts.seqGuard.isStale(opts.seq)) return;
    const uncatalogedKeys = new Set(
      opts.summaries.filter(isUncatalogedRow).map((s) => normalizeLoadingKey(s.id)),
    );
    if (patched.size > 0) {
      patchSearchListCacheRows((prev) => patchRowsPlatforms(prev, patched));
      recordSharedRepoPlatforms(opts.summaries.filter(isUncatalogedRow), patched);
      opts.onPatched(patched);
    }
    if (confirmedEmpty.length > 0) {
      recordSharedConfirmedOthers(confirmedEmpty.filter((k) => uncatalogedKeys.has(normalizeLoadingKey(k))));
      opts.onConfirmedEmpty(confirmedEmpty);
    }
  } finally {
    opts.inflight.release(runTargets.map((t) => t.key));
    opts.onSettled?.();
  }
}

export function usePlatformBackfill({
  catalogLists,
  searchSeqRef,
}: UsePlatformBackfillParams) {
  const {
    apps,
    onlineApps,
    recentlyViewedApps,
    appsRef,
    onlineAppsRef,
    recentsRef,
    patchPlatforms,
  } = catalogLists;
  // 平台加载中追踪：summary 为空但详情尚未落定的行保持 loading（不展示 Other、不计入 other 桶、不过滤），
  // 详情取回仍为空才记入已确认 other（展示徽标、计入统计、参与过滤）。后端一律 `[]`，other 纯前端虚拟。
  const [platformResolvedOtherIds, setPlatformResolvedOtherIds] = useState<Set<string>>(() => new Set<string>());
  // 生命周期守卫归深模块所有：在途集合 + seq 守卫经统一工厂持有，逻辑见 `lib/platformFilter`。
  const inflightGuardRef = useRef<InflightGuard | null>(null);
  if (!inflightGuardRef.current) inflightGuardRef.current = createInflightGuard();
  const platformResolvedOtherRef = useRef<Set<string>>(new Set());
  platformResolvedOtherRef.current = platformResolvedOtherIds;
  const seqGuardRef = useRef<SeqGuard | null>(null);
  if (!seqGuardRef.current) seqGuardRef.current = createSeqGuard(() => searchSeqRef.current);
  const attemptedRef = useRef<{ seq: number; keys: Set<string> }>({
    seq: searchSeqRef.current,
    keys: new Set(),
  });

  const confirmPlatformOtherIds = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setPlatformResolvedOtherIds((prev) => mergeConfirmedIds(prev, ids));
  }, []);

  // 平台懒回填（三态）：首绘 loading 行不展示 Other 徽标、不计入 other 桶、恒可见；
  // 对可见行（前 20）经深模块 `runLiteBatch`（分批 5）走 getPlatformsLite 轻量通道
  // 补 deduced platforms（单次 releases/latest 条件请求，无 README/图标探测/checksum 开销）；
  // 轻量取回仍为空（且非 stale 离线缓存）才记为已确认 other（单次落定更新），
  // 详情不可达或 stale 一律保持 loading 交由 settle 超时兜底，不报错。后端一律 `[]`，other 纯前端虚拟。
  // seq 过期则整批丢弃，绝不阻塞列表首绘。
  // forceRefresh：仅显式重试传 true（跳过详情 TTL 快径直探远端）；
  // 常规搜索、翻页与首绘回填一律 false，复用 `app_details` TTL 与 `releases/latest` ETag。
  const lazyBackfillPlatforms = useCallback((summaries: AppSummary[], seq: number, forceRefresh = false) => {
    const guard = seqGuardRef.current;
    const inflight = inflightGuardRef.current;
    if (!guard || !inflight) return;
    if (attemptedRef.current.seq !== seq || forceRefresh) {
      attemptedRef.current = { seq, keys: new Set() };
    }
    void executeLiteBackfillBatch({
      summaries,
      seq,
      forceRefresh,
      inflight,
      seqGuard: guard,
      resolvedOther: platformResolvedOtherRef.current,
      attempted: attemptedRef.current.keys,
      onPatched: patchPlatforms,
      onConfirmedEmpty: confirmPlatformOtherIds,
    });
  }, [confirmPlatformOtherIds, patchPlatforms]);

  // 首绘回填：本地收录（含初始全量/搜索/目录同步）的 loading 行同样走轻量确认，
  // 首绘不闪 Other，落定后单次更新。重复调用经在途/已确认集合去重。
  // 自动路径读 TTL 缓存/DB（默认 DB-only）；显式重试经 lazyBackfillPlatforms 第三个参数传 true。
  useEffect(() => {
    if (apps.length === 0) return;
    lazyBackfillPlatforms(apps, searchSeqRef.current);
  }, [apps, lazyBackfillPlatforms, searchSeqRef]);

  // 主列表 loading settle 超时（Home/分类/收藏共用，与 Trends 榜单同口径）：
  // lite 失败/stale 的 loading 行至多等待 15s 后降级为已确认 Other
  // （徽标 + 计数 + 可过滤），而非无限 shimmer。超时前恒可见，落定后走正常 Other 过滤。
  // 治愈（具真实平台）的行永不被确认；定时器随列表/回填变化重置，落稳后一次触发。
  // 定时归深模块 `scheduleSettleConfirm` 所有。
  useEffect(() => {
    if (apps.length === 0 && onlineApps.length === 0 && recentlyViewedApps.length === 0) return;
    const keys = collectListLoadingKeys(
      [apps, onlineApps, recentlyViewedApps],
      platformResolvedOtherIds,
    );
    if (keys.length === 0) return;
    return scheduleSettleConfirm({
      keys,
      recheck: (snapshot) => {
        const currentById = new Map<string, AppSummary>();
        for (const s of [...appsRef.current, ...onlineAppsRef.current, ...recentsRef.current]) {
          const k = (s.id || '').trim().toLowerCase();
          if (k && !currentById.has(k)) currentById.set(k, s);
        }
        const resolved = platformResolvedOtherRef.current;
        return snapshot.filter((key) => {
          const cur = currentById.get(key);
          if (cur?.platforms && cur.platforms.length > 0) return false;
          return !resolved.has(key);
        });
      },
      onConfirm: (stillLoading) => {
        confirmPlatformOtherIds(stillLoading);
      },
    });
  }, [
    apps,
    onlineApps,
    recentlyViewedApps,
    platformResolvedOtherIds,
    appsRef,
    onlineAppsRef,
    recentsRef,
    confirmPlatformOtherIds,
  ]);

  return {
    platformResolvedOtherIds,
    setPlatformResolvedOtherIds,
    confirmPlatformOtherIds,
    lazyBackfillPlatforms,
  };
}

interface UseListPlatformBackfillParams {
  rows: readonly AppSummary[];
  setRows: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  seqRef: React.MutableRefObject<number>;
  sharedResolvedOtherIds: ReadonlySet<string>;
  onConfirmOtherIds?: (ids: readonly string[]) => void;
  forceRefresh?: boolean;
}

/**
 * 独立分页视图（如 StarredFeed）的平台回填与 15s 落定 Hook：
 * 与主列表/在线搜索共用 `executeLiteBackfillBatch` + `scheduleSettleConfirm`，
 * 同 seq 内对已尝试过但仍 stale/失败的行不重复请求，交由 15s settle 落定为 Other。
 */
export function useListPlatformBackfill({
  rows,
  setRows,
  seqRef,
  sharedResolvedOtherIds,
  onConfirmOtherIds,
  forceRefresh = false,
}: UseListPlatformBackfillParams): { resolvedOtherIds: ReadonlySet<string> } {
  const rowsRef = useRef<readonly AppSummary[]>(rows);
  rowsRef.current = rows;
  const [localResolvedOtherIds, setLocalResolvedOtherIds] = useState<Set<string>>(() => new Set<string>());
  const [drainTick, setDrainTick] = useState(0);
  const inflightGuardRef = useRef<InflightGuard | null>(null);
  if (!inflightGuardRef.current) inflightGuardRef.current = createInflightGuard();
  const seqGuardRef = useRef<SeqGuard | null>(null);
  if (!seqGuardRef.current) seqGuardRef.current = createSeqGuard(() => seqRef.current);
  const attemptedRef = useRef<{ seq: number; keys: Set<string> }>({
    seq: seqRef.current,
    keys: new Set<string>(),
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolvedOtherIds = useMemo(
    () =>
      localResolvedOtherIds.size === 0
        ? sharedResolvedOtherIds
        : unionConfirmedSets(sharedResolvedOtherIds, localResolvedOtherIds),
    [sharedResolvedOtherIds, localResolvedOtherIds],
  );
  const resolvedOtherRef = useRef<ReadonlySet<string>>(resolvedOtherIds);
  resolvedOtherRef.current = resolvedOtherIds;

  const confirmOtherIds = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      if (onConfirmOtherIds) {
        onConfirmOtherIds(ids);
        return;
      }
      setLocalResolvedOtherIds((prev) => mergeConfirmedIds(prev, ids));
    },
    [onConfirmOtherIds],
  );

  useEffect(() => {
    if (rows.length === 0) return;
    const guard = seqGuardRef.current;
    const inflight = inflightGuardRef.current;
    if (!guard || !inflight) return;
    const seq = guard.capture();
    if (attemptedRef.current.seq !== seq) {
      attemptedRef.current = { seq, keys: new Set<string>() };
    }
    const attempted = attemptedRef.current.keys;
    void executeLiteBackfillBatch({
      summaries: rows,
      seq,
      forceRefresh,
      inflight,
      seqGuard: guard,
      resolvedOther: resolvedOtherRef.current,
      attempted,
      onPatched: (patched) => {
        if (!mountedRef.current) return;
        setRows((prev) => patchRowsPlatforms(prev, patched));
      },
      onConfirmedEmpty: (confirmedEmpty) => {
        if (!mountedRef.current) return;
        confirmOtherIds(confirmedEmpty);
      },
      onSettled: () => {
        if (!mountedRef.current || guard.isStale(seq)) return;
        const remaining = rowsRef.current.filter((s) => {
          const k = normalizeLoadingKey(s.id);
          return k !== '' && !attempted.has(k);
        });
        const nextTargets = selectListLiteTargets(remaining, {
          resolved: resolvedOtherRef.current,
          inflight,
        });
        if (nextTargets.length > 0) {
          setDrainTick((n) => n + 1);
        }
      },
    });
  }, [rows, drainTick, forceRefresh, rowsRef, setRows, confirmOtherIds]);

  useEffect(() => {
    if (rows.length === 0) return;
    const keys = collectListLoadingKeys([rows], resolvedOtherIds);
    if (keys.length === 0) return;
    return scheduleSettleConfirm({
      keys,
      recheck: (snapshot) => {
        const currentById = new Map<string, AppSummary>();
        for (const s of rowsRef.current) {
          const k = normalizeLoadingKey(s.id);
          if (k && !currentById.has(k)) currentById.set(k, s);
        }
        const resolved = resolvedOtherRef.current;
        return snapshot.filter((key) => {
          const cur = currentById.get(key);
          if (!cur) return false;
          if (cur.platforms && cur.platforms.length > 0) return false;
          return !resolved.has(key);
        });
      },
      onConfirm: confirmOtherIds,
    });
  }, [rows, resolvedOtherIds, rowsRef, confirmOtherIds]);

  return { resolvedOtherIds };
}
