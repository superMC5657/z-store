import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AppSummary } from '../../types';
import { annotateIsCataloged, buildCatalogIdSet, mergeLocalLookups } from '../../app/selectors';
import { normalizeId } from '../../services/normalizeId';
import { tauriApi } from '../../services/api';
import { resolveRemoteIconUrl } from '../../services/custom';
import { admitIconHit, queueAssembledRowIcons } from '../../services/iconStore';

/**
 * 后端回读的行（推荐、主流、最近浏览）不带本地收录标记，星数也可能是旧快照：
 * 按合并目录 `apps` 与本地库 `localApps` 叠加收录标记（蓝标优先）并把星数对齐目录值。
 * 不重排、不去重。`localApps` 缺席时回退目录自带的本地行，就绪后经依赖自动重标。
 */
export function useRowAnnotator(
  apps: readonly AppSummary[],
  localApps?: readonly AppSummary[],
): (row: AppSummary) => AppSummary {
  const localRows = useMemo(
    () => apps.filter((a) => (a as { source?: unknown }).source === 'local'),
    [apps],
  );
  const localLookup = useMemo(() => mergeLocalLookups(localRows, localApps), [localRows, localApps]);
  const catalogIds = useMemo(() => buildCatalogIdSet(apps as AppSummary[]), [apps]);
  const starsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of apps) {
      const k = normalizeId(a.id);
      if (k && !m.has(k)) m.set(k, a.stars);
    }
    return m;
  }, [apps]);
  return useCallback(
    (r: AppSummary): AppSummary => {
      let next = annotateIsCataloged(r, catalogIds, localLookup);
      const k = normalizeId(r.id);
      const wantStars = k ? starsById.get(k) : undefined;
      if (typeof wantStars === 'number' && next.stars !== wantStars) {
        next = { ...next, stars: wantStars };
      }
      return next;
    },
    [catalogIds, localLookup, starsById],
  );
}

/**
 * 列表图标补齐：空图标行逐个按需拉取一次（去重，单行失败不阻塞），
 * http 远端图标入队落盘（`data:`/空跳过，店内去重）。
 */
export function useRowIconBackfill(rows: readonly AppSummary[]): void {
  const fetchedRef = useRef<Set<string>>(new Set<string>());
  useEffect(() => {
    for (const row of rows) {
      const icon = typeof row.icon === 'string' ? row.icon.trim() : '';
      if (icon !== '') continue;
      const key = normalizeId(row.id);
      if (!key || fetchedRef.current.has(key)) continue;
      fetchedRef.current.add(key);
      void (async () => {
        try {
          const cycle = await tauriApi.restoreOrFetchIconCycle(row.id);
          const remote = resolveRemoteIconUrl(cycle);
          const fallback = typeof cycle?.url === 'string' ? cycle.url.trim() : '';
          const persistUrl =
            remote !== '' ? remote : !fallback.startsWith('data:') && fallback !== '' ? fallback : '';
          if (persistUrl === '' || (!persistUrl.startsWith('http://') && !persistUrl.startsWith('https://'))) return;
          try {
            admitIconHit({ id: row.id, icon: persistUrl });
          } catch {
            // 店内写口失败不阻塞
          }
        } catch {
          // 单行失败不阻塞其余（下次渲染不重试，由详情进入时再治愈）
        }
      })();
    }
    if (rows.length > 0) queueAssembledRowIcons(rows as AppSummary[]);
  }, [rows]);
}
