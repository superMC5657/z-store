import { useEffect, useRef, useState } from 'react';
import type { AppSummary } from '../../types';
import { api } from '../../services/api';
import { applyHit, patchAppIconList } from '../../services/iconStore';
import {
  favoriteSummaryFromDetail,
  findMissingFavoriteIds,
  makeFavoritePlaceholderSummary,
  needsFavoriteIconWarm,
  pickFavoritePersistIconUrl,
} from '../favoritesUncataloged';

export interface UseFavoritesExtraParams {
  favoriteIds: Set<string>;
  watchedIds: Set<string>;
  apps: AppSummary[];
}

/**
 * 收藏/关注 left-join 占位行（C3 自 App.tsx 抽出，原 L1366-1464）。
 *
 * `(favoriteIds∪watchedIds) ∖ apps` 经 `getAppDetails`（后端
 * `get_cached_app_detail_fallback` 回退）合成占位行，未收录也能展示。
 * 归一大小写 + 双键；合成行 `is_cataloged=false/category=external`，
 * `platforms: []` 即 pending，平台三态/徽标逻辑一律不动。
 * 失败即最小占位，行必展示；收录到达即驱逐。
 */
export function useFavoritesExtra({ favoriteIds, watchedIds, apps }: UseFavoritesExtraParams) {
  // 收藏/关注未收录占位行（left-join：`(favoriteIds∪watchedIds) ∖ apps` 经详情回退合成，仅收藏页消费，
  // 不进 `apps`/计数/其它视图；`platforms: []` 即 pending 恒可见，平台三态不动）。
  const [favoriteExtraApps, setFavoriteExtraApps] = useState<AppSummary[]>([]);
  const favoriteExtraAppsRef = useRef<AppSummary[]>([]);
  favoriteExtraAppsRef.current = favoriteExtraApps;
  const favoriteExtraInflightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (favoriteIds.size === 0 && watchedIds.size === 0) {
      if (favoriteExtraAppsRef.current.length > 0) setFavoriteExtraApps([]);
      return;
    }
    const catalogLower = new Set<string>();
    for (const a of apps) {
      const k = (a.id || '').toLowerCase();
      if (k) catalogLower.add(k);
    }
    const current = favoriteExtraAppsRef.current;
    const currentLower = new Set<string>();
    for (const e of current) {
      const k = (e.id || '').toLowerCase();
      if (k) currentLower.add(k);
    }
    // 收录到达即驱逐（大小写归一），避免与目录行双显
    let pruned: AppSummary[] | null = null;
    if (current.length > 0 && catalogLower.size > 0) {
      pruned = current.filter((e) => !catalogLower.has((e.id || '').toLowerCase()));
      if (pruned.length !== current.length) setFavoriteExtraApps(pruned);
    }
    const baseLower = pruned ?? current;
    const baseLowerSet = new Set<string>();
    for (const e of baseLower) {
      const k = (e.id || '').toLowerCase();
      if (k) baseLowerSet.add(k);
    }
    // 收藏+关注 union 求缺：任一集合未收录即合成（共用同一占位 helpers/去重/inflight 口径）。
    const unionIds = new Set<string>([...favoriteIds, ...watchedIds]);
    const missing = findMissingFavoriteIds(unionIds, catalogLower, baseLowerSet).filter(
      (id) => !favoriteExtraInflightRef.current.has(id.toLowerCase()),
    );
    if (missing.length === 0) return;
    for (const id of missing) favoriteExtraInflightRef.current.add(id.toLowerCase());
    let cancelled = false;
    void (async () => {
      try {
        // 并发拉取、逐个落地：避免串行 6 倍等待；单个落盘经函数式去重，首个原值保留。
        // 图标先占位后热替（不阻塞首屏）：落盘后经 `getAppIconCycle`（前端侧
        // `resolve_confirmed_icon_from_db` 同源读 `app_icon_cycles` + 后端回填）
        // 查轮换，命中即 `setFavoriteExtraApps` 逐个热替；已有合法远端仅文件预热。
        await Promise.all(
          missing.map(async (favId) => {
            let summary: AppSummary;
            try {
              const detail = await api.getAppDetails(favId);
              summary = favoriteSummaryFromDetail(detail);
            } catch {
              summary = makeFavoritePlaceholderSummary(favId);
            }
            if (cancelled) return;
            const k = (summary.id || '').toLowerCase();
            if (!k) return;
            // 若期间收录到达则跳过（由驱逐逻辑收敛，不双显）
            if (catalogLower.has(k)) return;
            setFavoriteExtraApps((prev) => {
              const lower = k;
              for (const e of prev) {
                if ((e.id || '').toLowerCase() === lower) return prev;
              }
              return [...prev, summary];
            });
            void (async () => {
              try {
                const currentIcon = (summary.icon || '').trim();
                if (!needsFavoriteIconWarm(currentIcon)) {
                  // 详情已带合法远端：经店内唯一写口做 M1 缓冲 + 文件预热（与搜索同通道，不直调 IPC）。
                  applyHit({ key: summary.id, id: summary.id, icon: currentIcon });
                  return;
                }
                // 无可用远端：查轮换（同步读库命中即返，无则后端补探回填），命中经店内写口热替占位行。
                const cycle = await api.getAppIconCycle(favId);
                const persistUrl = pickFavoritePersistIconUrl(cycle);
                if (!persistUrl) return;
                if (cancelled) return;
                const cycleLevel = typeof cycle?.level === 'number' ? cycle.level : undefined;
                applyHit({
                  key: summary.id,
                  id: summary.id,
                  icon: persistUrl,
                  level: cycleLevel,
                  patch: (tid, icon) => {
                    setFavoriteExtraApps((prev) => patchAppIconList(prev, tid, icon));
                  },
                });
              } catch {
                // 取不到轮换图标则保持占位，不阻塞
              }
            })();
          }),
        );
      } finally {
        // 取消/完成均注销 inflight，避免泄漏导致后续 missing=0 自锁
        for (const id of missing) favoriteExtraInflightRef.current.delete(id.toLowerCase());
      }
    })();
    return () => {
      cancelled = true;
      // 同步注销本轮 inflight，保证 apps 到达后的下一轮能重算 missing
      for (const id of missing) favoriteExtraInflightRef.current.delete(id.toLowerCase());
    };
  }, [favoriteIds, watchedIds, apps]);

  return {
    favoriteExtraApps,
    setFavoriteExtraApps,
    favoriteExtraAppsRef,
  };
}
