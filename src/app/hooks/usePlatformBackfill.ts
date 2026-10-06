import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { api } from '../../services/api';
import { PENDING_SETTLE_MS, resolvePendingPlatformsLite } from '../../lib/platformFilter';

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
  const platformBackfillInflightRef = useRef<Set<string>>(new Set());
  const platformResolvedOtherRef = useRef<Set<string>>(new Set());
  platformResolvedOtherRef.current = platformResolvedOtherIds;

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
  }, [searchSeqRef, setApps, setOnlineApps, setRecentlyViewedApps]);

  // 首绘回填：本地收录（含初始全量/搜索/目录同步）的 pending 行同样走轻量确认，
  // 首绘不闪 Other，落定后单次更新。重复调用经在途/已确认集合去重。
  useEffect(() => {
    if (apps.length === 0) return;
    lazyBackfillPlatforms(apps, searchSeqRef.current);
  }, [apps, lazyBackfillPlatforms, searchSeqRef]);

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
  }, [apps, onlineApps, recentlyViewedApps, platformResolvedOtherIds, appsRef, onlineAppsRef, recentsRef]);

  return {
    platformResolvedOtherIds,
    setPlatformResolvedOtherIds,
    platformResolvedOtherRef,
    platformBackfillInflightRef,
    lazyBackfillPlatforms,
  };
}
