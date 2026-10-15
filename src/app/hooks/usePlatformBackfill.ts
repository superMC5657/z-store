import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { tauriApi } from '../../services/api';
import {
  collectListPendingKeys,
  createInflightGuard,
  createSeqGuard,
  runLiteBatch,
  scheduleSettleConfirm,
  selectListLiteTargets,
  type InflightGuard,
  type SeqGuard,
} from '../../lib/platformFilter';

export interface UsePlatformBackfillParams {
  apps: AppSummary[];
  onlineApps: AppSummary[];
  recentlyViewedApps: AppSummary[];
  appsRef: React.MutableRefObject<AppSummary[]>;
  onlineAppsRef: React.MutableRefObject<AppSummary[]>;
  recentsRef: React.MutableRefObject<AppSummary[]>;
  searchSeqRef: React.MutableRefObject<number>;
  setApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setOnlineApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
  setRecentlyViewedApps: React.Dispatch<React.SetStateAction<AppSummary[]>>;
}

export function usePlatformBackfill({
  apps,
  onlineApps,
  recentlyViewedApps,
  appsRef,
  onlineAppsRef,
  recentsRef,
  searchSeqRef,
  setApps,
  setOnlineApps,
  setRecentlyViewedApps,
}: UsePlatformBackfillParams) {
  // 平台待确认追踪：summary 为空但详情尚未落定的行保持 pending（不展示 Other、不计入 other 桶、不过滤），
  // 详情取回仍为空才记入已确认 other（展示徽标、计入统计、参与过滤）。后端一律 `[]`，other 纯前端虚拟。
  const [platformResolvedOtherIds, setPlatformResolvedOtherIds] = useState<Set<string>>(() => new Set<string>());
  // 生命周期守卫归深模块所有：在途集合 + seq 守卫经统一工厂持有，逻辑见 `lib/platformFilter`。
  const inflightGuardRef = useRef<InflightGuard | null>(null);
  if (!inflightGuardRef.current) inflightGuardRef.current = createInflightGuard();
  const platformResolvedOtherRef = useRef<Set<string>>(new Set());
  platformResolvedOtherRef.current = platformResolvedOtherIds;
  const seqGuardRef = useRef<SeqGuard | null>(null);
  if (!seqGuardRef.current) seqGuardRef.current = createSeqGuard(() => searchSeqRef.current);

  // 平台懒回填（三态）：首绘 pending 行不展示 Other 徽标、不计入 other 桶、恒可见；
  // 对可见行（前 20）经深模块 `runLiteBatch`（分批 5）走 getPlatformsLite 轻量通道
  // 补 deduced platforms（单次 releases/latest 条件请求，无 README/图标探测/checksum 开销）；
  // 轻量取回仍为空（且非 stale 离线缓存）才记为已确认 other（单次落定更新），
  // 详情不可达或 stale 一律保持 pending 交由 settle 超时兜底，不报错。后端一律 `[]`，other 纯前端虚拟。
  // seq 过期则整批丢弃，绝不阻塞列表首绘。
  const lazyBackfillPlatforms = useCallback((summaries: AppSummary[], seq: number) => {
    const guard = seqGuardRef.current;
    const inflight = inflightGuardRef.current;
    if (!guard || !inflight) return;
    const targets = selectListLiteTargets(summaries, {
      resolved: platformResolvedOtherRef.current,
      inflight,
    });
    if (targets.length === 0) return;
    const claimed = new Set(inflight.take(targets.map((t) => t.key)));
    const runTargets = targets.filter((t) => claimed.has(t.key));
    if (runTargets.length === 0) return;
    void (async () => {
      try {
        const { patched, confirmedEmpty } = await runLiteBatch(
          runTargets,
          (liteId) => tauriApi.getPlatformsLite(liteId),
          () => guard.isStale(seq),
        );
        if (guard.isStale(seq)) return;
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
        inflight.release(runTargets.map((t) => t.key));
      }
    })();
  }, [setApps, setOnlineApps, setRecentlyViewedApps]);

  // 首绘回填：本地收录（含初始全量/搜索/目录同步）的 pending 行同样走轻量确认，
  // 首绘不闪 Other，落定后单次更新。重复调用经在途/已确认集合去重。
  useEffect(() => {
    if (apps.length === 0) return;
    lazyBackfillPlatforms(apps, searchSeqRef.current);
  }, [apps, lazyBackfillPlatforms, searchSeqRef]);

  // 主列表 pending settle 超时（Home/分类/收藏共用，与 Trends 榜单同口径）：
  // lite 失败/stale 的 pending 行至多等待 15s 后降级为已确认 Other
  // （徽标 + 计数 + 可过滤），而非无限 shimmer。超时前恒可见，落定后走正常 Other 过滤。
  // 治愈（具真实平台）的行永不被确认；定时器随列表/回填变化重置，落稳后一次触发。
  // 定时归深模块 `scheduleSettleConfirm` 所有。
  useEffect(() => {
    if (apps.length === 0 && onlineApps.length === 0 && recentlyViewedApps.length === 0) return;
    const keys = collectListPendingKeys(
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
      onConfirm: (stillPending) => {
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
      },
    });
  }, [apps, onlineApps, recentlyViewedApps, platformResolvedOtherIds, appsRef, onlineAppsRef, recentsRef]);

  return {
    platformResolvedOtherIds,
    setPlatformResolvedOtherIds,
    lazyBackfillPlatforms,
  };
}
